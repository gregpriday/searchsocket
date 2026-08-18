import { QueryMode, FusionAlgorithm } from "@upstash/vector";
import type { Index } from "@upstash/vector";
import type {
  PageHit,
  PageRecord,
  Scope,
  ScopeInfo,
  VectorHit
} from "../types";
import { SearchSocketError } from "../errors";
import {
  INDEX_SCHEMA_VERSION,
  chunkId,
  filterStringLiteral,
  groupFilter,
  logicalKeyFromId,
  pageId,
  recordBelongsToScope,
  recordPrefix,
  scopeFilterClauses,
  urlFromPageId
} from "./ids";

/** Flat metadata stored alongside each chunk vector in Upstash Vector */
interface ChunkVectorMetadata {
  projectId: string;
  scopeName: string;
  /** Identity-layout version; see INDEX_SCHEMA_VERSION. */
  schemaVersion?: number;
  /** Logical chunk key, i.e. the record ID minus its scope prefix. */
  chunkKey?: string;
  type: string;
  url: string;
  path: string;
  title: string;
  sectionTitle: string;
  headingPath: string;
  snippet: string;
  chunkText: string;
  tags: string[];
  ordinal: number;
  contentHash: string;
  depth: number;
  incomingLinks: number;
  routeFile: string;
  description: string;
  keywords: string[];
  publishedAt?: number | null;
  incomingAnchorText: string;
  [key: string]: unknown;
}

/** Flat metadata stored alongside each page vector in Upstash Vector */
interface PageVectorMetadata {
  projectId: string;
  scopeName: string;
  /** Identity-layout version; see INDEX_SCHEMA_VERSION. */
  schemaVersion?: number;
  type: string;
  title: string;
  url: string;
  description: string;
  keywords: string[];
  summary: string;
  tags: string[];
  routeFile: string;
  routeResolution: string;
  incomingLinks: number;
  outgoingLinks: number;
  outgoingLinkUrls?: string[];
  depth: number;
  indexedAt: string;
  contentHash: string;
  publishedAt?: number | null;
  [key: string]: unknown;
}

/**
 * Reassemble page markdown from ordered chunks.
 * Strips the title prefix added by buildEmbeddingText() from each chunk.
 */
function reconstructMarkdownFromChunks(
  chunks: Array<{ chunkText: string; ordinal: number; sectionTitle: string; headingPath: string[] }>,
  pageTitle: string
): string {
  if (chunks.length === 0) return "";

  const parts: string[] = [];

  for (const chunk of chunks) {
    let text = chunk.chunkText;

    // Strip the prepended title prefix added by buildEmbeddingText().
    // Format is: "{pageTitle} — {sectionTitle}\n\n{content}" or "{pageTitle}\n\n{content}"
    const prefixWithSection = `${pageTitle} — ${chunk.sectionTitle}\n\n`;
    const prefixWithoutSection = `${pageTitle}\n\n`;

    if (chunk.sectionTitle && text.startsWith(prefixWithSection)) {
      text = text.slice(prefixWithSection.length);
    } else if (text.startsWith(prefixWithoutSection)) {
      text = text.slice(prefixWithoutSection.length);
    }

    parts.push(text.trim());
  }

  return parts.join("\n\n");
}

export interface UpstashSearchStoreOptions {
  index: Index;
  pagesNamespace: string;
  chunksNamespace: string;
}

/**
 * Distinguish "this namespace has never been written to" from every other
 * backend failure. Only the former may be treated as empty state — an auth
 * error, timeout, or rate limit reported as "no records" can drive a caller
 * into deleting a perfectly healthy index.
 */
export function isMissingNamespaceError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /namespace .*(not found|does not exist)|no such namespace/i.test(message);
}

export class UpstashSearchStore {
  private readonly index: Index;
  private readonly pagesNs: ReturnType<Index["namespace"]>;
  private readonly chunksNs: ReturnType<Index["namespace"]>;

  constructor(opts: UpstashSearchStoreOptions) {
    this.index = opts.index;
    this.pagesNs = opts.index.namespace(opts.pagesNamespace);
    this.chunksNs = opts.index.namespace(opts.chunksNamespace);
  }

