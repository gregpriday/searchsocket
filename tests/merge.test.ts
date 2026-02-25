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
  it("keeps initial order when reranker barely changes positions", () => {
    const initial = makeResponse(["/a", "/b", "/c", "/d"], [0.9, 0.8, 0.7, 0.6]);
    // Only swap adjacent: /b and /c swap (displacement = 1 each) — below threshold of 2
    const reranked = makeResponse(["/a", "/c", "/b", "/d"], [0.95, 0.85, 0.75, 0.65]);

    const result = mergeSearchResults(initial, reranked);

    expect(result.usedRerankedOrder).toBe(false);
    // Should preserve initial order
    expect(result.response.results.map((r) => r.url)).toEqual(["/a", "/b", "/c", "/d"]);
    // But use reranked scores
    expect(result.response.results[0]!.score).toBe(0.95);
    expect(result.response.results[1]!.score).toBe(0.75); // /b's reranked score
    expect(result.response.results[2]!.score).toBe(0.85); // /c's reranked score
  });

  it("adopts reranked order when reranker significantly changes positions", () => {
    const initial = makeResponse(["/a", "/b", "/c", "/d"], [0.9, 0.8, 0.7, 0.6]);
    // Major reorder: /d moves from 3→0 (displacement 3), /a moves 0→3 (displacement 3)
    // /b stays at 1, /c stays at 2. 2/4 = 0.5 >= threshold
    const reranked = makeResponse(["/d", "/b", "/c", "/a"], [0.95, 0.85, 0.75, 0.65]);

    const result = mergeSearchResults(initial, reranked);

    expect(result.usedRerankedOrder).toBe(true);
    expect(result.response.results.map((r) => r.url)).toEqual(["/d", "/b", "/c", "/a"]);
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

  it("respects custom positionThreshold", () => {
    const initial = makeResponse(["/a", "/b", "/c", "/d"]);
    // /a moves 0→3 (displacement 3), /d moves 3→0 (displacement 3)
    // /b and /c stay. With positionThreshold: 5, neither exceeds threshold
    const reranked = makeResponse(["/d", "/b", "/c", "/a"]);

    const result = mergeSearchResults(initial, reranked, { positionThreshold: 5 });

    expect(result.usedRerankedOrder).toBe(false);
  });

  it("respects custom fractionThreshold", () => {
    const initial = makeResponse(["/a", "/b", "/c", "/d"]);
    // Only /a and /d have displacement > 2 → 2/4 = 0.5
    // With fractionThreshold: 0.75, 0.5 < 0.75 → keep initial
    const reranked = makeResponse(["/d", "/b", "/c", "/a"]);

    const result = mergeSearchResults(initial, reranked, { fractionThreshold: 0.75 });

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
    // 0/3 > threshold → keeps initial order
    expect(result.usedRerankedOrder).toBe(false);
    expect(result.response.results.map((r) => r.url)).toEqual(["/a", "/b", "/c"]);
    // /c keeps its original score since it's not in reranked
    expect(result.response.results[2]!.score).toBe(0.7);
  });
});
