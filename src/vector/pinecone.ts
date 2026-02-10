import { Pinecone } from "@pinecone-database/pinecone";
import type {
  QueryOpts,
  Scope,
  ScopeInfo,
  VectorHit,
  VectorRecord,
  VectorStore
} from "../types";

const REGISTRY_NAMESPACE = "_searchsocket_registry";
/**
 * Maximum path segments stored as dir0..dirN metadata keys for prefix filtering.
 * Paths deeper than 8 levels will only be filterable up to this depth. This is
 * sufficient for virtually all SvelteKit route structures.
 */
const MAX_DIR_SEGMENTS = 8;

/**
 * Maximum bytes for the snippet metadata field. Pinecone enforces a 40KB per-record
 * metadata limit. With other fields (tags, headingPath, dir filters), keeping the
 * snippet under 8KB leaves ample room for everything else.
 */
const MAX_SNIPPET_BYTES = 8_000;

/**
 * Pinecone hard limit for total metadata per record (40KB).
 * We aim for 38KB to leave a safety margin.
 */
const MAX_TOTAL_METADATA_BYTES = 38_000;

/**
 * Fallback dimensions used when describeIndexStats fails (e.g. on Starter pods).
 * If using a model not listed here, the actual vector length from the first
 * upsert/query call takes precedence. This map only affects zero-vector
 * operations like registry record storage.
 */
const FALLBACK_DIMENSIONS: Record<string, number> = {
  "text-embedding-3-small": 1536,
  "text-embedding-3-large": 3072,
  "text-embedding-ada-002": 1536
};

interface PineconeMetadata {
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
  [key: string]: string | number | string[];
}

interface PineconeLikeIndex {
  upsert(options: {
    records: Array<{ id: string; values: number[]; metadata?: PineconeMetadata }>;
    namespace?: string;
  }): Promise<void>;
  query(options: {
    vector: number[];
    topK: number;
    includeMetadata?: boolean;
    filter?: Record<string, unknown>;
    namespace?: string;
  }): Promise<{
    matches: Array<{
      id?: string;
      score?: number;
      metadata?: Record<string, unknown>;
    }>;
  }>;
  deleteMany(options: { ids?: string[]; filter?: Record<string, unknown>; namespace?: string }): Promise<void>;
  deleteAll(options?: { namespace?: string }): Promise<void>;
  describeIndexStats(options?: { filter?: Record<string, unknown> }): Promise<{
    dimension?: number;
    namespaces?: Record<string, { recordCount?: number }>;
  }>;
  listPaginated(options?: {
    namespace?: string;
    prefix?: string;
    paginationToken?: string;
    limit?: number;
  }): Promise<{
    vectors?: Array<{ id?: string }>;
    pagination?: { next?: string };
  }>;
  fetch(options: { ids: string[]; namespace?: string }): Promise<{
    records: Record<string, { id?: string; metadata?: Record<string, unknown> }>;
  }>;
}

export interface PineconeVectorStoreOptions {
  apiKey: string;
  indexName: string;
  embeddingModel: string;
  dimension?: number;
  client?: Pinecone;
  index?: PineconeLikeIndex;
}

function toDirFilters(pathValue: string): Record<string, string> {
  const segments = pathValue
    .split("/")
    .filter(Boolean)
    .slice(0, MAX_DIR_SEGMENTS);

  const out: Record<string, string> = {};
  for (let i = 0; i < segments.length; i += 1) {
    out[`dir${i}`] = segments[i] ?? "";
  }
  return out;
}

function buildPrefixFilter(pathPrefix?: string): Record<string, unknown> {
  if (!pathPrefix || pathPrefix === "/") {
    return {};
  }

  const normalized = pathPrefix.startsWith("/") ? pathPrefix : `/${pathPrefix}`;
  const dirFilters = toDirFilters(normalized);

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(dirFilters)) {
    out[key] = { $eq: value };
  }

  return out;
}

function buildQueryFilter(scope: Scope, opts: QueryOpts): Record<string, unknown> {
  const clauses: Array<Record<string, unknown>> = [
    {
      projectId: { $eq: scope.projectId }
    },
    {
      scopeName: { $eq: scope.scopeName }
    }
  ];

  const prefixFilters = buildPrefixFilter(opts.pathPrefix);
  for (const [key, value] of Object.entries(prefixFilters)) {
    clauses.push({ [key]: value });
  }

  for (const tag of opts.tags ?? []) {
    clauses.push({
      tags: {
        $in: [tag]
      }
    });
  }

  return { $and: clauses };
}

function toRegistryId(projectId: string, scopeName: string): string {
  return `${projectId}:${scopeName}`;
}

