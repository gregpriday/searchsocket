import { describe, expect, it } from "vitest";
import { rankHits, findPageWeight } from "../src/search/ranking";
import { createDefaultConfig } from "../src/config/defaults";
import type { PageHit, VectorHit } from "../src/types";
import type { RankedHit } from "../src/search/ranking";

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

describe("rankHits", () => {
  const config = createDefaultConfig("test");

  it("sorts by score descending", () => {
    const hits = [
      makeHit({ score: 0.5, url: "/a" }),
      makeHit({ score: 0.9, url: "/b" }),
      makeHit({ score: 0.7, url: "/c" })
    ];

    const ranked = rankHits(hits, config);
    expect(ranked[0]?.hit.metadata.url).toBe("/b");
    expect(ranked[1]?.hit.metadata.url).toBe("/c");
    expect(ranked[2]?.hit.metadata.url).toBe("/a");
  });

  it("boosts pages with incoming links", () => {
    const hits = [
      makeHit({ score: 0.8, url: "/popular", incomingLinks: 20 }),
      makeHit({ score: 0.81, url: "/unpopular", incomingLinks: 0 })
    ];

    const ranked = rankHits(hits, config);
    // The popular page should get boosted above the slightly-higher-scored unpopular page
    expect(ranked[0]?.hit.metadata.url).toBe("/popular");
  });

  it("boosts shallow pages", () => {
    const hits = [
      makeHit({ score: 0.8, url: "/shallow", depth: 1 }),
      makeHit({ score: 0.8, url: "/deep", depth: 5 })
    ];

    const ranked = rankHits(hits, config);
    expect(ranked[0]?.hit.metadata.url).toBe("/shallow");
  });

  it("respects disabled boosts", () => {
    const noBoostConfig = createDefaultConfig("test");
    noBoostConfig.ranking.enableIncomingLinkBoost = false;
    noBoostConfig.ranking.enableDepthBoost = false;

    const hits = [
      makeHit({ score: 0.5, url: "/a", incomingLinks: 100, depth: 0 }),
      makeHit({ score: 0.9, url: "/b", incomingLinks: 0, depth: 10 })
    ];

    const ranked = rankHits(hits, noBoostConfig);
    expect(ranked[0]?.hit.metadata.url).toBe("/b");
  });

  it("demotes non-finite base scores instead of polluting ordering", () => {
    const hits = [
      makeHit({ score: Number.NaN, url: "/nan" }),
      makeHit({ score: 0.6, url: "/finite" })
    ];

    const ranked = rankHits(hits, config);
    expect(ranked[0]?.hit.metadata.url).toBe("/finite");
    expect(Number.isFinite(ranked[0]?.finalScore ?? Number.NaN)).toBe(true);
  });

  it("keeps final scores finite when metadata boost fields are invalid", () => {
    const hits = [
      makeHit({ score: 0.7, url: "/bad-meta-a", incomingLinks: Number.NaN, depth: Number.NaN }),
      makeHit({ score: 0.7, url: "/bad-meta-b", incomingLinks: Number.POSITIVE_INFINITY, depth: -10 })
    ];

    const ranked = rankHits(hits, config);
    expect(ranked.length).toBe(2);
    for (const entry of ranked) {
      expect(Number.isFinite(entry.finalScore)).toBe(true);
    }
  });

  it("never emits NaN scores across randomized adversarial numeric inputs", () => {
    const pick = (values: number[], i: number): number => values[i % values.length]!;
    const weird = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -10, 0, 0.25, 1.5];

    for (let i = 0; i < 80; i += 1) {
      const hits = [
        makeHit({
          score: pick(weird, i),
          url: `/a-${i}`,
          incomingLinks: pick(weird, i + 1),
          depth: pick(weird, i + 2)
        }),
        makeHit({
          score: pick(weird, i + 3),
          url: `/b-${i}`,
          incomingLinks: pick(weird, i + 4),
          depth: pick(weird, i + 5)
        })
      ];

      const ranked = rankHits(hits, config);
      expect(ranked.length).toBe(2);
      expect(Number.isNaN(ranked[0]?.finalScore ?? Number.NaN)).toBe(false);
      expect(Number.isNaN(ranked[1]?.finalScore ?? Number.NaN)).toBe(false);
    }
  });
});

