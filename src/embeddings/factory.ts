import type { EmbeddingsProvider, ResolvedSearchSocketConfig } from "../types";
import { SearchSocketError } from "../errors";
import { JinaEmbeddingsProvider } from "./jina";

export function createEmbeddingsProvider(config: ResolvedSearchSocketConfig): EmbeddingsProvider {
  if (config.embeddings.provider !== "jina") {
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

  return new JinaEmbeddingsProvider({
    apiKey,
    batchSize: config.embeddings.batchSize,
    concurrency: config.embeddings.concurrency
  });
}