export class PineconeVectorStore implements VectorStore {
  private readonly client: Pinecone;
  private readonly index: PineconeLikeIndex;
  private readonly embeddingModel: string;
  private readonly configuredDimension?: number;
  private dimension?: number;

  constructor(options: PineconeVectorStoreOptions) {
    this.client = options.client ?? new Pinecone({ apiKey: options.apiKey });
    this.index = options.index ?? (this.client.index({ name: options.indexName }) as unknown as PineconeLikeIndex);
    this.embeddingModel = options.embeddingModel;
    this.configuredDimension = options.dimension;
  }

  async upsert(records: VectorRecord[], scope: Scope): Promise<void> {
    if (records.length === 0) {
      return;
    }

    await this.ensureDimension(records[0]?.vector.length);

    const formatted = records.map((record) => {
      const dirFilters = toDirFilters(record.metadata.path);
      let snippet = Buffer.byteLength(record.metadata.snippet, "utf8") > MAX_SNIPPET_BYTES
        ? record.metadata.snippet.slice(0, MAX_SNIPPET_BYTES)
        : record.metadata.snippet;

      const metadata: PineconeMetadata = {
        projectId: record.metadata.projectId,
        scopeName: record.metadata.scopeName,
        url: record.metadata.url,
        path: record.metadata.path,
        title: record.metadata.title,
        sectionTitle: record.metadata.sectionTitle,
        headingPath: record.metadata.headingPath,
        snippet,
        contentHash: record.metadata.contentHash,
        modelId: record.metadata.modelId,
        depth: record.metadata.depth,
        incomingLinks: record.metadata.incomingLinks,
        routeFile: record.metadata.routeFile,
        tags: record.metadata.tags,
        ...dirFilters
      };

      // Safety check: if total metadata exceeds Pinecone's limit, truncate snippet further
      let totalBytes = Buffer.byteLength(JSON.stringify(metadata), "utf8");
      if (totalBytes > MAX_TOTAL_METADATA_BYTES) {
        const excess = totalBytes - MAX_TOTAL_METADATA_BYTES;
        snippet = snippet.slice(0, Math.max(0, snippet.length - excess - 100));
        metadata.snippet = snippet;
      }

      return {
        id: record.id,
        values: record.vector,
        metadata
      };
    });

    const BATCH_SIZE = 100;
    for (let i = 0; i < formatted.length; i += BATCH_SIZE) {
      await this.index.upsert({
        namespace: scope.scopeName,
        records: formatted.slice(i, i + BATCH_SIZE)
      });
    }
  }

  async query(queryVector: number[], opts: QueryOpts, scope: Scope): Promise<VectorHit[]> {
    await this.ensureDimension(queryVector.length);

    const filter = buildQueryFilter(scope, opts);

    const response = await this.index.query({
      namespace: scope.scopeName,
      vector: queryVector,
      topK: opts.topK,
      includeMetadata: true,
      filter
    });

    return (response.matches ?? []).flatMap((match) => {
      const metadata = match.metadata;
      const id = match.id;

      if (!metadata || typeof id !== "string") {
        return [];
      }

      const headingPathRaw = metadata.headingPath;
      const tagsRaw = metadata.tags;

      const headingPath = Array.isArray(headingPathRaw)
        ? headingPathRaw.filter((value): value is string => typeof value === "string")
        : [];

      const tags = Array.isArray(tagsRaw)
        ? tagsRaw.filter((value): value is string => typeof value === "string")
        : [];

      return [
        {
          id,
          score: match.score ?? 0,
          metadata: {
            projectId: String(metadata.projectId ?? scope.projectId),
            scopeName: String(metadata.scopeName ?? scope.scopeName),
            url: String(metadata.url ?? ""),
            path: String(metadata.path ?? metadata.url ?? ""),
            title: String(metadata.title ?? ""),
            sectionTitle: String(metadata.sectionTitle ?? ""),
            headingPath,
            snippet: String(metadata.snippet ?? ""),
            contentHash: String(metadata.contentHash ?? ""),
            modelId: String(metadata.modelId ?? this.embeddingModel),
            depth: Number(metadata.depth ?? 0),
            incomingLinks: Number(metadata.incomingLinks ?? 0),
            routeFile: String(metadata.routeFile ?? "src/routes/+page.svelte"),
            tags
          }
        } satisfies VectorHit
      ];
    });
  }

  async deleteByIds(ids: string[], scope: Scope): Promise<void> {
    if (ids.length === 0) {
      return;
    }

    const DELETE_BATCH = 1000;
    for (let i = 0; i < ids.length; i += DELETE_BATCH) {
      await this.index.deleteMany({
        namespace: scope.scopeName,
        ids: ids.slice(i, i + DELETE_BATCH)
      });
    }
  }

