import { matchUrlPattern } from "../utils/pattern";
import type { PageHit, ResolvedSearchSocketConfig, ScoreBreakdown, VectorHit } from "../types";

export interface RankedHit {
  hit: VectorHit;
  finalScore: number;
  breakdown?: ScoreBreakdown;
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

export function rankHits(hits: VectorHit[], config: ResolvedSearchSocketConfig, query?: string, debug?: boolean): RankedHit[] {
  const normalizedQuery = query ? normalizeForTitleMatch(query) : "";
  const titleMatchWeight = config.ranking.weights.titleMatch;

  return hits
    .map((hit) => {
      const baseScore = Number.isFinite(hit.score) ? hit.score : Number.NEGATIVE_INFINITY;
      let score = baseScore;

      let incomingLinkBoostValue = 0;
      if (config.ranking.enableIncomingLinkBoost) {
        const incomingBoost = Math.log(1 + nonNegativeOrZero(hit.metadata.incomingLinks));
        incomingLinkBoostValue = incomingBoost * config.ranking.weights.incomingLinks;
        score += incomingLinkBoostValue;
      }

      let depthBoostValue = 0;
      if (config.ranking.enableDepthBoost) {
        const depthBoost = 1 / (1 + nonNegativeOrZero(hit.metadata.depth));
        depthBoostValue = depthBoost * config.ranking.weights.depth;
        score += depthBoostValue;
      }

      let titleMatchBoostValue = 0;
      if (normalizedQuery && titleMatchWeight > 0) {
        const normalizedTitle = normalizeForTitleMatch(hit.metadata.title);
        if (normalizedQuery.length > 0 && normalizedTitle.length > 0 &&
            (normalizedTitle.includes(normalizedQuery) || normalizedQuery.includes(normalizedTitle))) {
          titleMatchBoostValue = titleMatchWeight;
          score += titleMatchBoostValue;
        }
      }

      let freshnessBoostValue = 0;
      if (config.ranking.enableFreshnessBoost) {
        const publishedAt = hit.metadata.publishedAt;
        if (typeof publishedAt === "number" && Number.isFinite(publishedAt)) {
          const daysSince = Math.max(0, (Date.now() - publishedAt) / 86_400_000);
          const decay = 1 / (1 + nonNegativeOrZero(daysSince) * config.ranking.freshnessDecayRate);
          freshnessBoostValue = decay * config.ranking.weights.freshness;
          score += freshnessBoostValue;
        }
      }

      let anchorTextMatchBoostValue = 0;
      if (config.ranking.enableAnchorTextBoost && normalizedQuery && config.ranking.weights.anchorText > 0) {
        const normalizedAnchorText = normalizeForTitleMatch(hit.metadata.incomingAnchorText ?? "");
        if (normalizedAnchorText.length > 0 && normalizedQuery.length > 0 &&
            (normalizedAnchorText.includes(normalizedQuery) || normalizedQuery.includes(normalizedAnchorText))) {
          anchorTextMatchBoostValue = config.ranking.weights.anchorText;
          score += anchorTextMatchBoostValue;
        }
      }

      const result: RankedHit = {
        hit,
        finalScore: Number.isFinite(score) ? score : Number.NEGATIVE_INFINITY
      };

      if (debug) {
        result.breakdown = {
          baseScore,
          incomingLinkBoost: incomingLinkBoostValue,
          depthBoost: depthBoostValue,
          titleMatchBoost: titleMatchBoostValue,
          freshnessBoost: freshnessBoostValue,
          anchorTextMatchBoost: anchorTextMatchBoostValue
        };
      }

      return result;
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
  const minScoreRatio = config.ranking.minScoreRatio;

  // Relative ratio thresholding: drop results scoring below X% of the top result
  if (minScoreRatio > 0 && results.length > 0) {
    const topScore = results[0]!.pageScore;
    if (Number.isFinite(topScore) && topScore > 0) {
      const minThreshold = topScore * minScoreRatio;
      results = results.filter((r) => r.pageScore >= minThreshold);
    }
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

/**
 * Merge page-level search results with chunk-level search results.
 *
 * @deprecated Use rankPageHits + per-page chunk retrieval instead (page-first pipeline).
 */
export function mergePageAndChunkResults(
  pageHits: PageHit[],
  rankedChunks: RankedHit[],
  config: ResolvedSearchSocketConfig
): RankedHit[] {
  if (pageHits.length === 0) return rankedChunks;

  const w = config.search.pageSearchWeight;
  const pageScoreMap = new Map<string, PageHit>();
  for (const ph of pageHits) {
    pageScoreMap.set(ph.url, ph);
  }

  // Track which page URLs have chunks
  const pagesWithChunks = new Set<string>();

  // Blend chunk scores with page scores
  const merged: RankedHit[] = rankedChunks.map((ranked) => {
    const url = ranked.hit.metadata.url;
    const pageHit = pageScoreMap.get(url);
    if (pageHit) {
      pagesWithChunks.add(url);
      const blended = (1 - w) * ranked.finalScore + w * pageHit.score;
      return {
        hit: ranked.hit,
        finalScore: Number.isFinite(blended) ? blended : ranked.finalScore,
        breakdown: ranked.breakdown
      };
    }
    return ranked;
  });

  // Create synthetic entries for pages found only by page search (no chunks)
  for (const [url, pageHit] of pageScoreMap) {
    if (pagesWithChunks.has(url)) continue;

    const syntheticScore = pageHit.score * w;
    const syntheticHit: VectorHit = {
      id: `page:${url}`,
      score: pageHit.score,
      metadata: {
        projectId: "",
        scopeName: "",
        url: pageHit.url,
        path: pageHit.url,
        title: pageHit.title,
        sectionTitle: "",
        headingPath: [],
        snippet: pageHit.description || pageHit.title,
        chunkText: pageHit.description || pageHit.title,
        ordinal: 0,
        contentHash: "",
        depth: pageHit.depth,
        incomingLinks: pageHit.incomingLinks,
        routeFile: pageHit.routeFile,
        tags: pageHit.tags,
        publishedAt: pageHit.publishedAt
      }
    };

    merged.push({
      hit: syntheticHit,
      finalScore: Number.isFinite(syntheticScore) ? syntheticScore : 0
    });
  }

  // Re-sort by blended score descending
  return merged.sort((a, b) => {
    const delta = b.finalScore - a.finalScore;
    return Number.isNaN(delta) ? 0 : delta;
  });
}

/**
 * Page-first ranking: rank pages by their page-level embedding similarity,
 * then apply page-level boosts (pageWeights, depth, incoming links, title match, etc.)
 */
export interface RankedPage {
  url: string;
  title: string;
  description: string;
  routeFile: string;
  depth: number;
  incomingLinks: number;
  tags: string[];
  baseScore: number;
  finalScore: number;
  publishedAt?: number;
  breakdown?: PageScoreBreakdown;
}

export interface PageScoreBreakdown {
  baseScore: number;
  pageWeight: number;
  incomingLinkBoost: number;
  depthBoost: number;
  titleMatchBoost: number;
  freshnessBoost: number;
}

export function rankPageHits(
  pageHits: PageHit[],
  config: ResolvedSearchSocketConfig,
  query?: string,
  debug?: boolean
): RankedPage[] {
  const normalizedQuery = query ? normalizeForTitleMatch(query) : "";
  const titleMatchWeight = config.ranking.weights.titleMatch;

  return pageHits
    .map((hit) => {
      const baseScore = Number.isFinite(hit.score) ? hit.score : Number.NEGATIVE_INFINITY;
      let score = baseScore;

      let incomingLinkBoostValue = 0;
      if (config.ranking.enableIncomingLinkBoost) {
        const incomingBoost = Math.log(1 + nonNegativeOrZero(hit.incomingLinks));
        incomingLinkBoostValue = incomingBoost * config.ranking.weights.incomingLinks;
        score += incomingLinkBoostValue;
      }

      let depthBoostValue = 0;
      if (config.ranking.enableDepthBoost) {
        const depthBoost = 1 / (1 + nonNegativeOrZero(hit.depth));
        depthBoostValue = depthBoost * config.ranking.weights.depth;
        score += depthBoostValue;
      }

      let titleMatchBoostValue = 0;
      if (normalizedQuery && titleMatchWeight > 0) {
        const normalizedTitle = normalizeForTitleMatch(hit.title);
        if (normalizedQuery.length > 0 && normalizedTitle.length > 0 &&
            (normalizedTitle.includes(normalizedQuery) || normalizedQuery.includes(normalizedTitle))) {
          titleMatchBoostValue = titleMatchWeight;
          score += titleMatchBoostValue;
        }
      }

      let freshnessBoostValue = 0;
      if (config.ranking.enableFreshnessBoost) {
        const publishedAt = hit.publishedAt;
        if (typeof publishedAt === "number" && Number.isFinite(publishedAt)) {
          const daysSince = Math.max(0, (Date.now() - publishedAt) / 86_400_000);
          const decay = 1 / (1 + nonNegativeOrZero(daysSince) * config.ranking.freshnessDecayRate);
          freshnessBoostValue = decay * config.ranking.weights.freshness;
          score += freshnessBoostValue;
        }
      }

      // Apply page weight multiplier
      const pageWeight = findPageWeight(hit.url, config.ranking.pageWeights);
      if (pageWeight !== 1) {
        score *= pageWeight;
      }

      const result: RankedPage = {
        url: hit.url,
        title: hit.title,
        description: hit.description,
        routeFile: hit.routeFile,
        depth: hit.depth,
        incomingLinks: hit.incomingLinks,
        tags: hit.tags,
        baseScore,
        finalScore: Number.isFinite(score) ? score : Number.NEGATIVE_INFINITY,
        publishedAt: hit.publishedAt
      };

      if (debug) {
        result.breakdown = {
          baseScore,
          pageWeight,
          incomingLinkBoost: incomingLinkBoostValue,
          depthBoost: depthBoostValue,
          titleMatchBoost: titleMatchBoostValue,
          freshnessBoost: freshnessBoostValue,
        };
      }

      return result;
    })
    .filter((p) => findPageWeight(p.url, config.ranking.pageWeights) !== 0)
    .sort((a, b) => {
      const delta = b.finalScore - a.finalScore;
      return Number.isNaN(delta) ? 0 : delta;
    });
}

/**
 * Trim ranked pages by score gap (same logic as trimByScoreGap but for RankedPage[]).
 */
export function trimPagesByScoreGap(
  results: RankedPage[],
  config: ResolvedSearchSocketConfig
): RankedPage[] {
  if (results.length === 0) return results;

  const threshold = config.ranking.scoreGapThreshold;
  const minScoreRatio = config.ranking.minScoreRatio;

  // Relative ratio thresholding: drop results scoring below X% of the top result
  if (minScoreRatio > 0 && results.length > 0) {
    const topScore = results[0]!.finalScore;
    if (Number.isFinite(topScore) && topScore > 0) {
      const minThreshold = topScore * minScoreRatio;
      results = results.filter((r) => r.finalScore >= minThreshold);
    }
  }

  // Score-gap trimming
  if (threshold > 0 && results.length > 1) {
    for (let i = 1; i < results.length; i++) {
      const prev = results[i - 1]!.finalScore;
      const current = results[i]!.finalScore;
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
