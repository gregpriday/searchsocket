export type {
  Chunk,
  EmbeddingsProvider,
  IndexOptions,
  IndexStats,
  QueryOpts,
  RerankCandidate,
  Reranker,
  ResolvedSiteScribeConfig,
  Scope,
  SearchRequest,
  SearchResponse,
  SiteScribeConfig,
  VectorHit,
  VectorRecord,
  VectorStore
} from "./types";

export { loadConfig, mergeConfig } from "./config/load";
export { resolveScope } from "./core/scope";
export { createEmbeddingsProvider } from "./embeddings";
export { createReranker, JinaReranker } from "./rerank";
export { IndexPipeline } from "./indexing/pipeline";
export { SearchEngine } from "./search/engine";
export { createVectorStore } from "./vector";
export { runMcpServer } from "./mcp/server";
export { sitescribeHandle, sitescribeVitePlugin } from "./sveltekit";
export { createSearchClient } from "./client";
