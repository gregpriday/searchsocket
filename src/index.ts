export type {
  Chunk,
  IndexOptions,
  IndexStats,
  ResolvedSearchSocketConfig,
  Scope,
  SearchRequest,
  SearchResponse,
  SearchSocketConfig,
  VectorHit
} from "./types";

export { loadConfig, mergeConfig, mergeConfigServerless } from "./config/load";
export { isServerless } from "./core/serverless";
export { resolveScope } from "./core/scope";
export { IndexPipeline } from "./indexing/pipeline";
export { SearchEngine } from "./search/engine";
export { createUpstashStore } from "./vector";
export { UpstashSearchStore } from "./vector/upstash";
export { runMcpServer } from "./mcp/server";
export { searchsocketHandle, searchsocketVitePlugin } from "./sveltekit";
export { createSearchClient } from "./client";
