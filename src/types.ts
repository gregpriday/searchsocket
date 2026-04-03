export type Awaitable<T> = T | Promise<T>;

export type ScopeMode = "fixed" | "git" | "env";
export type SourceMode = "static-output" | "crawl" | "content-files" | "build";

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
  exclude?: string[];
  respectRobotsTxt?: boolean;
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
    imageDescAttr?: string;
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
  upstash?: {
    url?: string;
    token?: string;
    urlEnv?: string;
    tokenEnv?: string;
  };
  embedding?: {
    model?: string;
    dimensions?: number;
    taskType?: string;
    apiKeyEnv?: string;
    images?: {
      enable?: boolean;
    };
    batchSize?: number;
  };
  search?: {
    dualSearch?: boolean;
    pageSearchWeight?: number;
  };
  ranking?: {
    enableIncomingLinkBoost?: boolean;
    enableDepthBoost?: boolean;
    pageWeights?: Record<string, number>;
    aggregationCap?: number;
    aggregationDecay?: number;
    minChunkScoreRatio?: number;
    minScore?: number;
    scoreGapThreshold?: number;
    weights?: {
      incomingLinks?: number;
      depth?: number;
      aggregation?: number;
      titleMatch?: number;
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
    access?: "public" | "private";
    transport?: "stdio" | "http";
    http?: {
      port?: number;
      path?: string;
      apiKey?: string;
      apiKeyEnv?: string;
    };
    handle?: {
      path?: string;
      apiKey?: string;
      enableJsonResponse?: boolean;
    };
  };
  llmsTxt?: {
    enable?: boolean;
    outputPath?: string;
    title?: string;
    description?: string;
    generateFull?: boolean;
    serveMarkdownVariants?: boolean;
  };
  state?: {
    dir?: string;
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
  exclude: string[];
  respectRobotsTxt: boolean;
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
    imageDescAttr: string;
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
  upstash: {
    url?: string;
    token?: string;
    urlEnv: string;
    tokenEnv: string;
  };
  embedding: {
    model: string;
    dimensions: number;
    taskType: string;
    apiKeyEnv: string;
    images: {
      enable: boolean;
    };
    batchSize: number;
  };
  search: {
    dualSearch: boolean;
    pageSearchWeight: number;
  };
  ranking: {
    enableIncomingLinkBoost: boolean;
    enableDepthBoost: boolean;
    pageWeights: Record<string, number>;
    aggregationCap: number;
    aggregationDecay: number;
    minChunkScoreRatio: number;
    minScore: number;
    scoreGapThreshold: number;
    weights: {
      incomingLinks: number;
      depth: number;
      aggregation: number;
      titleMatch: number;
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
    access: "public" | "private";
    transport: "stdio" | "http";
    http: {
      port: number;
      path: string;
      apiKey?: string;
      apiKeyEnv?: string;
    };
    handle: {
      path: string;
      apiKey?: string;
      enableJsonResponse: boolean;
    };
  };
  llmsTxt: {
    enable: boolean;
    outputPath: string;
    title?: string;
    description?: string;
    generateFull: boolean;
    serveMarkdownVariants: boolean;
  };
  state: {
    dir: string;
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
  weight?: number;
}

export interface IndexedPage {
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
  description?: string;
  keywords?: string[];
}

export interface VectorHit {
  id: string;
  score: number;
  metadata: {
    projectId: string;
    scopeName: string;
    url: string;
    path: string;
    title: string;
    sectionTitle: string;
    headingPath: string[];
    snippet: string;
    chunkText: string;
    ordinal: number;
    contentHash: string;
    depth: number;
    incomingLinks: number;
    routeFile: string;
    tags: string[];
    type?: "chunk" | "page" | "image";
    description?: string;
    keywords?: string[];
    imageSrc?: string;
    imageAlt?: string;
  };
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
  summary?: string;
  description?: string;
  keywords?: string[];
  contentHash?: string;
}

export interface PageHit {
  id: string;
  score: number;
  title: string;
  url: string;
  description: string;
  tags: string[];
  depth: number;
  incomingLinks: number;
  routeFile: string;
}

export interface ScopeInfo {
  projectId: string;
  scopeName: string;
  lastIndexedAt: string;
  documentCount?: number;
}

export interface SearchRequest {
  q: string;
  topK?: number;
  scope?: string;
  pathPrefix?: string;
  tags?: string[];
  groupBy?: "page" | "chunk";
  debug?: boolean;
}

export interface ScoreBreakdown {
  baseScore: number;
  incomingLinkBoost: number;
  depthBoost: number;
  titleMatchBoost: number;
}

export interface SearchResultChunk {
  sectionTitle?: string;
  snippet: string;
  chunkText?: string;
  headingPath: string[];
  score: number;
}

export interface SearchResult {
  url: string;
  title: string;
  sectionTitle?: string;
  snippet: string;
  chunkText?: string;
  score: number;
  routeFile: string;
  chunks?: SearchResultChunk[];
  breakdown?: ScoreBreakdown;
}

export interface SearchResponse {
  q: string;
  scope: string;
  results: SearchResult[];
  meta: {
    timingsMs: {
      search: number;
      total: number;
    };
  };
}

export interface IndexStats {
  pagesProcessed: number;
  pagesChanged: number;
  pagesDeleted: number;
  chunksTotal: number;
  chunksChanged: number;
  documentsUpserted: number;
  deletes: number;
  routeExact: number;
  routeBestEffort: number;
  stageTimingsMs: Record<string, number>;
}

export interface IndexingHooks {
  transformPage?: (page: ExtractedPage) => Awaitable<ExtractedPage | null>;
  transformChunk?: (chunk: Chunk) => Awaitable<Chunk | null>;
  beforeIndex?: (chunks: Chunk[]) => Awaitable<Chunk[]>;
  afterIndex?: (stats: IndexStats) => Awaitable<void>;
}

export interface CustomRecord {
  url: string;
  title: string;
  content: string;
  metadata?: Record<string, string>;
  tags?: string[];
  weight?: number;
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
  customRecords?: CustomRecord[];
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

export interface SiteTreeNode {
  url: string;
  title: string;
  depth: number;
  routeFile: string;
  isIndexed: boolean;
  childCount: number;
  children: SiteTreeNode[];
}

export interface SiteStructureResult {
  root: SiteTreeNode;
  totalPages: number;
  truncated: boolean;
}
