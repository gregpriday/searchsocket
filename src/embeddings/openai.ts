import OpenAI from "openai";
import pLimit from "p-limit";
import type { EmbeddingsProvider } from "../types";

export interface OpenAIEmbeddingsProviderOptions {
  apiKey: string;
  batchSize: number;
  concurrency: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export class OpenAIEmbeddingsProvider implements EmbeddingsProvider {
  private readonly client: OpenAI;
  private readonly batchSize: number;
  private readonly concurrency: number;

  constructor(options: OpenAIEmbeddingsProviderOptions) {
    this.client = new OpenAI({
      apiKey: options.apiKey
    });
    this.batchSize = options.batchSize;
    this.concurrency = options.concurrency;
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

  async embedTexts(texts: string[], modelId: string): Promise<number[][]> {
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
          outputs[position] = await this.embedWithRetry(batch.values, modelId);
        })
      )
    );

    return outputs.flat();
  }

  private async embedWithRetry(texts: string[], modelId: string): Promise<number[][]> {
    const maxAttempts = 5;
    let attempt = 0;

    while (attempt < maxAttempts) {
      attempt += 1;
      try {
        const response = await this.client.embeddings.create({
          model: modelId,
          input: texts,
          encoding_format: "float"
        });

        return response.data.map((entry) => entry.embedding);
      } catch (error) {
        const status = (error as { status?: number }).status;
        const retryable = status === 429 || (typeof status === "number" && status >= 500);

        if (!retryable || attempt >= maxAttempts) {
          throw error;
        }

        const delay = Math.min(2 ** attempt * 300, 5_000);
        await sleep(delay);
      }
    }

    throw new Error("Unreachable retry state");
  }
}
