import type { SearchResponse, MergeSearchOptions, MergeSearchResult } from "./types";

/**
 * Smart merge of initial (pre-rerank) and reranked search results.
 *
 * If the reranker barely changed the ordering, we keep the initial order
 * (which the user already saw) and just update scores from the reranked response.
 * If the reranker significantly changed the ordering, we adopt the reranked order.
 */
export function mergeSearchResults(
  initial: SearchResponse,
  reranked: SearchResponse,
  options?: MergeSearchOptions
): MergeSearchResult {
  const positionThreshold = options?.positionThreshold ?? 2;
  const fractionThreshold = options?.fractionThreshold ?? 0.5;

  const initialUrls = initial.results.map((r) => r.url);
  const rerankedUrls = reranked.results.map((r) => r.url);

  // Build position maps
  const initialPos = new Map<string, number>();
  for (let i = 0; i < initialUrls.length; i++) {
    initialPos.set(initialUrls[i]!, i);
  }

  const rerankedPos = new Map<string, number>();
  for (let i = 0; i < rerankedUrls.length; i++) {
    rerankedPos.set(rerankedUrls[i]!, i);
  }

  // Compute displacements for results present in both orderings
  const displacements: Array<{ url: string; displacement: number }> = [];
  for (const url of initialUrls) {
    const iPos = initialPos.get(url)!;
    const rPos = rerankedPos.get(url);
    const displacement = rPos !== undefined ? Math.abs(iPos - rPos) : 0;
    displacements.push({ url, displacement });
  }

  // Count significantly displaced results
  const totalResults = displacements.length;
  if (totalResults === 0) {
    return {
      response: reranked,
      usedRerankedOrder: true,
      displacements
    };
  }

  const significantlyMoved = displacements.filter(
    (d) => d.displacement > positionThreshold
  ).length;
  const fraction = significantlyMoved / totalResults;

  if (fraction >= fractionThreshold) {
    // Significant reordering — adopt reranked order as-is
    return {
      response: reranked,
      usedRerankedOrder: true,
      displacements
    };
  }

  // Minor reordering — keep initial order but update scores from reranked
  const rerankedScoreMap = new Map<string, number>();
  for (const result of reranked.results) {
    rerankedScoreMap.set(result.url, result.score);
  }

  const mergedResults = initial.results.map((result) => ({
    ...result,
    score: rerankedScoreMap.get(result.url) ?? result.score
  }));

  return {
    response: {
      ...reranked,
      results: mergedResults
    },
    usedRerankedOrder: false,
    displacements
  };
}
