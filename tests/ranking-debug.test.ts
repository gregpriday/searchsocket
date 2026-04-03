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

describe("rankHits debug mode", () => {
  const config = createDefaultConfig("test");

  it("includes breakdown when debug is true", () => {
    const hits = [makeHit({ score: 0.8, url: "/a", incomingLinks: 5, depth: 2 })];
    const ranked = rankHits(hits, config, "test query", true);

    expect(ranked[0]!.breakdown).toBeDefined();
    expect(ranked[0]!.breakdown!.baseScore).toBe(0.8);
    expect(typeof ranked[0]!.breakdown!.incomingLinkBoost).toBe("number");
    expect(typeof ranked[0]!.breakdown!.depthBoost).toBe("number");
    expect(typeof ranked[0]!.breakdown!.titleMatchBoost).toBe("number");
    expect(typeof ranked[0]!.breakdown!.anchorTextMatchBoost).toBe("number");
  });

  it("does not include breakdown when debug is false", () => {
    const hits = [makeHit({ score: 0.8, url: "/a" })];
    const ranked = rankHits(hits, config, "query", false);
    expect(ranked[0]!.breakdown).toBeUndefined();
  });

  it("does not include breakdown when debug is omitted", () => {
    const hits = [makeHit({ score: 0.8, url: "/a" })];
    const ranked = rankHits(hits, config, "query");
    expect(ranked[0]!.breakdown).toBeUndefined();
  });

  it("breakdown components sum to finalScore", () => {
    const hits = [makeHit({ score: 0.7, url: "/a", incomingLinks: 10, depth: 3, title: "Test Query" })];
    const ranked = rankHits(hits, config, "test query", true);
    const b = ranked[0]!.breakdown!;
    const sum = b.baseScore + b.incomingLinkBoost + b.depthBoost + b.titleMatchBoost + b.anchorTextMatchBoost;
    expect(ranked[0]!.finalScore).toBeCloseTo(sum, 10);
  });

  it("shows title match boost when query matches title", () => {
    const hits = [makeHit({ score: 0.7, url: "/recipes", title: "Recipes" })];
    const ranked = rankHits(hits, config, "recipes", true);
    expect(ranked[0]!.breakdown!.titleMatchBoost).toBeGreaterThan(0);
  });

  it("shows zero title match boost when no match", () => {
    const hits = [makeHit({ score: 0.7, url: "/about", title: "About" })];
    const ranked = rankHits(hits, config, "recipes", true);
    expect(ranked[0]!.breakdown!.titleMatchBoost).toBe(0);
  });

  it("shows anchor text match boost when enabled and matching", () => {
    const anchorConfig = createDefaultConfig("test");
    anchorConfig.ranking.enableAnchorTextBoost = true;
    const hits = [makeHit({ score: 0.7, url: "/install", incomingAnchorText: "installation guide" })];
    const ranked = rankHits(hits, anchorConfig, "installation guide", true);
    expect(ranked[0]!.breakdown!.anchorTextMatchBoost).toBeGreaterThan(0);
  });

  it("shows zero anchor text boost when disabled", () => {
    const hits = [makeHit({ score: 0.7, url: "/install", incomingAnchorText: "installation guide" })];
    const ranked = rankHits(hits, config, "installation guide", true);
    expect(ranked[0]!.breakdown!.anchorTextMatchBoost).toBe(0);
  });
});
