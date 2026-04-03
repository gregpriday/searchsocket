import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultConfig } from "../src/config/defaults";
import { extractFromHtml, extractFromMarkdown, normalizeDateToMs, extractPublishedAtFromFrontmatter } from "../src/indexing/extractor";
import { rankHits, mergePageAndChunkResults } from "../src/search/ranking";
import type { PageHit, VectorHit } from "../src/types";

const config = createDefaultConfig("test");

function makeHit(overrides: Partial<VectorHit["metadata"]> & { score: number }): VectorHit {
  const { score, ...meta } = overrides;
  return {
    id: meta.url ?? "test",
    score,
    metadata: {
      projectId: "test",
      scopeName: "main",
      url: "/test",
      path: "/test",
      title: "Test",
      sectionTitle: "",
      headingPath: [],
      snippet: "snippet",
      chunkText: "full chunk text",
      ordinal: 0,
      contentHash: "hash",
      depth: 1,
      incomingLinks: 0,
      routeFile: "src/routes/+page.svelte",
      tags: [],
      ...meta
    }
  };
}

// --- Date normalization ---

describe("normalizeDateToMs", () => {
  it("handles Date objects", () => {
    const d = new Date("2024-06-15T00:00:00Z");
    expect(normalizeDateToMs(d)).toBe(d.getTime());
  });

  it("handles ISO date strings", () => {
    const result = normalizeDateToMs("2024-06-15T00:00:00Z");
    expect(result).toBe(new Date("2024-06-15T00:00:00Z").getTime());
  });

  it("handles bare date strings", () => {
    const result = normalizeDateToMs("2024-06-15");
    expect(typeof result).toBe("number");
    expect(Number.isFinite(result)).toBe(true);
  });

  it("returns undefined for invalid strings", () => {
    expect(normalizeDateToMs("not-a-date")).toBeUndefined();
  });

  it("returns undefined for null/undefined", () => {
    expect(normalizeDateToMs(null)).toBeUndefined();
    expect(normalizeDateToMs(undefined)).toBeUndefined();
  });

  it("returns undefined for NaN", () => {
    expect(normalizeDateToMs(NaN)).toBeUndefined();
  });

  it("handles numeric timestamps", () => {
    const ts = Date.now();
    expect(normalizeDateToMs(ts)).toBe(ts);
  });

  it("returns undefined for Infinity", () => {
    expect(normalizeDateToMs(Infinity)).toBeUndefined();
  });

  it("returns undefined for invalid Date", () => {
    expect(normalizeDateToMs(new Date("invalid"))).toBeUndefined();
  });
});

describe("extractPublishedAtFromFrontmatter", () => {
  it("prefers 'date' over other fields", () => {
    const data = {
      date: "2024-01-01",
      publishedAt: "2023-06-01",
      updatedAt: "2024-06-01"
    };
    const result = extractPublishedAtFromFrontmatter(data);
    expect(result).toBe(new Date("2024-01-01").getTime());
  });

  it("falls back to publishedAt", () => {
    const data = { publishedAt: "2023-06-15" };
    const result = extractPublishedAtFromFrontmatter(data);
    expect(result).toBe(new Date("2023-06-15").getTime());
  });

  it("falls back to updatedAt", () => {
    const data = { updatedAt: "2024-03-01" };
    const result = extractPublishedAtFromFrontmatter(data);
    expect(result).toBe(new Date("2024-03-01").getTime());
  });

  it("handles Date objects from gray-matter (unquoted YAML dates)", () => {
    const data = { date: new Date("2024-01-15T00:00:00Z") };
    const result = extractPublishedAtFromFrontmatter(data);
    expect(result).toBe(new Date("2024-01-15T00:00:00Z").getTime());
  });

  it("returns undefined when no date fields present", () => {
    const data = { title: "Hello", tags: ["blog"] };
    expect(extractPublishedAtFromFrontmatter(data)).toBeUndefined();
  });
});

// --- Extractor integration ---

