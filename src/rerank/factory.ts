import type { Reranker, ResolvedSiteScribeConfig } from "../types";
import { JinaReranker } from "./jina";

export function createReranker(config: ResolvedSiteScribeConfig): Reranker | null {
  if (config.rerank.provider === "none") {
    return null;
  }

  if (config.rerank.provider === "jina") {
    const apiKey = process.env[config.rerank.jina.apiKeyEnv];
    if (!apiKey) {
      return null;
    }

    return new JinaReranker({
      apiKey,
      model: config.rerank.jina.model
    });
  }

  return null;
}