function makeRankedHit(url: string, finalScore: number, overrides?: Partial<VectorHit["metadata"]>): RankedHit {
  return {
    hit: {
      id: `${url}-${finalScore}`,
      score: finalScore,
      metadata: {
        projectId: "test",
        scopeName: "main",
        url,
        path: url,
        title: overrides?.title ?? "Test Page",
        sectionTitle: overrides?.sectionTitle ?? "",
        headingPath: overrides?.headingPath ?? [],
        snippet: overrides?.snippet ?? "snippet",
        chunkText: "full chunk text",
        ordinal: 0,
        contentHash: "hash",
        depth: 1,
        incomingLinks: 0,
        routeFile: overrides?.routeFile ?? "src/routes/+page.svelte",
        tags: [],
        ...overrides
      }
    },
    finalScore
  };
}


describe("findPageWeight", () => {
  it("returns exact match weight", () => {
    expect(findPageWeight("/docs", { "/docs": 1.5 })).toBe(1.5);
  });

  it("exact pattern does NOT match subpaths", () => {
    expect(findPageWeight("/docs/api/auth", { "/docs": 1.5 })).toBe(1);
  });

  it("single-level wildcard matches direct children", () => {
    expect(findPageWeight("/docs/intro", { "/docs/*": 1.5 })).toBe(1.5);
  });

  it("single-level wildcard does NOT match deeper paths", () => {
    expect(findPageWeight("/docs/api/auth", { "/docs/*": 1.5 })).toBe(1);
  });

  it("single-level wildcard does NOT match the parent itself", () => {
    expect(findPageWeight("/docs", { "/docs/*": 1.5 })).toBe(1);
  });

  it("globstar matches any depth", () => {
    expect(findPageWeight("/docs/api/auth", { "/docs/**": 1.5 })).toBe(1.5);
    expect(findPageWeight("/docs/intro", { "/docs/**": 1.5 })).toBe(1.5);
  });

  it("globstar matches the parent itself", () => {
    expect(findPageWeight("/docs", { "/docs/**": 1.5 })).toBe(1.5);
  });

  it("prefers longest (most specific) pattern match", () => {
    const weights = { "/docs/**": 1.2, "/docs/api/**": 1.5 };
    expect(findPageWeight("/docs/api/auth", weights)).toBe(1.5);
  });

  it("returns 1 when no match found", () => {
    expect(findPageWeight("/other", { "/docs": 1.5 })).toBe(1);
  });

  it("returns 1 for empty weights", () => {
    expect(findPageWeight("/any", {})).toBe(1);
  });

  it("normalizes trailing slashes for exact match", () => {
    expect(findPageWeight("/docs", { "/docs/": 1.5 })).toBe(1.5);
    expect(findPageWeight("/docs/", { "/docs": 1.5 })).toBe(1.5);
  });

  it("root '/' is exact-only, not a global prefix", () => {
    expect(findPageWeight("/", { "/": 2.0 })).toBe(2.0);
    expect(findPageWeight("/about", { "/": 2.0 })).toBe(1);
  });
});

describe("title-match boost", () => {
  it("boosts hits whose title matches the query", () => {
    const config = createDefaultConfig("test");
    const hits = [
      makeHit({ score: 0.7, url: "/recipes", title: "Recipes" }),
      makeHit({ score: 0.75, url: "/about", title: "About Us" })
    ];

    const ranked = rankHits(hits, config, "recipes");
    // /recipes should be boosted above /about despite lower base score
    expect(ranked[0]?.hit.metadata.url).toBe("/recipes");
  });

  it("matches when query is substring of title", () => {
    const config = createDefaultConfig("test");
    const hits = [
      makeHit({ score: 0.7, url: "/getting-started", title: "Getting Started Guide" }),
      makeHit({ score: 0.75, url: "/faq", title: "FAQ" })
    ];

    const ranked = rankHits(hits, config, "getting started");
    expect(ranked[0]?.hit.metadata.url).toBe("/getting-started");
  });

  it("matches when title is substring of query", () => {
    const config = createDefaultConfig("test");
    const hits = [
      makeHit({ score: 0.7, url: "/faq", title: "FAQ" }),
      makeHit({ score: 0.75, url: "/about", title: "About Us" })
    ];

    const ranked = rankHits(hits, config, "faq page");
    expect(ranked[0]?.hit.metadata.url).toBe("/faq");
  });

  it("ignores case and punctuation in title matching", () => {
    const config = createDefaultConfig("test");
    const hits = [
      makeHit({ score: 0.7, url: "/api-ref", title: "API Reference!" }),
      makeHit({ score: 0.75, url: "/other", title: "Other Page" })
    ];

    const ranked = rankHits(hits, config, "api reference");
    expect(ranked[0]?.hit.metadata.url).toBe("/api-ref");
  });

  it("does not boost when query does not match title", () => {
    const config = createDefaultConfig("test");
    const hits = [
      makeHit({ score: 0.7, url: "/recipes", title: "Recipes" }),
      makeHit({ score: 0.75, url: "/about", title: "About Us" })
    ];

    const ranked = rankHits(hits, config, "deployment guide");
    // No title match, so /about stays on top with higher base score
    expect(ranked[0]?.hit.metadata.url).toBe("/about");
  });

  it("does not apply boost when no query is provided", () => {
    const config = createDefaultConfig("test");
    const hits = [
      makeHit({ score: 0.7, url: "/recipes", title: "Recipes" }),
      makeHit({ score: 0.75, url: "/about", title: "About Us" })
    ];

    const ranked = rankHits(hits, config);
    expect(ranked[0]?.hit.metadata.url).toBe("/about");
  });
});

