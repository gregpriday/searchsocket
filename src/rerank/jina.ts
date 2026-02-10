import type { RerankCandidate, Reranker } from "../types";

export interface JinaRerankerOptions {
  apiKey: string;
  model: string;
  maxRetries?: number;
}

interface JinaRerankResult {
  index?: number;
  relevance_score?: number;
  score?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export class JinaReranker implements Reranker {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly maxRetries: number;

  constructor(options: JinaRerankerOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.maxRetries = options.maxRetries ?? 4;
  }

  async rerank(query: string, candidates: RerankCandidate[], topN?: number): Promise<Array<{ id: string; score: number }>> {
    if (candidates.length === 0) {
      return [];
    }

    const body = {
      model: this.model,
      query,
      documents: candidates.map((candidate) => candidate.text),
      top_n: topN ?? candidates.length
    };

    let attempt = 0;

    while (attempt <= this.maxRetries) {
      attempt += 1;

      const response = await fetch("https://api.jina.ai/v1/rerank", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`
        },
        body: JSON.stringify(body)
      });

      if (!response.ok) {
        const retryable = response.status === 429 || response.status >= 500;
        if (retryable && attempt <= this.maxRetries) {
          await sleep(Math.min(300 * 2 ** attempt, 4000));
          continue;
        }

        const errorBody = await response.text();
        throw new Error(`Jina rerank failed (${response.status}): ${errorBody}`);
      }

      const payload = (await response.json()) as {
        results?: JinaRerankResult[];
        data?: JinaRerankResult[];
      };

      const rawResults = payload.results ?? payload.data ?? [];

      return rawResults
        .flatMap((item) => {
          const index = item.index;
          if (typeof index !== "number" || index < 0 || index >= candidates.length) {
            return [];
          }

          const candidate = candidates[index];
          if (!candidate) {
            return [];
          }

          const score = typeof item.relevance_score === "number" ? item.relevance_score : item.score ?? 0;

          return [
            {
              id: candidate.id,
              score
            }
          ];
        })
        .sort((a, b) => b.score - a.score);
    }

    throw new Error("Jina rerank request failed after retries");
  }
}
