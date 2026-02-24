export type ScopeMode = "fixed" | "git" | "env";
export type SourceMode = "static-output" | "crawl" | "content-files" | "build";
export type EmbeddingProvider = "jina";

export interface SearchSocketConfig {
  project?: {
    id?: string;
    baseUrl?: string;
  };
  scope?: {
    mode?: ScopeMode;
    fixed?: string;
    envVar?: string;
    sanitize?: boolean;
  };
  source?: {
    mode?: SourceMode;
    staticOutputDir?: string;
    strictRouteMapping?: boolean;
    crawl?: {
      baseUrl: string;
      routes?: string[];
      sitemapUrl?: string;
    };
    contentFiles?: {
      globs: string[];
      baseDir?: string;
    };
    build?: {
      outputDir?: string;
      paramValues?: Record<string, string[]>;
      exclude?: string[];
      previewTimeout?: number;
      discover?: boolean;
      seedUrls?: string[];
      maxPages?: number;
      maxDepth?: number;
    };
  };
  extract?: {
    mainSelector?: string;
    dropTags?: string[];
    dropSelectors?: string[];
    ignoreAttr?: string;
    noindexAttr?: string;
    respectRobotsNoindex?: boolean;
  };
  transform?: {
    output?: "markdown";
    preserveCodeBlocks?: boolean;
    preserveTables?: boolean;
  };
  chunking?: {
    strategy?: "hybrid";
    maxChars?: number;
    overlapChars?: number;
    minChars?: number;
    headingPathDepth?: number;
    dontSplitInside?: Array<"code" | "table" | "blockquote">;
    prependTitle?: boolean;
    pageSummaryChunk?: boolean;
  };
  embeddings?: {
    provider?: EmbeddingProvider;
    model?: string;
    apiKeyEnv?: string;
    batchSize?: number;
    concurrency?: number;
    pricePer1kTokens?: number;
  };
  vector?: {
    dimension?: number;
    turso?: {
      urlEnv?: string;
      authTokenEnv?: string;
      localPath?: string;
    };
  };
  rerank?: {
    enabled?: boolean;
    topN?: number;
    model?: string;
  };
  ranking?: {
    enableIncomingLinkBoost?: boolean;
    enableDepthBoost?: boolean;
    pageWeights?: Record<string, number>;
    aggregationCap?: number;
    aggregationDecay?: number;
    minChunkScoreRatio?: number;
    weights?: {
      incomingLinks?: number;
      depth?: number;
      rerank?: number;
      aggregation?: number;
    };
  };
  api?: {
    path?: string;
    cors?: {
      allowOrigins?: string[];
    };
    rateLimit?: {
      windowMs?: number;
      max?: number;
    };
  };
  mcp?: {
    enable?: boolean;
    transport?: "stdio" | "http";
    http?: {
      port?: number;
      path?: string;
    };
  };
  state?: {
    dir?: string;
    writeMirror?: boolean;
  };
}

export interface ResolvedSearchSocketConfig {
  project: {
    id: string;
    baseUrl?: string;
  };
  scope: {
    mode: ScopeMode;
    fixed: string;
    envVar: string;
    sanitize: boolean;
  };
  source: {
    mode: SourceMode;
    staticOutputDir: string;
    strictRouteMapping: boolean;
    crawl?: {
      baseUrl: string;
      routes: string[];
      sitemapUrl?: string;
    };
    contentFiles?: {
      globs: string[];
      baseDir: string;
    };
    build?: {
      outputDir: string;
      paramValues: Record<string, string[]>;
      exclude: string[];
      previewTimeout: number;
      discover: boolean;
      seedUrls: string[];
      maxPages: number;
      maxDepth: number;
    };
  };
  extract: {
    mainSelector: string;
    dropTags: string[];
    dropSelectors: string[];
    ignoreAttr: string;
    noindexAttr: string;
    respectRobotsNoindex: boolean;
  };
  transform: {
    output: "markdown";
    preserveCodeBlocks: boolean;
    preserveTables: boolean;
  };
  chunking: {
    strategy: "hybrid";
    maxChars: number;
    overlapChars: number;
    minChars: number;
    headingPathDepth: number;
    dontSplitInside: Array<"code" | "table" | "blockquote">;
    prependTitle: boolean;
    pageSummaryChunk: boolean;
  };
  embeddings: {
    provider: EmbeddingProvider;
    model: string;
    apiKeyEnv: string;
    batchSize: number;
    concurrency: number;
    pricePer1kTokens?: number;
  };
  vector: {
    dimension?: number;
    turso: {
      urlEnv: string;
      authTokenEnv: string;
      localPath: string;
    };
  };
  rerank: {
    enabled: boolean;
    topN: number;
    model: string;
  };
  ranking: {
    enableIncomingLinkBoost: boolean;
    enableDepthBoost: boolean;
    pageWeights: Record<string, number>;
    aggregationCap: number;
    aggregationDecay: number;
    minChunkScoreRatio: number;
    weights: {
      incomingLinks: number;
      depth: number;
      rerank: number;
      aggregation: number;
    };
  };
  api: {
    path: string;
    cors: {
      allowOrigins: string[];
    };
    rateLimit?: {
      windowMs: number;
      max: number;
    };
  };
  mcp: {
    enable: boolean;
    transport: "stdio" | "http";
    http: {
      port: number;
      path: string;
    };
  };
  state: {
    dir: string;
    writeMirror: boolean;
  };
}

