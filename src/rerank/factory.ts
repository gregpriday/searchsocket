import type { Reranker, ResolvedSearchSocketConfig } from "../types";
import { JinaReranker } from "./jina";

export function createReranker(config: ResolvedSearchSocketConfig): Reranker | null {
  if (!config.rerank.enabled) {
    return null;
  }

  const apiKey = process.env[config.embeddings.apiKeyEnv];
  if (!apiKey) {
    return null;
  }

  return new JinaReranker({
    apiKey,
    model: config.rerank.model
  });
}