describe("extractFromMarkdown freshness", () => {
  it("extracts publishedAt from frontmatter date field", () => {
    const md = `---
title: Blog Post
date: 2024-06-15
---

# Blog Post

Content here.`;
    const result = extractFromMarkdown("/blog/post", md);
    expect(result).not.toBeNull();
    expect(typeof result!.publishedAt).toBe("number");
    expect(Number.isFinite(result!.publishedAt)).toBe(true);
  });

  it("returns undefined publishedAt when no date in frontmatter", () => {
    const md = `---
title: No Date
---

# No Date

Content here.`;
    const result = extractFromMarkdown("/blog/no-date", md);
    expect(result).not.toBeNull();
    expect(result!.publishedAt).toBeUndefined();
  });
});

describe("extractFromHtml freshness", () => {
  it("extracts publishedAt from JSON-LD datePublished", () => {
    const html = `
      <html>
        <head>
          <script type="application/ld+json">
            {"@type": "Article", "datePublished": "2024-03-15T10:00:00Z"}
          </script>
        </head>
        <body><main><p>Content</p></main></body>
      </html>`;
    const result = extractFromHtml("/article", html, config);
    expect(result).not.toBeNull();
    expect(result!.publishedAt).toBe(new Date("2024-03-15T10:00:00Z").getTime());
  });

  it("falls back to article:published_time when JSON-LD is absent", () => {
    const html = `
      <html>
        <head>
          <meta property="article:published_time" content="2024-05-20T08:00:00Z" />
        </head>
        <body><main><p>Content</p></main></body>
      </html>`;
    const result = extractFromHtml("/article2", html, config);
    expect(result).not.toBeNull();
    expect(result!.publishedAt).toBe(new Date("2024-05-20T08:00:00Z").getTime());
  });

  it("falls back to <time datetime> as last resort", () => {
    const html = `
      <html>
        <head></head>
        <body>
          <main>
            <time datetime="2024-01-10">Jan 10, 2024</time>
            <p>Content</p>
          </main>
        </body>
      </html>`;
    const result = extractFromHtml("/article3", html, config);
    expect(result).not.toBeNull();
    expect(result!.publishedAt).toBe(new Date("2024-01-10").getTime());
  });

  it("handles malformed JSON-LD gracefully", () => {
    const html = `
      <html>
        <head>
          <script type="application/ld+json">{ broken json }</script>
          <meta property="article:published_time" content="2024-02-01T00:00:00Z" />
        </head>
        <body><main><p>Content</p></main></body>
      </html>`;
    const result = extractFromHtml("/article4", html, config);
    expect(result).not.toBeNull();
    expect(result!.publishedAt).toBe(new Date("2024-02-01T00:00:00Z").getTime());
  });

  it("returns undefined publishedAt when no date signals in HTML", () => {
    const html = `
      <html>
        <head></head>
        <body><main><p>No date anywhere</p></main></body>
      </html>`;
    const result = extractFromHtml("/no-date", html, config);
    expect(result).not.toBeNull();
    expect(result!.publishedAt).toBeUndefined();
  });
});

// --- Ranking freshness boost ---