export interface Scope {
  projectId: string;
  scopeName: string;
  scopeId: string;
}

export interface PageSourceRecord {
  url: string;
  html?: string;
  markdown?: string;
  title?: string;
  sourcePath?: string;
  outgoingLinks: string[];
  tags?: string[];
  routeFile?: string;
  routeResolution?: "exact" | "best-effort";
}

export interface RouteMatch {
  routeFile: string;
  routeResolution: "exact" | "best-effort";
}

export interface ExtractedPage {
  url: string;
  title: string;
  markdown: string;
  outgoingLinks: string[];
  noindex: boolean;
  tags: string[];
  description?: string;
  keywords?: string[];
}

export interface MirrorPage {
  url: string;
  title: string;
  scope: string;
  routeFile: string;
  routeResolution: "exact" | "best-effort";
  generatedAt: string;
  incomingLinks: number;
  outgoingLinks: number;
  depth: number;
  tags: string[];
  markdown: string;
  description?: string;
  keywords?: string[];
}

export interface Chunk {
  chunkKey: string;
  ordinal: number;
  url: string;
  path: string;
  title: string;
  sectionTitle?: string;
  headingPath: string[];
  chunkText: string;
  snippet: string;
  depth: number;
  incomingLinks: number;
  routeFile: string;
  tags: string[];
  contentHash: string;
}

export interface EmbeddingVector {
  vector: number[];
  tokenEstimate: number;
}

export interface VectorRecord {
  id: string;
  vector: number[];
  metadata: {
    projectId: string;
    scopeName: string;
    url: string;
    path: string;
    title: string;
    sectionTitle: string;
    headingPath: string[];
    snippet: string;
    contentHash: string;
    modelId: string;
    depth: number;
    incomingLinks: number;
    routeFile: string;
    tags: string[];
  };
}

export interface QueryOpts {
  topK: number;
  pathPrefix?: string;
  tags?: string[];
}

export interface VectorHit {
  id: string;
  score: number;
  metadata: VectorRecord["metadata"];
}

export interface PageRecord {
  url: string;
  title: string;
  markdown: string;
  projectId: string;
  scopeName: string;
  routeFile: string;
  routeResolution: "exact" | "best-effort";
  incomingLinks: number;
  outgoingLinks: number;
  depth: number;
  tags: string[];
  indexedAt: string;
}

export interface ScopeInfo {
  projectId: string;
  scopeName: string;
  modelId: string;
  lastIndexedAt: string;
  vectorCount?: number;
  lastEstimateTokens?: number;
  lastEstimateCostUSD?: number;
  lastEstimateChangedChunks?: number;
}

export interface VectorStore {
  upsert(records: VectorRecord[], scope: Scope): Promise<void>;
  query(queryVector: number[], opts: QueryOpts, scope: Scope): Promise<VectorHit[]>;
  deleteByIds(ids: string[], scope: Scope): Promise<void>;
  deleteScope(scope: Scope): Promise<void>;
  listScopes(scopeProjectId: string): Promise<ScopeInfo[]>;
  recordScope(info: ScopeInfo): Promise<void>;
  health(): Promise<{ ok: boolean; details?: string }>;
  getContentHashes(scope: Scope): Promise<Map<string, string>>;
  upsertPages(pages: PageRecord[], scope: Scope): Promise<void>;
  getPage(url: string, scope: Scope): Promise<PageRecord | null>;
  deletePages(scope: Scope): Promise<void>;
  getScopeModelId(scope: Scope): Promise<string | null>;
}

export interface EmbeddingsProvider {
  embedTexts(texts: string[], modelId: string, task?: string): Promise<number[][]>;
  estimateTokens(text: string): number;
}

export interface RerankCandidate {
  id: string;
  text: string;
}

export interface Reranker {
  rerank(query: string, candidates: RerankCandidate[], topN?: number): Promise<Array<{ id: string; score: number }>>;
}

export interface SearchRequest {
  q: string;
  topK?: number;
  scope?: string;
  pathPrefix?: string;
  tags?: string[];
  rerank?: boolean;
  groupBy?: "page" | "chunk";
}

export interface SearchResultChunk {
  sectionTitle?: string;
  snippet: string;
  headingPath: string[];
  score: number;
}

export interface SearchResult {
  url: string;
  title: string;
  sectionTitle?: string;
  snippet: string;
  score: number;
  routeFile: string;
  chunks?: SearchResultChunk[];
}

export interface SearchResponse {
  q: string;
  scope: string;
  results: SearchResult[];
  meta: {
    timingsMs: {
      embed: number;
      vector: number;
      rerank: number;
      total: number;
    };
    usedRerank: boolean;
    modelId: string;
  };
}

export interface IndexStats {
  pagesProcessed: number;
  chunksTotal: number;
  chunksChanged: number;
  newEmbeddings: number;
  deletes: number;
  estimatedTokens: number;
  estimatedCostUSD: number;
  routeExact: number;
  routeBestEffort: number;
  stageTimingsMs: Record<string, number>;
}

export interface IndexOptions {
  scopeOverride?: string;
  changedOnly?: boolean;
  force?: boolean;
  dryRun?: boolean;
  sourceOverride?: SourceMode;
  maxPages?: number;
  maxChunks?: number;
  verbose?: boolean;
}

export interface SearchRuntimeOptions {
  configPath?: string;
  cwd?: string;
}

export interface JsonLogEntry {
  event: string;
  ts: string;
  data?: Record<string, unknown>;
}
