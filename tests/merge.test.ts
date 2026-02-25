import { describe, expect, it } from "vitest";
import { mergeSearchResults } from "../src/merge";
import type { SearchResponse } from "../src/types";

function makeResponse(urls: string[], scores?: number[]): SearchResponse {
  return {
    q: "test",
    scope: "main",
    results: urls.map((url, i) => ({
      url,
      title: `Page ${url}`,
      snippet: `Snippet for ${url}`,
      score: scores?.[i] ?? 1 - i * 0.1,
      routeFile: `src/routes${url}/+page.svelte`
    })),
    meta: {
      timingsMs: { embed: 10, vector: 20, rerank: 50, total: 80 },
      usedRerank: true,
      modelId: "jina-embeddings-v3"
    }
  };
}

describe("mergeSearchResults", () => {
  it("keeps initial order when all displacements are within threshold", () => {
    const initial = makeResponse(["/a", "/b", "/c", "/d"], [0.9, 0.8, 0.7, 0.6]);
    // Only swap adjacent: /b and /c swap (displacement = 1 each) — within default maxDisplacement of 3
    const reranked = makeResponse(["/a", "/c", "/b", "/d"], [0.95, 0.85, 0.75, 0.65]);

    const result = mergeSearchResults(initial, reranked);

    expect(result.usedRerankedOrder).toBe(false);
    expect(result.response.results.map((r) => r.url)).toEqual(["/a", "/b", "/c", "/d"]);
    // Uses reranked scores
    expect(result.response.results[0]!.score).toBe(0.95);
    expect(result.response.results[1]!.score).toBe(0.75); // /b's reranked score
    expect(result.response.results[2]!.score).toBe(0.85); // /c's reranked score
  });

  it("adopts reranked order when any result moves more than maxDisplacement", () => {
    // Real-world scenario from feedback: #1 and #8 swap — displacement of 7
    const initial = makeResponse(
      ["/canopy-assistant", "/install", "/home", "/layout", "/projects", "/download", "/troubleshoot", "/introducing-canopy"],
      [0.65, 0.64, 0.63, 0.62, 0.61, 0.60, 0.59, 0.58]
    );
    const reranked = makeResponse(
      ["/introducing-canopy", "/install", "/home", "/download", "/layout", "/canopy-assistant"],
      [0.968, 0.85, 0.83, 0.80, 0.78, 0.75]
    );

    const result = mergeSearchResults(initial, reranked);

    expect(result.usedRerankedOrder).toBe(true);
    expect(result.response.results[0]!.url).toBe("/introducing-canopy");
  });

  it("adopts reranked order when one result jumps from last to first", () => {
    const initial = makeResponse(["/a", "/b", "/c", "/d"], [0.9, 0.8, 0.7, 0.6]);
    // /d jumps from pos 3 to pos 0 (displacement 3), /a goes 0→3 (displacement 3)
    // Both at exactly maxDisplacement (3) — should NOT trigger (> not >=)
    const reranked = makeResponse(["/d", "/b", "/c", "/a"], [0.95, 0.85, 0.75, 0.65]);

    const result = mergeSearchResults(initial, reranked);

    // Displacement is exactly 3, not > 3, so keeps initial order
    expect(result.usedRerankedOrder).toBe(false);
  });

  it("adopts reranked order when displacement exceeds maxDisplacement", () => {
    const initial = makeResponse(["/a", "/b", "/c", "/d", "/e"], [0.9, 0.8, 0.7, 0.6, 0.5]);
    // /e moves from pos 4 to pos 0 (displacement 4 > default 3)
    const reranked = makeResponse(["/e", "/b", "/c", "/d", "/a"], [0.95, 0.85, 0.75, 0.65, 0.55]);

    const result = mergeSearchResults(initial, reranked);

    expect(result.usedRerankedOrder).toBe(true);
    expect(result.response.results.map((r) => r.url)).toEqual(["/e", "/b", "/c", "/d", "/a"]);
  });

  it("returns displacements for all results", () => {
    const initial = makeResponse(["/a", "/b", "/c"]);
    const reranked = makeResponse(["/c", "/b", "/a"]);

    const result = mergeSearchResults(initial, reranked);

    expect(result.displacements).toHaveLength(3);
    const byUrl = new Map(result.displacements.map((d) => [d.url, d.displacement]));
    expect(byUrl.get("/a")).toBe(2);
    expect(byUrl.get("/b")).toBe(0);
    expect(byUrl.get("/c")).toBe(2);
  });

  it("handles empty results", () => {
    const initial = makeResponse([]);
    const reranked = makeResponse([]);

    const result = mergeSearchResults(initial, reranked);

    expect(result.usedRerankedOrder).toBe(true);
    expect(result.response.results).toEqual([]);
    expect(result.displacements).toEqual([]);
  });

  it("handles single result", () => {
    const initial = makeResponse(["/a"], [0.9]);
    const reranked = makeResponse(["/a"], [0.95]);

    const result = mergeSearchResults(initial, reranked);

    expect(result.usedRerankedOrder).toBe(false);
    expect(result.response.results[0]!.score).toBe(0.95);
  });

  it("respects custom maxDisplacement", () => {
    const initial = makeResponse(["/a", "/b", "/c", "/d", "/e"]);
    // /e moves 4→0 (displacement 4), /a moves 0→4 (displacement 4)
    // With maxDisplacement: 5, displacement 4 does not exceed threshold
    const reranked = makeResponse(["/e", "/b", "/c", "/d", "/a"]);

    const result = mergeSearchResults(initial, reranked, { maxDisplacement: 5 });

    expect(result.usedRerankedOrder).toBe(false);
  });

  it("uses reranked meta (timings, modelId) in merged response", () => {
    const initial = makeResponse(["/a"]);
    initial.meta.timingsMs.rerank = 0;
    const reranked = makeResponse(["/a"]);
    reranked.meta.timingsMs.rerank = 150;

    const result = mergeSearchResults(initial, reranked);

    expect(result.response.meta.timingsMs.rerank).toBe(150);
  });

  it("handles results only in initial (not in reranked) gracefully", () => {
    const initial = makeResponse(["/a", "/b", "/c"], [0.9, 0.8, 0.7]);
    // Reranked has fewer results (topN trimmed /c)
    const reranked = makeResponse(["/b", "/a"], [0.95, 0.85]);

    const result = mergeSearchResults(initial, reranked);

    // /a: 0→1 (disp 1), /b: 1→0 (disp 1), /c: not in reranked (disp 0)
    // No displacement > 3 → keeps initial order
    expect(result.usedRerankedOrder).toBe(false);
    expect(result.response.results.map((r) => r.url)).toEqual(["/a", "/b", "/c"]);
    // /c keeps its original score since it's not in reranked
    expect(result.response.results[2]!.score).toBe(0.7);
  });

  it("maxDisplacement: 0 always adopts reranked order on any change", () => {
    const initial = makeResponse(["/a", "/b"], [0.9, 0.8]);
    const reranked = makeResponse(["/b", "/a"], [0.95, 0.85]);

    const result = mergeSearchResults(initial, reranked, { maxDisplacement: 0 });

    expect(result.usedRerankedOrder).toBe(true);
  });
});
