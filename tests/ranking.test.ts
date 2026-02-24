import { describe, expect, it } from "vitest";
import { rankHits, aggregateByPage, findPageWeight } from "../src/search/ranking";
import type { RankedHit } from "../src/search/ranking";
import { createDefaultConfig } from "../src/config/defaults";
import type { VectorHit } from "../src/types";

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
      modelId: "jina-embeddings-v3",
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
        modelId: "jina-embeddings-v3",
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

describe("aggregateByPage", () => {
  const config = createDefaultConfig("test");

  it("groups multiple chunks from the same URL into one page result", () => {
    const ranked: RankedHit[] = [
      makeRankedHit("/home", 0.9, { sectionTitle: "Intro" }),
      makeRankedHit("/home", 0.7, { sectionTitle: "Features" }),
      makeRankedHit("/home", 0.6, { sectionTitle: "About" }),
      makeRankedHit("/about", 0.85, { sectionTitle: "Team" })
    ];

    const pages = aggregateByPage(ranked, config);
    expect(pages.length).toBe(2);

    const homeResult = pages.find((p) => p.url === "/home");
    expect(homeResult).toBeDefined();
    expect(homeResult!.matchingChunks.length).toBe(3);
    expect(homeResult!.bestChunk.finalScore).toBe(0.9);
  });

  it("page with several relevant matches outranks page with one strong match", () => {
    const ranked: RankedHit[] = [
      makeRankedHit("/focused", 0.92),
      // Homepage with 5 solid chunks — score-weighted decay still gives a boost
      makeRankedHit("/home", 0.88),
      makeRankedHit("/home", 0.85),
      makeRankedHit("/home", 0.83),
      makeRankedHit("/home", 0.80),
      makeRankedHit("/home", 0.78)
    ];

    const pages = aggregateByPage(ranked, config);
    expect(pages[0]!.url).toBe("/home");
    expect(pages[1]!.url).toBe("/focused");
  });

  it("caps aggregation so chunk-heavy pages do not dominate", () => {
    // A page with 5 chunks and a page with 20 chunks at same scores
    // should get very similar aggregation bonuses due to the cap
    const fiveChunks: RankedHit[] = Array.from({ length: 5 }, (_, i) =>
      makeRankedHit("/five", 0.8 - i * 0.02)
    );
    const twentyChunks: RankedHit[] = Array.from({ length: 20 }, (_, i) =>
      makeRankedHit("/twenty", 0.8 - i * 0.02)
    );

    const pagesFromFive = aggregateByPage(fiveChunks, config);
    const pagesFromTwenty = aggregateByPage(twentyChunks, config);

    // With cap=5, both should have the same page score since
    // only the top 5 chunks contribute to aggregation
    expect(pagesFromFive[0]!.pageScore).toBeCloseTo(pagesFromTwenty[0]!.pageScore, 6);
  });

  it("page weights multiply the score correctly", () => {
    const weightedConfig = createDefaultConfig("test");
    weightedConfig.ranking.pageWeights = { "/boosted": 2.0 };

    const ranked: RankedHit[] = [
      makeRankedHit("/normal", 0.9),
      makeRankedHit("/boosted", 0.7)
    ];

    const pages = aggregateByPage(ranked, weightedConfig);
    // /boosted should win due to 2x page weight
    expect(pages[0]!.url).toBe("/boosted");
  });

  it("returns best chunk metadata as the page representative", () => {
    const ranked: RankedHit[] = [
      makeRankedHit("/docs", 0.5, { sectionTitle: "Low Section", title: "Docs" }),
      makeRankedHit("/docs", 0.9, { sectionTitle: "Best Section", title: "Docs" }),
      makeRankedHit("/docs", 0.7, { sectionTitle: "Mid Section", title: "Docs" })
    ];

    const pages = aggregateByPage(ranked, config);
    expect(pages[0]!.bestChunk.hit.metadata.sectionTitle).toBe("Best Section");
    expect(pages[0]!.bestChunk.finalScore).toBe(0.9);
  });

  it("single-chunk pages get zero aggregation bonus", () => {
    const ranked: RankedHit[] = [
      makeRankedHit("/a", 0.9),
      makeRankedHit("/b", 0.8)
    ];

    const pages = aggregateByPage(ranked, config);
    expect(pages[0]!.url).toBe("/a");
    expect(pages[1]!.url).toBe("/b");
    expect(pages[0]!.matchingChunks.length).toBe(1);
    expect(pages[1]!.matchingChunks.length).toBe(1);
    // No additional chunks means zero aggregation bonus
    expect(pages[0]!.pageScore).toBe(0.9);
    expect(pages[1]!.pageScore).toBe(0.8);
  });

  it("sorts matching chunks within a page by score descending", () => {
    const ranked: RankedHit[] = [
      makeRankedHit("/page", 0.5),
      makeRankedHit("/page", 0.9),
      makeRankedHit("/page", 0.7)
    ];

    const pages = aggregateByPage(ranked, config);
    const chunks = pages[0]!.matchingChunks;
    expect(chunks[0]!.finalScore).toBe(0.9);
    expect(chunks[1]!.finalScore).toBe(0.7);
    expect(chunks[2]!.finalScore).toBe(0.5);
  });

  it("handles non-finite finalScore inputs without NaN page scores", () => {
    const ranked: RankedHit[] = [
      makeRankedHit("/a", Number.NaN),
      makeRankedHit("/a", 0.5),
      makeRankedHit("/b", Number.NEGATIVE_INFINITY)
    ];

    const pages = aggregateByPage(ranked, config);
    for (const page of pages) {
      expect(Number.isNaN(page.pageScore)).toBe(false);
    }
  });
});

describe("findPageWeight", () => {
  it("returns exact match weight", () => {
    expect(findPageWeight("/docs", { "/docs": 1.5 })).toBe(1.5);
  });

  it("returns prefix match weight", () => {
    expect(findPageWeight("/docs/api/auth", { "/docs": 1.5 })).toBe(1.5);
  });

  it("prefers longest prefix match", () => {
    const weights = { "/docs": 1.2, "/docs/api": 1.5 };
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
