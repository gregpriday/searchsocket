export type {
  Chunk,
  EmbeddingsProvider,
  IndexOptions,
  IndexStats,
  MergeSearchOptions,
  MergeSearchResult,
  QueryOpts,
  RerankCandidate,
  Reranker,
  ResolvedSearchSocketConfig,
  Scope,
  SearchRequest,
  SearchResponse,
  SearchSocketConfig,
  StreamEvent,
  StreamSearchErrorEvent,
  StreamSearchEvent,
  VectorHit,
  VectorRecord,
  VectorStore
} from "./types";

export { loadConfig, mergeConfig, mergeConfigServerless } from "./config/load";
export { isServerless } from "./core/serverless";
export { resolveScope } from "./core/scope";
export { createEmbeddingsProvider } from "./embeddings";
export { createReranker, JinaReranker } from "./rerank";
export { IndexPipeline } from "./indexing/pipeline";
export { SearchEngine } from "./search/engine";
export { createVectorStore } from "./vector";
export { runMcpServer } from "./mcp/server";
export { searchsocketHandle, searchsocketVitePlugin } from "./sveltekit";
export { createSearchClient } from "./client";
export { mergeSearchResults } from "./merge";
