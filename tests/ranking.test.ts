import { describe, expect, it } from "vitest";
import { rankHits } from "../src/search/ranking";
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
      contentHash: "hash",
      modelId: "text-embedding-3-small",
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
