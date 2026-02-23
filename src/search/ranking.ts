import type { ResolvedSearchSocketConfig, VectorHit } from "../types";

export interface RankedHit {
  hit: VectorHit;
  finalScore: number;
}

function nonNegativeOrZero(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, value);
}

export function rankHits(hits: VectorHit[], config: ResolvedSearchSocketConfig): RankedHit[] {
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
