/**
 * Standard IR quality metrics for search evaluation.
 */
import type { SearchResult } from "../../src/types";

export interface GradedJudgment {
  url: string;
  relevance: number; // 0–3
}

/**
 * Mean Reciprocal Rank — how high is the first relevant result?
 * Returns 1/rank of the first result whose URL appears in `relevant`.
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

/**
 * Precision@K — what fraction of the top-K results are relevant?
 */
export function precisionAtK(results: SearchResult[], relevant: string[], k: number): number {
  const set = new Set(relevant);
  const topK = results.slice(0, k);
  if (topK.length === 0) return 0;
  const hits = topK.filter((r) => set.has(r.url)).length;
  return hits / k;
}

/**
 * Discounted Cumulative Gain at position K (graded relevance).
 */
function dcgAtK(results: SearchResult[], judgments: GradedJudgment[], k: number): number {
  const relevanceMap = new Map(judgments.map((j) => [j.url, j.relevance]));
  let dcg = 0;
  const topK = results.slice(0, k);
  for (let i = 0; i < topK.length; i++) {
    const rel = relevanceMap.get(topK[i]!.url) ?? 0;
    dcg += (Math.pow(2, rel) - 1) / Math.log2(i + 2); // i+2 because log2(1) = 0
  }
  return dcg;
}

/**
 * Ideal DCG — sort judgments by relevance desc, compute DCG.
 */
function idcgAtK(judgments: GradedJudgment[], k: number): number {
  const sorted = [...judgments].sort((a, b) => b.relevance - a.relevance);
  let idcg = 0;
  const topK = sorted.slice(0, k);
  for (let i = 0; i < topK.length; i++) {
    const rel = topK[i]!.relevance;
    idcg += (Math.pow(2, rel) - 1) / Math.log2(i + 2);
  }
  return idcg;
}

/**
 * Normalized Discounted Cumulative Gain at K.
 * Returns 0 if there are no relevant judgments.
 */
export function ndcgAtK(results: SearchResult[], judgments: GradedJudgment[], k: number): number {
  const ideal = idcgAtK(judgments, k);
  if (ideal === 0) return 0;
  return dcgAtK(results, judgments, k) / ideal;
}

/**
 * Noise rejection rate — fraction of noise queries that returned empty.
 */
export function noiseRejectionRate(
  queryResults: Map<string, SearchResult[]>,
  noiseQueries: string[]
): number {
  if (noiseQueries.length === 0) return 1;
  let rejected = 0;
  for (const query of noiseQueries) {
    const results = queryResults.get(query) ?? [];
    if (results.length === 0) {
      rejected++;
    }
  }
  return rejected / noiseQueries.length;
}

/**
 * Format a quality metrics report.
 */
export function formatReport(metrics: {
  mrr: number;
  precisionAt3: number;
  ndcgAt5: number;
  noiseRejection: number;
  totalQueries: number;
  passedRanking: number;
  failedRanking: number;
}): string {
  const lines = [
    "┌─────────────────────────────────────────┐",
    "│       Search Quality Report             │",
    "├─────────────────────────────────────────┤",
    `│ MRR:              ${metrics.mrr.toFixed(4).padStart(8)}            │`,
    `│ P@3:              ${metrics.precisionAt3.toFixed(4).padStart(8)}            │`,
    `│ NDCG@5:           ${metrics.ndcgAt5.toFixed(4).padStart(8)}            │`,
    `│ Noise rejection:  ${(metrics.noiseRejection * 100).toFixed(1).padStart(7)}%           │`,
    "├─────────────────────────────────────────┤",
    `│ Ranking: ${metrics.passedRanking}/${metrics.passedRanking + metrics.failedRanking} passed                     │`,
    `│ Queries: ${metrics.totalQueries} total                       │`,
    "└─────────────────────────────────────────┘"
  ];
  return lines.join("\n");
}
