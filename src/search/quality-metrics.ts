/**
 * Quality metrics for search evaluation.
 */
import type { SearchResult } from "../types";

/**
 * Reciprocal rank — returns 1/rank of the first result whose URL appears in `relevant`.
 * Returns 0 if no relevant result is found.
 */
export function reciprocalRank(results: SearchResult[], relevant: string[]): number {
  const set = new Set(relevant);
  for (let i = 0; i < results.length; i++) {
    if (set.has(results[i]!.url)) {
      return 1 / (i + 1);
    }
  }
  return 0;
}

/**
 * Mean Reciprocal Rank across multiple queries.
 */
export function mrr(queries: Array<{ results: SearchResult[]; relevant: string[] }>): number {
  if (queries.length === 0) return 0;
  const sum = queries.reduce((acc, q) => acc + reciprocalRank(q.results, q.relevant), 0);
  return sum / queries.length;
}
