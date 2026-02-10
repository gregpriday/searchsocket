import type { ResolvedSearchSocketConfig, VectorHit } from "../types";

export interface RankedHit {
  hit: VectorHit;
  finalScore: number;
}

export function rankHits(hits: VectorHit[], config: ResolvedSearchSocketConfig): RankedHit[] {
  return hits
    .map((hit) => {
      let score = hit.score;

      if (config.ranking.enableIncomingLinkBoost) {
        const incomingBoost = Math.log(1 + Math.max(0, hit.metadata.incomingLinks));
        score += incomingBoost * config.ranking.weights.incomingLinks;
      }

      if (config.ranking.enableDepthBoost) {
        const depthBoost = 1 / (1 + Math.max(0, hit.metadata.depth));
        score += depthBoost * config.ranking.weights.depth;
      }

      return {
        hit,
        finalScore: score
      };
    })
    .sort((a, b) => b.finalScore - a.finalScore);
}
