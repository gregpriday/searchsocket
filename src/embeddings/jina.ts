import pLimit from "p-limit";
import type { EmbeddingsProvider } from "../types";

export interface JinaEmbeddingsProviderOptions {
  apiKey: string;
  batchSize: number;
  concurrency: number;
  task?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export class JinaEmbeddingsProvider implements EmbeddingsProvider {
  private readonly apiKey: string;
  private readonly batchSize: number;
  private readonly concurrency: number;
  private readonly defaultTask: string;

  constructor(options: JinaEmbeddingsProviderOptions) {
    if (!Number.isInteger(options.batchSize) || options.batchSize <= 0) {
      throw new Error(`Invalid batchSize: ${options.batchSize}. batchSize must be a positive integer.`);
    }

    if (!Number.isInteger(options.concurrency) || options.concurrency <= 0) {
      throw new Error(`Invalid concurrency: ${options.concurrency}. concurrency must be a positive integer.`);
    }

    this.apiKey = options.apiKey;
    this.batchSize = options.batchSize;
    this.concurrency = options.concurrency;
    this.defaultTask = options.task ?? "retrieval.passage";
  }

  estimateTokens(text: string): number {
    const normalized = text.trim();
    if (!normalized) {
      return 0;
    }

    const wordCount = normalized.match(/[A-Za-z0-9_]+/g)?.length ?? 0;
    const punctuationCount = normalized.match(/[^\s\w]/g)?.length ?? 0;
    const cjkCount = normalized.match(/[\u3400-\u9fff]/g)?.length ?? 0;
    const charEstimate = Math.ceil(normalized.length / 4);
    const lexicalEstimate = Math.ceil(wordCount * 1.25 + punctuationCount * 0.45 + cjkCount * 1.6);

    // Conservative estimate to reduce under-reporting in cost previews.
    return Math.max(1, Math.max(charEstimate, lexicalEstimate));
  }

  async embedTexts(texts: string[], modelId: string, task?: string): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }

    const batches: Array<{ index: number; values: string[] }> = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      batches.push({
        index: i,
        values: texts.slice(i, i + this.batchSize)
      });
    }

    const outputs = new Array<number[][]>(batches.length);
    const limit = pLimit(this.concurrency);

    await Promise.all(
      batches.map((batch, position) =>
        limit(async () => {
          outputs[position] = await this.embedWithRetry(batch.values, modelId, task ?? this.defaultTask);
        })
      )
    );

    return outputs.flat();
  }

  private async embedWithRetry(texts: string[], modelId: string, task: string): Promise<number[][]> {
    const maxAttempts = 5;
    let attempt = 0;

    while (attempt < maxAttempts) {
      attempt += 1;

      let response: Response;
      try {
        response = await fetch("https://api.jina.ai/v1/embeddings", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.apiKey}`
          },
          body: JSON.stringify({
            model: modelId,
            input: texts,
            task
          })
        });
      } catch (error) {
        if (attempt >= maxAttempts) {
          throw error;
        }
        await sleep(Math.min(2 ** attempt * 300, 5_000));
        continue;
      }

      if (!response.ok) {
        const retryable = response.status === 429 || response.status >= 500;
        if (!retryable || attempt >= maxAttempts) {
          const errorBody = await response.text();
          throw new Error(`Jina embeddings failed (${response.status}): ${errorBody}`);
        }
        await sleep(Math.min(2 ** attempt * 300, 5_000));
        continue;
      }

      const payload = (await response.json()) as {
        data?: Array<{ embedding: number[] }>;
      };

      if (!payload.data || !Array.isArray(payload.data)) {
        throw new Error("Invalid Jina embeddings response format");
      }

      return payload.data.map((entry) => entry.embedding);
    }

    throw new Error("Unreachable retry state");
  }
}