  async deleteScope(scope: Scope): Promise<void> {
    await this.index.deleteAll({ namespace: scope.scopeName });

    await this.index.deleteMany({
      namespace: REGISTRY_NAMESPACE,
      ids: [toRegistryId(scope.projectId, scope.scopeName)]
    });
  }

  async listScopes(scopeProjectId: string): Promise<ScopeInfo[]> {
    const ids: string[] = [];

    try {
      let token: string | undefined;

      do {
        const page = await this.index.listPaginated({
          namespace: REGISTRY_NAMESPACE,
          prefix: `${scopeProjectId}:`,
          paginationToken: token,
          limit: 100
        });

        for (const vector of page.vectors ?? []) {
          if (vector.id) {
            ids.push(vector.id);
          }
        }
        token = page.pagination?.next;
      } while (token);
    } catch {
      // Fallback when list is unavailable (e.g., pod-based indexes).
      const dim = await this.ensureDimension();
      const queried = await this.index.query({
        namespace: REGISTRY_NAMESPACE,
        vector: new Array(dim).fill(0),
        topK: 1000,
        includeMetadata: true,
        filter: {
          projectId: { $eq: scopeProjectId }
        }
      });

      return (queried.matches ?? []).flatMap((match) => {
        const metadata = match.metadata;
        if (!metadata) {
          return [];
        }

        return [
          {
            projectId: String(metadata.projectId ?? scopeProjectId),
            scopeName: String(metadata.scopeName ?? "main"),
            modelId: String(metadata.modelId ?? this.embeddingModel),
            lastIndexedAt: String(metadata.lastIndexedAt ?? new Date(0).toISOString()),
            vectorCount: Number(metadata.vectorCount ?? 0)
          } satisfies ScopeInfo
        ];
      });
    }

    if (ids.length === 0) {
      return [];
    }

    const scopes: ScopeInfo[] = [];

    for (let i = 0; i < ids.length; i += 100) {
      const batch = ids.slice(i, i + 100);
      const fetched = await this.index.fetch({
        namespace: REGISTRY_NAMESPACE,
        ids: batch
      });

      for (const id of batch) {
        const record = fetched.records[id];
        const metadata = record?.metadata;
        if (!metadata) {
          continue;
        }

        scopes.push({
          projectId: String(metadata.projectId ?? scopeProjectId),
          scopeName: String(metadata.scopeName ?? id.split(":").slice(1).join(":") ?? "main"),
          modelId: String(metadata.modelId ?? this.embeddingModel),
          lastIndexedAt: String(metadata.lastIndexedAt ?? new Date(0).toISOString()),
          vectorCount: Number(metadata.vectorCount ?? 0)
        });
      }
    }

    return scopes;
  }

  async recordScope(info: ScopeInfo): Promise<void> {
    const dim = await this.ensureDimension();

    await this.index.upsert({
      namespace: REGISTRY_NAMESPACE,
      records: [
        {
          id: toRegistryId(info.projectId, info.scopeName),
          values: new Array(dim).fill(0),
          metadata: {
            projectId: info.projectId,
            scopeName: info.scopeName,
            modelId: info.modelId,
            lastIndexedAt: info.lastIndexedAt,
            vectorCount: info.vectorCount ?? 0,
            tags: [],
            url: "",
            path: "",
            title: "",
            sectionTitle: "",
            headingPath: [],
            snippet: "",
            contentHash: "",
            depth: 0,
            incomingLinks: 0,
            routeFile: ""
          }
        }
      ]
    });
  }

  async health(): Promise<{ ok: boolean; details?: string }> {
    try {
      await this.index.describeIndexStats();
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        details: error instanceof Error ? error.message : "Pinecone unavailable"
      };
    }
  }

  private async ensureDimension(explicit?: number): Promise<number> {
    if (explicit && explicit > 0) {
      this.dimension = explicit;
      return explicit;
    }

    if (this.dimension && this.dimension > 0) {
      return this.dimension;
    }

    try {
      const stats = await this.index.describeIndexStats();
      const dimension = Number(stats.dimension ?? 0);
      if (dimension > 0) {
        this.dimension = dimension;
        return dimension;
      }
    } catch {
      // fallback to model map
    }

    if (this.configuredDimension && this.configuredDimension > 0) {
      this.dimension = this.configuredDimension;
      return this.configuredDimension;
    }

    const fallback = FALLBACK_DIMENSIONS[this.embeddingModel] ?? FALLBACK_DIMENSIONS["text-embedding-3-small"] ?? 1536;
    this.dimension = fallback;
    return fallback;
  }
}
