import { matchUrlPattern } from "../utils/pattern";
import type { ResolvedSearchSocketConfig, VectorHit } from "../types";

export interface RankedHit {
  hit: VectorHit;
  finalScore: number;
}

export interface PageResult {
  url: string;
  title: string;
  routeFile: string;
  pageScore: number;
  bestChunk: RankedHit;
  matchingChunks: RankedHit[];
}

function nonNegativeOrZero(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, value);
}

function normalizeForTitleMatch(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim();
}

export function rankHits(hits: VectorHit[], config: ResolvedSearchSocketConfig, query?: string): RankedHit[] {
  const normalizedQuery = query ? normalizeForTitleMatch(query) : "";
  const titleMatchWeight = config.ranking.weights.titleMatch;

  return hits
    .map((hit) => {
      let score = Number.isFinite(hit.score) ? hit.score : Number.NEGATIVE_INFINITY;

      if (config.ranking.enableIncomingLinkBoost) {
        const incomingBoost = Math.log(1 + nonNegativeOrZero(hit.metadata.incomingLinks));
        score += incomingBoost * config.ranking.weights.incomingLinks;
      }

      if (config.ranking.enableDepthBoost) {
        const depthBoost = 1 / (1 + nonNegativeOrZero(hit.metadata.depth));
        score += depthBoost * config.ranking.weights.depth;
      }

      if (normalizedQuery && titleMatchWeight > 0) {
        const normalizedTitle = normalizeForTitleMatch(hit.metadata.title);
        if (normalizedQuery.length > 0 && normalizedTitle.length > 0 &&
            (normalizedTitle.includes(normalizedQuery) || normalizedQuery.includes(normalizedTitle))) {
          score += titleMatchWeight;
        }
      }

      return {
        hit,
        finalScore: Number.isFinite(score) ? score : Number.NEGATIVE_INFINITY
      };
    })
    .sort((a, b) => {
      const delta = b.finalScore - a.finalScore;
      return Number.isNaN(delta) ? 0 : delta;
    });
}

export function trimByScoreGap(
  results: PageResult[],
  config: ResolvedSearchSocketConfig
): PageResult[] {
  if (results.length === 0) return results;

  const threshold = config.ranking.scoreGapThreshold;
  const minScore = config.ranking.minScore;

  // Check median score — if below minScore, no strong matches
  if (minScore > 0 && results.length > 0) {
    const sortedScores = results.map((r) => r.pageScore).sort((a, b) => a - b);
    const mid = Math.floor(sortedScores.length / 2);
    const median = sortedScores.length % 2 === 0
      ? (sortedScores[mid - 1]! + sortedScores[mid]!) / 2
      : sortedScores[mid]!;
    if (median < minScore) return [];
  }

  // Score-gap trimming
  if (threshold > 0 && results.length > 1) {
    for (let i = 1; i < results.length; i++) {
      const prev = results[i - 1]!.pageScore;
      const current = results[i]!.pageScore;
      if (prev > 0) {
        const gap = (prev - current) / prev;
        if (gap >= threshold) {
          return results.slice(0, i);
        }
      }
    }
  }

  return results;
}

export function findPageWeight(url: string, pageWeights: Record<string, number>): number {
  // Try each pattern — most specific match wins (longest pattern)
  let bestPattern = "";
  let bestWeight = 1;

  for (const [pattern, weight] of Object.entries(pageWeights)) {
    if (matchUrlPattern(url, pattern) && pattern.length > bestPattern.length) {
      bestPattern = pattern;
      bestWeight = weight;
    }
  }

  return bestWeight;
}

export function aggregateByPage(
  ranked: RankedHit[],
  config: ResolvedSearchSocketConfig
): PageResult[] {
  // 1. Group ranked hits by URL
  const groups = new Map<string, RankedHit[]>();
  for (const hit of ranked) {
    const url = hit.hit.metadata.url;
    const group = groups.get(url);
    if (group) group.push(hit);
    else groups.set(url, [hit]);
  }

  // 2. For each group, compute page score using score-weighted decay
  const { aggregationCap, aggregationDecay } = config.ranking;
  const pages: PageResult[] = [];
  for (const [url, chunks] of groups) {
    // Sort chunks by score desc within the group (NaN-safe)
    chunks.sort((a, b) => {
      const delta = b.finalScore - a.finalScore;
      return Number.isNaN(delta) ? 0 : delta;
    });
    const best = chunks[0]!;
    const maxScore = Number.isFinite(best.finalScore) ? best.finalScore : Number.NEGATIVE_INFINITY;

    // Score-weighted aggregation with exponential decay on top-N chunks.
    // Only additional chunks (i >= 1) contribute; single-chunk pages get zero bonus.
    const topChunks = chunks.slice(0, aggregationCap);
    let aggregationBonus = 0;
    for (let i = 1; i < topChunks.length; i++) {
      const chunkScore = Number.isFinite(topChunks[i]!.finalScore) ? topChunks[i]!.finalScore : 0;
      aggregationBonus += chunkScore * Math.pow(aggregationDecay, i);
    }
    let pageScore = maxScore + aggregationBonus * config.ranking.weights.aggregation;

    // Apply page weight if configured.
    // Note: page weights are multiplicative on the already-boosted score,
    // so they compound with aggregation. Use gentle values (1.05–1.2x).
    const pageWeight = findPageWeight(url, config.ranking.pageWeights);
    if (pageWeight === 0) continue;
    if (pageWeight !== 1) {
      pageScore *= pageWeight;
    }

    pages.push({
      url,
      title: best.hit.metadata.title,
      routeFile: best.hit.metadata.routeFile,
      pageScore: Number.isFinite(pageScore) ? pageScore : Number.NEGATIVE_INFINITY,
      bestChunk: best,
      matchingChunks: chunks
    });
  }

  // 3. Sort by pageScore desc (NaN-safe)
  return pages.sort((a, b) => {
    const delta = b.pageScore - a.pageScore;
    return Number.isNaN(delta) ? 0 : delta;
  });
}