describe("freshness boost in rankHits", () => {
  const NOW = new Date("2026-04-03T12:00:00Z").getTime();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("newer page ranks above older page when boost is enabled", () => {
    const freshConfig = createDefaultConfig("test");
    freshConfig.ranking.enableFreshnessBoost = true;

    const thirtyDaysAgo = NOW - 30 * 86_400_000;
    const threeYearsAgo = NOW - 3 * 365 * 86_400_000;

    const hits = [
      makeHit({ score: 0.8, url: "/old", publishedAt: threeYearsAgo }),
      makeHit({ score: 0.8, url: "/new", publishedAt: thirtyDaysAgo })
    ];

    const ranked = rankHits(hits, freshConfig);
    expect(ranked[0]?.hit.metadata.url).toBe("/new");
    expect(ranked[1]?.hit.metadata.url).toBe("/old");
  });

  it("does not apply boost when feature is disabled (default)", () => {
    const thirtyDaysAgo = NOW - 30 * 86_400_000;
    const threeYearsAgo = NOW - 3 * 365 * 86_400_000;

    const hits = [
      makeHit({ score: 0.8, url: "/old", publishedAt: threeYearsAgo }),
      makeHit({ score: 0.8, url: "/new", publishedAt: thirtyDaysAgo })
    ];

    const ranked = rankHits(hits, config);
    // Both should have same score — order doesn't change
    expect(ranked[0]?.finalScore).toBe(ranked[1]?.finalScore);
  });

  it("handles missing publishedAt gracefully (no boost, no error)", () => {
    const freshConfig = createDefaultConfig("test");
    freshConfig.ranking.enableFreshnessBoost = true;

    const hits = [
      makeHit({ score: 0.8, url: "/no-date" }),
      makeHit({ score: 0.7, url: "/has-date", publishedAt: NOW - 30 * 86_400_000 })
    ];

    const ranked = rankHits(hits, freshConfig);
    expect(ranked.length).toBe(2);
    // /no-date has higher base score and no freshness boost, but /has-date gets freshness boost
    // Both should be finite
    for (const r of ranked) {
      expect(Number.isFinite(r.finalScore)).toBe(true);
    }
  });

  it("clamps future dates — boost equals max (1 * weight)", () => {
    const freshConfig = createDefaultConfig("test");
    freshConfig.ranking.enableFreshnessBoost = true;

    const futureDate = NOW + 365 * 86_400_000;
    const hits = [makeHit({ score: 0.8, url: "/future", publishedAt: futureDate })];

    const ranked = rankHits(hits, freshConfig, undefined, true);
    // Future date: daysSince clamped to 0, decay = 1/(1+0) = 1, boost = 1 * weight
    expect(ranked[0]?.breakdown?.freshnessBoost).toBeCloseTo(freshConfig.ranking.weights.freshness, 5);
  });

  it("publishedAt=0 (epoch) gets near-zero boost", () => {
    const freshConfig = createDefaultConfig("test");
    freshConfig.ranking.enableFreshnessBoost = true;

    const hits = [makeHit({ score: 0.8, url: "/epoch", publishedAt: 0 })];
    const ranked = rankHits(hits, freshConfig, undefined, true);
    // ~20,000 days since epoch, boost should be very small
    expect(ranked[0]?.breakdown?.freshnessBoost).toBeLessThan(0.01);
  });

  it("NaN publishedAt is treated as missing", () => {
    const freshConfig = createDefaultConfig("test");
    freshConfig.ranking.enableFreshnessBoost = true;

    const hits = [makeHit({ score: 0.8, url: "/nan", publishedAt: NaN })];
    const ranked = rankHits(hits, freshConfig, undefined, true);
    expect(ranked[0]?.breakdown?.freshnessBoost).toBe(0);
  });

  it("debug breakdown includes freshnessBoost field", () => {
    const freshConfig = createDefaultConfig("test");
    freshConfig.ranking.enableFreshnessBoost = true;

    const hits = [makeHit({ score: 0.8, url: "/test", publishedAt: NOW - 100 * 86_400_000 })];
    const ranked = rankHits(hits, freshConfig, undefined, true);
    expect(ranked[0]?.breakdown).toBeDefined();
    expect(typeof ranked[0]?.breakdown?.freshnessBoost).toBe("number");
    expect(ranked[0]?.breakdown?.freshnessBoost).toBeGreaterThan(0);
  });

  it("freshnessBoost is 0 in breakdown when feature is disabled", () => {
    const hits = [makeHit({ score: 0.8, url: "/test", publishedAt: NOW - 100 * 86_400_000 })];
    const ranked = rankHits(hits, config, undefined, true);
    expect(ranked[0]?.breakdown?.freshnessBoost).toBe(0);
  });
});

// --- Synthetic page hits carry publishedAt ---

describe("mergePageAndChunkResults publishedAt", () => {
  it("synthetic VectorHit carries publishedAt from PageHit", () => {
    const freshConfig = createDefaultConfig("test");
    const publishedAt = Date.now() - 30 * 86_400_000;

    const pageHits: PageHit[] = [{
      id: "/page-only",
      score: 0.9,
      title: "Page Only",
      url: "/page-only",
      description: "desc",
      tags: [],
      depth: 1,
      incomingLinks: 0,
      routeFile: "src/routes/+page.svelte",
      publishedAt
    }];

    const merged = mergePageAndChunkResults(pageHits, [], freshConfig);
    expect(merged.length).toBe(1);
    expect(merged[0]?.hit.metadata.publishedAt).toBe(publishedAt);
  });
});
