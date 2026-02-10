import type { EmbeddingsProvider, ResolvedSearchSocketConfig } from "../types";
import { SearchSocketError } from "../errors";
import { OpenAIEmbeddingsProvider } from "./openai";

export function createEmbeddingsProvider(config: ResolvedSearchSocketConfig): EmbeddingsProvider {
  if (config.embeddings.provider !== "openai") {
    throw new SearchSocketError(
      "CONFIG_MISSING",
      `Unsupported embeddings provider ${config.embeddings.provider}`
    );
  }

  const apiKey = process.env[config.embeddings.apiKeyEnv];
  if (!apiKey) {
    throw new SearchSocketError(
      "CONFIG_MISSING",
      `Missing embeddings API key env var: ${config.embeddings.apiKeyEnv}`
    );
  }

  return new OpenAIEmbeddingsProvider({
    apiKey,
    batchSize: config.embeddings.batchSize,
    concurrency: config.embeddings.concurrency
  });
}