describe("anchor-text-match boost", () => {
  it("does not apply boost when enableAnchorTextBoost is false (default)", () => {
    const config = createDefaultConfig("test");
    const hits = [
      makeHit({ score: 0.7, url: "/install", incomingAnchorText: "installation guide" }),
      makeHit({ score: 0.75, url: "/about", title: "About Us" })
    ];

    const ranked = rankHits(hits, config, "installation guide");
    // Default has enableAnchorTextBoost: false, so /about wins with higher base score
    expect(ranked[0]?.hit.metadata.url).toBe("/about");
  });

  it("boosts hits when anchor text matches query and feature is enabled", () => {
    const config = createDefaultConfig("test");
    config.ranking.enableAnchorTextBoost = true;
    const hits = [
      makeHit({ score: 0.7, url: "/install", incomingAnchorText: "installation guide" }),
      makeHit({ score: 0.75, url: "/about", title: "About Us" })
    ];

    const ranked = rankHits(hits, config, "installation guide");
    expect(ranked[0]?.hit.metadata.url).toBe("/install");
  });

  it("normalizes case and punctuation for anchor text matching", () => {
    const config = createDefaultConfig("test");
    config.ranking.enableAnchorTextBoost = true;
    const hits = [
      makeHit({ score: 0.7, url: "/install", incomingAnchorText: "Installation Guide!" }),
      makeHit({ score: 0.75, url: "/about" })
    ];

    const ranked = rankHits(hits, config, "installation guide");
    expect(ranked[0]?.hit.metadata.url).toBe("/install");
  });

  it("does not crash with undefined incomingAnchorText", () => {
    const config = createDefaultConfig("test");
    config.ranking.enableAnchorTextBoost = true;
    const hits = [
      makeHit({ score: 0.7, url: "/no-anchor" }),
      makeHit({ score: 0.6, url: "/also-none" })
    ];

    const ranked = rankHits(hits, config, "test query");
    expect(ranked.length).toBe(2);
    expect(Number.isFinite(ranked[0]?.finalScore)).toBe(true);
  });

  it("matches when query is substring of anchor text", () => {
    const config = createDefaultConfig("test");
    config.ranking.enableAnchorTextBoost = true;
    const hits = [
      makeHit({ score: 0.7, url: "/install", incomingAnchorText: "complete installation guide for beginners" }),
      makeHit({ score: 0.75, url: "/other" })
    ];

    const ranked = rankHits(hits, config, "installation guide");
    expect(ranked[0]?.hit.metadata.url).toBe("/install");
  });

  it("matches when anchor text is substring of query", () => {
    const config = createDefaultConfig("test");
    config.ranking.enableAnchorTextBoost = true;
    const hits = [
      makeHit({ score: 0.7, url: "/install", incomingAnchorText: "install" }),
      makeHit({ score: 0.75, url: "/other" })
    ];

    const ranked = rankHits(hits, config, "how to install packages");
    expect(ranked[0]?.hit.metadata.url).toBe("/install");
  });
});


function makePageHit(url: string, score: number, overrides?: Partial<PageHit>): PageHit {
  return {
    id: url,
    score,
    title: overrides?.title ?? "Page",
    url,
    description: overrides?.description ?? "",
    tags: overrides?.tags ?? [],
    depth: overrides?.depth ?? 1,
    incomingLinks: overrides?.incomingLinks ?? 0,
    routeFile: overrides?.routeFile ?? "src/routes/+page.svelte"
  };
}

