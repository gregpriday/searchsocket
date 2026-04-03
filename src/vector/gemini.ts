import pLimit from "p-limit";
import type { ResolvedSearchSocketConfig } from "../types";
import { SearchSocketError } from "../errors";

/**
 * L2-normalize a vector. Required when using outputDimensionality < 3072,
 * since Gemini's full-dimension vectors are pre-normalized but truncated ones are not.
 */
export function l2Normalize(v: number[]): number[] {
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  if (norm === 0) return v;
  return v.map((x) => x / norm);
}

export interface GeminiEmbedderOptions {
  model: string;
  dimensions: number;
  taskType: string;
  apiKey: string;
  batchSize: number;
}

export class GeminiEmbedder {
  private readonly model: string;
  private readonly dimensions: number;
  private readonly taskType: string;
  private readonly apiKey: string;
  private readonly batchSize: number;
  private readonly limiter: ReturnType<typeof pLimit>;
  private clientPromise: Promise<unknown> | null = null;

  constructor(opts: GeminiEmbedderOptions) {
    this.model = opts.model;
    this.dimensions = opts.dimensions;
    this.taskType = opts.taskType;
    this.apiKey = opts.apiKey;
    this.batchSize = opts.batchSize;
    this.limiter = pLimit(10);
  }

  static fromConfig(config: ResolvedSearchSocketConfig): GeminiEmbedder {
    const apiKey = process.env[config.embedding.apiKeyEnv];
    if (!apiKey) {
      throw new SearchSocketError(
        "VECTOR_BACKEND_UNAVAILABLE",
        `Missing Gemini API key. Set the ${config.embedding.apiKeyEnv} environment variable.`
      );
    }
    return new GeminiEmbedder({
      model: config.embedding.model,
      dimensions: config.embedding.dimensions,
      taskType: config.embedding.taskType,
      apiKey,
      batchSize: config.embedding.batchSize
    });
  }

  private async getClient(): Promise<{ models: { embedContent: Function; batchEmbedContents: Function } }> {
    if (!this.clientPromise) {
      this.clientPromise = import("@google/genai").then(
        ({ GoogleGenAI }) => new GoogleGenAI({ apiKey: this.apiKey })
      );
    }
    return this.clientPromise as Promise<{ models: { embedContent: Function; batchEmbedContents: Function } }>;
  }

  /**
   * Embed an array of texts using the configured model.
   * Handles batching and rate limiting internally.
   */
  async embedTexts(texts: string[], taskType?: string): Promise<number[][]> {
    if (texts.length === 0) return [];

    const effectiveTaskType = taskType ?? this.taskType;
    const needsNormalize = this.dimensions < 3072;
    const results: number[][] = new Array(texts.length);

    const batches: Array<{ startIdx: number; batchTexts: string[] }> = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      batches.push({
        startIdx: i,
        batchTexts: texts.slice(i, i + this.batchSize)
      });
    }

    const client = await this.getClient();

    await Promise.all(
      batches.map(({ startIdx, batchTexts }) =>
        this.limiter(async () => {
          const response = await (client.models.batchEmbedContents as Function)({
            model: this.model,
            requests: batchTexts.map((text) => ({
              content: text,
              taskType: effectiveTaskType,
              outputDimensionality: this.dimensions
            }))
          });

          const embeddings = (response as { embeddings: Array<{ values: number[] }> }).embeddings;
          if (!embeddings || embeddings.length !== batchTexts.length) {
            throw new SearchSocketError(
              "EMBEDDING_FAILED",
              `Expected ${batchTexts.length} embeddings, got ${embeddings?.length ?? 0}`
            );
          }

          for (let j = 0; j < embeddings.length; j++) {
            const values = embeddings[j]!.values;
            if (!values || values.length === 0) {
              throw new SearchSocketError(
                "EMBEDDING_FAILED",
                `Empty embedding vector returned for text at index ${startIdx + j}`
              );
            }
            results[startIdx + j] = needsNormalize ? l2Normalize(values) : values;
          }
        })
      )
    );

    return results;
  }

  /**
   * Embed a single query text using RETRIEVAL_QUERY task type.
   */
  async embedQuery(query: string): Promise<number[]> {
    const result = await this.embedTexts([query], "RETRIEVAL_QUERY");
    return result[0]!;
  }

  /**
   * Embed an image with optional context text using gemini-embedding-2-preview.
   */
  async embedImage(
    imageBase64: string,
    mimeType: string,
    contextText?: string
  ): Promise<number[]> {
    const client = await this.getClient();
    const needsNormalize = this.dimensions < 3072;

    const parts: Array<Record<string, unknown>> = [];
    if (contextText) {
      parts.push({ text: contextText });
    }
    parts.push({
      inlineData: {
        mimeType,
        data: imageBase64
      }
    });

    const response = await (client.models.embedContent as Function)({
      model: "gemini-embedding-2-preview",
      contents: { parts },
      config: {
        outputDimensionality: this.dimensions
      }
    });

    const embedding = (response as { embeddings: Array<{ values: number[] }> }).embeddings?.[0];
    if (!embedding?.values || embedding.values.length === 0) {
      throw new SearchSocketError(
        "EMBEDDING_FAILED",
        "Empty embedding vector returned for image"
      );
    }

    return needsNormalize ? l2Normalize(embedding.values) : embedding.values;
  }
}