  async upsertChunks(
    chunks: Array<{
      id: string;
      data: string;
      metadata: Record<string, unknown>;
    }>,
    scope: Scope
  ): Promise<void> {
    if (chunks.length === 0) return;

    const BATCH_SIZE = 90;
    for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
      const batch = chunks.slice(i, i + BATCH_SIZE);
      await this.chunksNs.upsert(
        // `c.id` is the logical chunk key; the physical record ID carries the
        // project, scope, and schema version so two tenants sharing one index
        // cannot overwrite each other.
        batch.map((c) => ({
          id: chunkId(scope, c.id),
          data: c.data,
          metadata: {
            ...c.metadata,
            chunkKey: c.id,
            projectId: scope.projectId,
            scopeName: scope.scopeName,
            schemaVersion: INDEX_SCHEMA_VERSION,
            type: (c.metadata.type as string) || "chunk"
          }
        }))
      );
    }
  }

  async search(
    data: string,
    opts: {
      limit: number;
      filter?: string;
    },
    scope: Scope
  ): Promise<VectorHit[]> {
    const filterParts = [...scopeFilterClauses(scope)];
    if (opts.filter) {
      filterParts.push(groupFilter(opts.filter));
    }

    const results = await this.chunksNs.query<ChunkVectorMetadata>({
      data,
      topK: opts.limit,
      includeMetadata: true,
      filter: filterParts.join(" AND "),
      queryMode: QueryMode.HYBRID,
      fusionAlgorithm: FusionAlgorithm.DBSF
    });

    return results
      // Defence in depth: the server-side filter should already have excluded
      // these, but a filter-syntax surprise must not leak another tenant's
      // record into results.
      .filter((doc) => recordBelongsToScope(doc.metadata, scope))
      .map((doc) => ({
      // Logical chunk key, so the value round-trips back into deleteByIds().
      id: logicalKeyFromId(String(doc.id), scope, "chunk") ?? String(doc.id),
      score: doc.score,
      metadata: {
        projectId: doc.metadata?.projectId ?? "",
        scopeName: doc.metadata?.scopeName ?? "",
        url: doc.metadata?.url ?? "",
        path: doc.metadata?.path ?? "",
        title: doc.metadata?.title ?? "",
        sectionTitle: doc.metadata?.sectionTitle ?? "",
        headingPath: doc.metadata?.headingPath
          ? String(doc.metadata.headingPath).split(" > ").filter(Boolean)
          : [],
        snippet: doc.metadata?.snippet ?? "",
        chunkText: doc.metadata?.chunkText ?? "",
        ordinal: doc.metadata?.ordinal ?? 0,
        contentHash: doc.metadata?.contentHash ?? "",
        depth: doc.metadata?.depth ?? 0,
        incomingLinks: doc.metadata?.incomingLinks ?? 0,
        routeFile: doc.metadata?.routeFile ?? "",
        tags: doc.metadata?.tags ?? [],
        description: doc.metadata?.description || undefined,
        keywords: doc.metadata?.keywords?.length
          ? doc.metadata.keywords
          : undefined,
        publishedAt: typeof doc.metadata?.publishedAt === "number" ? doc.metadata.publishedAt : undefined,
        incomingAnchorText: doc.metadata?.incomingAnchorText || undefined
      }
    }));
  }

  async searchChunksByUrl(
    data: string,
    url: string,
    opts: {
      limit: number;
      filter?: string;
    },
    scope: Scope
  ): Promise<VectorHit[]> {
    const filterParts = [...scopeFilterClauses(scope)];

    // A URL containing a quote or backslash cannot be expressed as a filter
    // literal, because Upstash defines no escape sequence for either. Rather
    // than fail — the page is perfectly valid, e.g. /blog/it's-here — fall back
    // to over-fetching and matching the URL locally.
    let urlFilterable = true;
    try {
      filterParts.push(`url = ${filterStringLiteral(url, "url")}`);
    } catch {
      urlFilterable = false;
    }

    if (opts.filter) {
      filterParts.push(groupFilter(opts.filter));
    }

    const results = await this.chunksNs.query<ChunkVectorMetadata>({
      data,
      topK: urlFilterable ? opts.limit : Math.min(opts.limit * 10, 200),
      includeMetadata: true,
      filter: filterParts.join(" AND "),
      queryMode: QueryMode.HYBRID,
      fusionAlgorithm: FusionAlgorithm.DBSF
    });

    return results
      // Defence in depth: the server-side filter should already have excluded
      // these, but a filter-syntax surprise must not leak another tenant's
      // record into results. The URL is always re-checked locally so the
      // unfilterable-URL fallback above cannot return another page's chunks.
      .filter((doc) => recordBelongsToScope(doc.metadata, scope) && doc.metadata?.url === url)
      .slice(0, opts.limit)
      .map((doc) => ({
      // Logical chunk key, so the value round-trips back into deleteByIds().
      id: logicalKeyFromId(String(doc.id), scope, "chunk") ?? String(doc.id),
      score: doc.score,
      metadata: {
        projectId: doc.metadata?.projectId ?? "",
        scopeName: doc.metadata?.scopeName ?? "",
        url: doc.metadata?.url ?? "",
        path: doc.metadata?.path ?? "",
        title: doc.metadata?.title ?? "",
        sectionTitle: doc.metadata?.sectionTitle ?? "",
        headingPath: doc.metadata?.headingPath
          ? String(doc.metadata.headingPath).split(" > ").filter(Boolean)
          : [],
        snippet: doc.metadata?.snippet ?? "",
        chunkText: doc.metadata?.chunkText ?? "",
        ordinal: doc.metadata?.ordinal ?? 0,
        contentHash: doc.metadata?.contentHash ?? "",
        depth: doc.metadata?.depth ?? 0,
        incomingLinks: doc.metadata?.incomingLinks ?? 0,
        routeFile: doc.metadata?.routeFile ?? "",
        tags: doc.metadata?.tags ?? [],
        description: doc.metadata?.description || undefined,
        keywords: doc.metadata?.keywords?.length
          ? doc.metadata.keywords
          : undefined,
        publishedAt: typeof doc.metadata?.publishedAt === "number" ? doc.metadata.publishedAt : undefined,
        incomingAnchorText: doc.metadata?.incomingAnchorText || undefined
      }
    }));
  }

  async searchPagesByText(
    data: string,
    opts: {
      limit: number;
      filter?: string;
    },
    scope: Scope
  ): Promise<PageHit[]> {
    return this.queryPages({ data }, opts, scope);
  }

  async searchPagesByVector(
    vector: number[],
    opts: {
      limit: number;
      filter?: string;
    },
    scope: Scope
  ): Promise<PageHit[]> {
    return this.queryPages({ vector }, opts, scope);
  }

  private async queryPages(
    input: { data: string } | { vector: number[] },
    opts: {
      limit: number;
      filter?: string;
    },
    scope: Scope
  ): Promise<PageHit[]> {
    const filterParts = [...scopeFilterClauses(scope)];
    if (opts.filter) {
      filterParts.push(groupFilter(opts.filter));
    }

    let results;
    try {
      results = await this.pagesNs.query<PageVectorMetadata>({
        ...input,
        topK: opts.limit,
        includeMetadata: true,
        filter: filterParts.join(" AND "),
        queryMode: QueryMode.HYBRID,
        fusionAlgorithm: FusionAlgorithm.DBSF
      });
    } catch {
      return [];
    }

    return results
      .filter((doc) => recordBelongsToScope(doc.metadata, scope))
      .map((doc) => ({
      // Page URL, so the value round-trips back into deletePagesByIds().
      id: doc.metadata?.url ?? urlFromPageId(String(doc.id), scope) ?? String(doc.id),
      score: doc.score,
      title: doc.metadata?.title ?? "",
      url: doc.metadata?.url ?? "",
      description: doc.metadata?.description ?? "",
      tags: doc.metadata?.tags ?? [],
      depth: doc.metadata?.depth ?? 0,
      incomingLinks: doc.metadata?.incomingLinks ?? 0,
      routeFile: doc.metadata?.routeFile ?? "",
      publishedAt: typeof doc.metadata?.publishedAt === "number" ? doc.metadata.publishedAt : undefined
    }));
  }

  /** `keys` are logical chunk keys, not physical record IDs. */
  async deleteByIds(keys: string[], scope: Scope): Promise<void> {
    if (keys.length === 0) return;

    const BATCH_SIZE = 90;
    for (let i = 0; i < keys.length; i += BATCH_SIZE) {
      const batch = keys.slice(i, i + BATCH_SIZE);
      // Encoding here means a caller cannot delete outside its own scope even
      // if it passes an arbitrary key.
      await this.chunksNs.delete(batch.map((key) => chunkId(scope, key)));
    }
  }

  async deleteScope(scope: Scope): Promise<void> {
    // Scan both namespaces for vectors matching this scope, then delete
    for (const [ns, type] of [
      [this.chunksNs, "chunk"],
      [this.pagesNs, "page"]
    ] as const) {
      const ids: string[] = [];
      let cursor = "0";
      try {
        for (;;) {
          const result = await ns.range<ChunkVectorMetadata>({
            cursor,
            prefix: recordPrefix(scope, type),
            limit: 100,
            includeMetadata: true
          });
          for (const doc of result.vectors) {
            if (
              recordBelongsToScope(doc.metadata, scope)
            ) {
              ids.push(String(doc.id));
            }
          }
          if (!result.nextCursor || result.nextCursor === "0") break;
          cursor = result.nextCursor;
        }
      } catch {
        // Namespace may not exist yet
      }

      if (ids.length > 0) {
        const BATCH_SIZE = 90;
        for (let i = 0; i < ids.length; i += BATCH_SIZE) {
          const batch = ids.slice(i, i + BATCH_SIZE);
          await ns.delete(batch);
        }
      }
    }
  }

  async listScopes(projectId: string): Promise<ScopeInfo[]> {
    const scopeMap = new Map<string, number>();
    // Latest `indexedAt` actually observed on a page record for each scope.
    // Previously this method stamped `new Date()` on every scope, which made
    // every scope look freshly indexed and rendered TTL pruning meaningless.
    const lastIndexed = new Map<string, string>();

    for (const ns of [this.chunksNs, this.pagesNs]) {
      let cursor = "0";
      try {
        for (;;) {
          const result = await ns.range<ChunkVectorMetadata & { indexedAt?: string }>({
            cursor,
            limit: 100,
            includeMetadata: true
          });
          for (const doc of result.vectors) {
            if (doc.metadata?.projectId === projectId) {
              const scopeName = doc.metadata.scopeName ?? "";
              scopeMap.set(scopeName, (scopeMap.get(scopeName) ?? 0) + 1);

              const indexedAt = doc.metadata.indexedAt;
              if (typeof indexedAt === "string" && !Number.isNaN(Date.parse(indexedAt))) {
                const current = lastIndexed.get(scopeName);
                if (!current || Date.parse(indexedAt) > Date.parse(current)) {
                  lastIndexed.set(scopeName, indexedAt);
                }
              }
            }
          }
          if (!result.nextCursor || result.nextCursor === "0") break;
          cursor = result.nextCursor;
        }
      } catch (error) {
        // A namespace that has never been written to is genuinely absent and
        // contributes nothing. Any other failure means this listing is
        // incomplete, and callers such as `prune` make deletion decisions from
        // it — so surface it rather than reporting a truncated scope list.
        if (!isMissingNamespaceError(error)) {
          throw new SearchSocketError(
            "VECTOR_BACKEND_UNAVAILABLE",
            `Failed to list scopes for project "${projectId}": ${error instanceof Error ? error.message : String(error)}`,
            { cause: error }
          );
        }
      }
    }

    return [...scopeMap.entries()].map(([scopeName, count]) => ({
      projectId,
      scopeName,
      // "unknown" is truthful: no page record in this scope carried a
      // parseable indexedAt. Callers must not treat it as "old".
      lastIndexedAt: lastIndexed.get(scopeName) ?? "unknown",
      documentCount: count
    }));
  }

  async getContentHashes(scope: Scope): Promise<Map<string, string>> {
    return this.scanHashes(this.chunksNs, scope);
  }

  /**
   * Fetch content hashes for a specific set of chunk keys using direct fetch()
   * instead of range(). This avoids potential issues with range() returning
   * vectors from the wrong namespace on hybrid indexes.
   */
  async fetchContentHashesForKeys(keys: string[], scope: Scope): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    if (keys.length === 0) return map;

    const BATCH_SIZE = 90;
    for (let i = 0; i < keys.length; i += BATCH_SIZE) {
      const batch = keys.slice(i, i + BATCH_SIZE);
      try {
        const results = await this.chunksNs.fetch<ChunkVectorMetadata>(
          batch.map((key) => chunkId(scope, key)),
          { includeMetadata: true }
        );
        for (const doc of results) {
          // A direct fetch bypasses the metadata filter, so verify ownership
          // explicitly rather than trusting the ID.
          if (doc && recordBelongsToScope(doc.metadata, scope) && doc.metadata?.contentHash) {
            const key = logicalKeyFromId(String(doc.id), scope, "chunk");
            if (key !== null) map.set(key, doc.metadata.contentHash);
          }
        }
      } catch (error) {
        if (!isMissingNamespaceError(error)) throw error;
      }
    }

    return map;
  }

  /**
   * Scan all IDs in the chunks namespace for this scope.
   * Used for deletion detection (finding stale chunk keys).
   */
  async scanChunkIds(scope: Scope): Promise<Set<string>> {
    const ids = new Set<string>();
    let cursor = "0";

    try {
      for (;;) {
        // Scoped by ID prefix so the scan costs what this scope holds rather
        // than what every project sharing the index holds.
        const result = await this.chunksNs.range<ChunkVectorMetadata>({
          cursor,
          prefix: recordPrefix(scope, "chunk"),
          limit: 100,
          includeMetadata: true
        });
        for (const doc of result.vectors) {
          if (!recordBelongsToScope(doc.metadata, scope)) continue;
          const key = logicalKeyFromId(String(doc.id), scope, "chunk");
          if (key !== null) ids.add(key);
        }
        if (!result.nextCursor || result.nextCursor === "0") break;
        cursor = result.nextCursor;
      }
    } catch (error) {
      if (!isMissingNamespaceError(error)) throw error;
    }

    return ids;
  }

  private async scanHashes(
    ns: ReturnType<Index["namespace"]>,
    scope: Scope
  ): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    let cursor = "0";

    try {
      for (;;) {
        const result = await ns.range<ChunkVectorMetadata>({
          cursor,
          prefix: recordPrefix(scope, "chunk"),
          limit: 100,
          includeMetadata: true
        });
        for (const doc of result.vectors) {
          if (!recordBelongsToScope(doc.metadata, scope) || !doc.metadata?.contentHash) continue;
          // Keyed by logical chunk key so the result is comparable with the
          // keys the chunker produces, rather than by physical record ID.
          const key = logicalKeyFromId(String(doc.id), scope, "chunk");
          if (key !== null) map.set(key, doc.metadata.contentHash);
        }
        if (!result.nextCursor || result.nextCursor === "0") break;
        cursor = result.nextCursor;
      }
    } catch {
      // Namespace may not exist yet
    }

    return map;
  }

  async listPages(
    scope: Scope,
    opts?: { cursor?: string; limit?: number; pathPrefix?: string }
  ): Promise<{
    pages: Array<{ url: string; title: string; description: string; routeFile: string }>;
    nextCursor?: string;
  }> {
    const cursor = opts?.cursor ?? "0";
    const limit = opts?.limit ?? 50;

    try {
      const result = await this.pagesNs.range<PageVectorMetadata>({
        cursor,
        prefix: recordPrefix(scope, "page"),
        limit,
        includeMetadata: true
      });

      const pages = result.vectors
        .filter(
          (doc) =>
            recordBelongsToScope(doc.metadata, scope) &&
            (!opts?.pathPrefix || (doc.metadata?.url ?? "").startsWith(opts.pathPrefix))
        )
        .map((doc) => ({
          url: doc.metadata?.url ?? "",
          title: doc.metadata?.title ?? "",
          description: doc.metadata?.description ?? "",
          routeFile: doc.metadata?.routeFile ?? ""
        }));

      const response: {
        pages: Array<{ url: string; title: string; description: string; routeFile: string }>;
        nextCursor?: string;
      } = { pages };

      if (result.nextCursor && result.nextCursor !== "0") {
        response.nextCursor = result.nextCursor;
      }

      return response;
    } catch {
      return { pages: [] };
    }
  }

  async getPageHashes(scope: Scope): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    let cursor = "0";

    try {
      for (;;) {
        const result = await this.pagesNs.range<PageVectorMetadata>({
          cursor,
          prefix: recordPrefix(scope, "page"),
          limit: 100,
          includeMetadata: true
        });
        for (const doc of result.vectors) {
          if (!recordBelongsToScope(doc.metadata, scope) || !doc.metadata?.contentHash) continue;
          // Keyed by URL: callers reason about pages by URL, and the physical
          // ID is an encoding detail of this store.
          const url = doc.metadata.url ?? urlFromPageId(String(doc.id), scope);
          if (url) map.set(url, doc.metadata.contentHash);
        }
        if (!result.nextCursor || result.nextCursor === "0") break;
        cursor = result.nextCursor;
      }
    } catch (error) {
      // A genuinely absent namespace means no pages are indexed yet. Anything
      // else would make this look like an empty index, and the pipeline treats
      // an empty page inventory as "nothing to compare against".
      if (!isMissingNamespaceError(error)) {
        throw new SearchSocketError(
          "VECTOR_BACKEND_UNAVAILABLE",
          `Failed to read page hashes for scope "${scope.scopeName}": ${error instanceof Error ? error.message : String(error)}`,
          { cause: error }
        );
      }
    }

    return map;
  }

  /** `urls` are page URLs, not physical record IDs. */
  async deletePagesByIds(urls: string[], scope: Scope): Promise<void> {
    if (urls.length === 0) return;

    const BATCH_SIZE = 90;
    for (let i = 0; i < urls.length; i += BATCH_SIZE) {
      const batch = urls.slice(i, i + BATCH_SIZE);
      await this.pagesNs.delete(batch.map((url) => pageId(scope, url)));
    }
  }

  async upsertPages(
    pages: Array<{
      id: string;
      data: string;
      metadata: Record<string, unknown>;
    }>,
    scope: Scope
  ): Promise<void> {
    if (pages.length === 0) return;

    const BATCH_SIZE = 90;
    for (let i = 0; i < pages.length; i += BATCH_SIZE) {
      const batch = pages.slice(i, i + BATCH_SIZE);
      await this.pagesNs.upsert(
        // `p.id` is the page URL; the physical record ID carries project,
        // scope, and schema version.
        batch.map((p) => ({
          id: pageId(scope, p.id),
          data: p.data,
          metadata: {
            ...p.metadata,
            projectId: scope.projectId,
            scopeName: scope.scopeName,
            schemaVersion: INDEX_SCHEMA_VERSION,
            type: "page"
          }
        }))
      );
    }
  }

  async getPage(url: string, scope: Scope): Promise<PageRecord | null> {
    try {
      const results = await this.pagesNs.fetch<PageVectorMetadata>([pageId(scope, url)], {
        includeMetadata: true
      });
      const doc = results[0];
      if (!doc || !doc.metadata) return null;

      // A direct fetch bypasses the metadata filter that protects queries.
      // Without this check, a record belonging to another project or scope —
      // or written under an older schema — would be returned as this scope's.
      if (!recordBelongsToScope(doc.metadata, scope)) return null;

      // Reconstruct markdown from chunks
      const chunks = await this.getChunksForPage(url, scope);
      const markdown = reconstructMarkdownFromChunks(chunks, doc.metadata.title);

      return {
        url: doc.metadata.url,
        title: doc.metadata.title,
        markdown,
        projectId: doc.metadata.projectId,
        scopeName: doc.metadata.scopeName,
        routeFile: doc.metadata.routeFile,
        routeResolution: doc.metadata.routeResolution as "exact" | "best-effort",
        incomingLinks: doc.metadata.incomingLinks,
        outgoingLinks: doc.metadata.outgoingLinks,
        outgoingLinkUrls: doc.metadata.outgoingLinkUrls ?? undefined,
        depth: doc.metadata.depth,
        tags: doc.metadata.tags ?? [],
        indexedAt: doc.metadata.indexedAt,
        summary: doc.metadata.summary || undefined,
        description: doc.metadata.description || undefined,
        keywords: doc.metadata.keywords?.length ? doc.metadata.keywords : undefined,
        publishedAt: typeof doc.metadata.publishedAt === "number" ? doc.metadata.publishedAt : undefined
      };
    } catch {
      return null;
    }
  }

  /**
   * Fetch all chunks belonging to a specific page URL, sorted by ordinal.
   * Used to reconstruct full page markdown from chunk content.
   */
  async getChunksForPage(
    url: string,
    scope: Scope
  ): Promise<Array<{ chunkText: string; ordinal: number; sectionTitle: string; headingPath: string[] }>> {
    const chunks: Array<{ chunkText: string; ordinal: number; sectionTitle: string; headingPath: string[] }> = [];
    let cursor = "0";

    try {
      for (;;) {
        const result = await this.chunksNs.range<ChunkVectorMetadata>({
          cursor,
          prefix: recordPrefix(scope, "chunk"),
          limit: 100,
          includeMetadata: true
        });

        for (const doc of result.vectors) {
          if (
            recordBelongsToScope(doc.metadata, scope) &&
            doc.metadata?.url === url
          ) {
            chunks.push({
              chunkText: doc.metadata.chunkText ?? "",
              ordinal: doc.metadata.ordinal ?? 0,
              sectionTitle: doc.metadata.sectionTitle ?? "",
              headingPath: doc.metadata.headingPath
                ? String(doc.metadata.headingPath).split(" > ").filter(Boolean)
                : []
            });
          }
        }

        if (!result.nextCursor || result.nextCursor === "0") break;
        cursor = result.nextCursor;
      }
    } catch {
      // Namespace may not exist yet
    }

    return chunks.sort((a, b) => a.ordinal - b.ordinal);
  }

  async fetchPageWithVector(
    url: string,
    scope: Scope
  ): Promise<{ metadata: PageVectorMetadata; vector: number[] } | null> {
    try {
      const results = await this.pagesNs.fetch<PageVectorMetadata>([pageId(scope, url)], {
        includeMetadata: true,
        includeVectors: true
      });
      const doc = results[0];
      if (!doc || !doc.metadata || !doc.vector) return null;

      if (!recordBelongsToScope(doc.metadata, scope)) return null;

      return { metadata: doc.metadata, vector: doc.vector as number[] };
    } catch {
      return null;
    }
  }

  async fetchPagesBatch(
    urls: string[],
    scope: Scope
  ): Promise<Array<{ url: string; title: string; routeFile: string; outgoingLinkUrls: string[] }>> {
    if (urls.length === 0) return [];

    try {
      const results = await this.pagesNs.fetch<PageVectorMetadata>(
        urls.map((url) => pageId(scope, url)),
        { includeMetadata: true }
      );

      const out: Array<{ url: string; title: string; routeFile: string; outgoingLinkUrls: string[] }> = [];
      for (const doc of results) {
        if (!doc || !doc.metadata) continue;
        if (!recordBelongsToScope(doc.metadata, scope)) continue;
        out.push({
          url: doc.metadata.url,
          title: doc.metadata.title,
          routeFile: doc.metadata.routeFile,
          outgoingLinkUrls: doc.metadata.outgoingLinkUrls ?? []
        });
      }
      return out;
    } catch {
      return [];
    }
  }

  async deletePages(scope: Scope): Promise<void> {
    // Delete all page vectors for this scope
    const ids: string[] = [];
    let cursor = "0";
    try {
      for (;;) {
        const result = await this.pagesNs.range<PageVectorMetadata>({
          cursor,
          prefix: recordPrefix(scope, "page"),
          limit: 100,
          includeMetadata: true
        });
        for (const doc of result.vectors) {
          if (recordBelongsToScope(doc.metadata, scope)) {
            // Physical IDs, deleted directly. Routing them through
            // deletePagesByIds would re-encode an already-encoded ID and
            // delete nothing.
            ids.push(String(doc.id));
          }
        }
        if (!result.nextCursor || result.nextCursor === "0") break;
        cursor = result.nextCursor;
      }
    } catch (error) {
      if (!isMissingNamespaceError(error)) throw error;
    }

    const BATCH_SIZE = 90;
    for (let i = 0; i < ids.length; i += BATCH_SIZE) {
      await this.pagesNs.delete(ids.slice(i, i + BATCH_SIZE));
    }
  }

  /**
   * Find records written under an older identity layout.
   *
   * Records lacking the current `schemaVersion` are invisible to every read
   * path, so a 1.0 index run writes a fresh generation beside them rather than
   * overwriting them. They stay put — deliberately, so a rollback is possible —
   * until `searchsocket migrate cleanup-legacy` removes them.
   */
  async scanLegacyRecords(projectId: string): Promise<{
    pages: string[];
    chunks: string[];
  }> {
    const found = { pages: [] as string[], chunks: [] as string[] };

    for (const [ns, key] of [
      [this.pagesNs, "pages"],
      [this.chunksNs, "chunks"]
    ] as const) {
      let cursor = "0";
      try {
        for (;;) {
          const result = await ns.range<ChunkVectorMetadata>({
            cursor,
            limit: 100,
            includeMetadata: true
          });
          for (const doc of result.vectors) {
            if (doc.metadata?.projectId !== projectId) continue;
            // Only missing or older versions are legacy. Treating anything
            // "!== current" as legacy would make a 1.0 cleanup delete records
            // written by a future version that shares the index.
            const version = doc.metadata?.schemaVersion;
            const isLegacy = typeof version !== "number" || version < INDEX_SCHEMA_VERSION;
            if (!isLegacy) continue;
            found[key].push(String(doc.id));
          }
          if (!result.nextCursor || result.nextCursor === "0") break;
          cursor = result.nextCursor;
        }
      } catch (error) {
        if (!isMissingNamespaceError(error)) {
          throw new SearchSocketError(
            "VECTOR_BACKEND_UNAVAILABLE",
            `Failed to scan legacy records: ${error instanceof Error ? error.message : String(error)}`,
            { cause: error }
          );
        }
      }
    }

    return found;
  }

  /**
   * Delete legacy records by their exact physical IDs.
   *
   * Each ID is re-fetched and confirmed to belong to `projectId` and to carry
   * an older schema immediately before deletion. The IDs come from a scan, but
   * this method is public and the scan is not atomic with the delete: a
   * concurrent 0.7.x writer could reuse a raw ID in the interim.
   */
  async deleteLegacyRecords(
    projectId: string,
    ids: { pages: string[]; chunks: string[] }
  ): Promise<{ deleted: number; skipped: number }> {
    const BATCH_SIZE = 90;
    let deleted = 0;
    let skipped = 0;

    for (const [ns, list] of [
      [this.pagesNs, ids.pages],
      [this.chunksNs, ids.chunks]
    ] as const) {
      for (let i = 0; i < list.length; i += BATCH_SIZE) {
        const batch = list.slice(i, i + BATCH_SIZE);
        const docs = await ns.fetch<ChunkVectorMetadata>(batch, { includeMetadata: true });

        const confirmed: string[] = [];
        for (let j = 0; j < batch.length; j += 1) {
          const doc = docs[j];
          const version = doc?.metadata?.schemaVersion;
          const isLegacy = typeof version !== "number" || version < INDEX_SCHEMA_VERSION;
          if (doc && doc.metadata?.projectId === projectId && isLegacy) {
            confirmed.push(batch[j]!);
          } else if (doc) {
            skipped += 1;
          }
        }

        if (confirmed.length > 0) {
          await ns.delete(confirmed);
          deleted += confirmed.length;
        }
      }
    }

    return { deleted, skipped };
  }

  async health(): Promise<{ ok: boolean; details?: string }> {
    try {
      await this.index.info();
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        details: error instanceof Error ? error.message : "unknown error"
      };
    }
  }

  async dropAllIndexes(projectId: string): Promise<void> {
    // Scan both namespaces for vectors with this projectId, then delete
    for (const ns of [this.chunksNs, this.pagesNs]) {
      const ids: string[] = [];
      let cursor = "0";
      try {
        for (;;) {
          const result = await ns.range<ChunkVectorMetadata>({
            cursor,
            limit: 100,
            includeMetadata: true
          });
          for (const doc of result.vectors) {
            if (doc.metadata?.projectId === projectId) {
              ids.push(String(doc.id));
            }
          }
          if (!result.nextCursor || result.nextCursor === "0") break;
          cursor = result.nextCursor;
        }
      } catch {
        // Namespace may not exist yet
      }

      if (ids.length > 0) {
        const BATCH_SIZE = 90;
        for (let i = 0; i < ids.length; i += BATCH_SIZE) {
          const batch = ids.slice(i, i + BATCH_SIZE);
          await ns.delete(batch);
        }
      }
    }
  }
}
