import type { Index } from "@upstash/vector";
import type {
  PageHit,
  PageRecord,
  Scope,
  ScopeInfo,
  VectorHit
} from "../types";

/** Flat metadata stored alongside each chunk vector in Upstash Vector */
interface ChunkVectorMetadata {
  projectId: string;
  scopeName: string;
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
  type: string;
  title: string;
  url: string;
  description: string;
  keywords: string[];
  summary: string;
  tags: string[];
  markdown: string;
  routeFile: string;
  routeResolution: string;
  incomingLinks: number;
  outgoingLinks: number;
  depth: number;
  indexedAt: string;
  contentHash: string;
  publishedAt?: number | null;
  [key: string]: unknown;
}

export interface UpstashSearchStoreOptions {
  index: Index;
}

export class UpstashSearchStore {
  private readonly index: Index;

  constructor(opts: UpstashSearchStoreOptions) {
    this.index = opts.index;
  }

  async upsertChunks(
    chunks: Array<{
      id: string;
      vector: number[];
      metadata: Record<string, unknown>;
    }>,
    scope: Scope
  ): Promise<void> {
    if (chunks.length === 0) return;

    const BATCH_SIZE = 100;
    for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
      const batch = chunks.slice(i, i + BATCH_SIZE);
      await this.index.upsert(
        batch.map((c) => ({
          id: c.id,
          vector: c.vector,
          metadata: {
            ...c.metadata,
            projectId: scope.projectId,
            scopeName: scope.scopeName,
            type: (c.metadata.type as string) || "chunk"
          }
        }))
      );
    }
  }

  async search(
    vector: number[],
    opts: {
      limit: number;
      filter?: string;
    },
    scope: Scope
  ): Promise<VectorHit[]> {
    const filterParts = [
      `projectId = '${scope.projectId}'`,
      `scopeName = '${scope.scopeName}'`,
      `type = 'chunk'`
    ];
    if (opts.filter) {
      filterParts.push(opts.filter);
    }

    const results = await this.index.query<ChunkVectorMetadata>({
      vector,
      topK: opts.limit,
      includeMetadata: true,
      filter: filterParts.join(" AND ")
    });

    return results.map((doc) => ({
      id: String(doc.id),
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

  async searchPages(
    vector: number[],
    opts: {
      limit: number;
      filter?: string;
    },
    scope: Scope
  ): Promise<PageHit[]> {
    const filterParts = [
      `projectId = '${scope.projectId}'`,
      `scopeName = '${scope.scopeName}'`,
      `type = 'page'`
    ];
    if (opts.filter) {
      filterParts.push(opts.filter);
    }

    let results;
    try {
      results = await this.index.query<PageVectorMetadata>({
        vector,
        topK: opts.limit,
        includeMetadata: true,
        filter: filterParts.join(" AND ")
      });
    } catch {
      return [];
    }

    return results.map((doc) => ({
      id: String(doc.id),
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

  async deleteByIds(ids: string[], _scope: Scope): Promise<void> {
    if (ids.length === 0) return;

    const BATCH_SIZE = 100;
    for (let i = 0; i < ids.length; i += BATCH_SIZE) {
      const batch = ids.slice(i, i + BATCH_SIZE);
      await this.index.delete(batch);
    }
  }

  async deleteScope(scope: Scope): Promise<void> {
    // Range scan to find all vectors for this scope, then delete them
    const ids: string[] = [];
    let cursor = "0";
    try {
      for (;;) {
        const result = await this.index.range<ChunkVectorMetadata>({
          cursor,
          limit: 100,
          includeMetadata: true
        });
        for (const doc of result.vectors) {
          if (
            doc.metadata?.projectId === scope.projectId &&
            doc.metadata?.scopeName === scope.scopeName
          ) {
            ids.push(String(doc.id));
          }
        }
        if (!result.nextCursor || result.nextCursor === "0") break;
        cursor = result.nextCursor;
      }
    } catch {
      // Index may not exist
    }

    if (ids.length > 0) {
      await this.deleteByIds(ids, scope);
    }
  }

  async listScopes(projectId: string): Promise<ScopeInfo[]> {
    const scopeMap = new Map<string, number>();
    let cursor = "0";

    try {
      for (;;) {
        const result = await this.index.range<ChunkVectorMetadata>({
          cursor,
          limit: 100,
          includeMetadata: true
        });
        for (const doc of result.vectors) {
          if (doc.metadata?.projectId === projectId) {
            const scopeName = doc.metadata.scopeName ?? "";
            scopeMap.set(scopeName, (scopeMap.get(scopeName) ?? 0) + 1);
          }
        }
        if (!result.nextCursor || result.nextCursor === "0") break;
        cursor = result.nextCursor;
      }
    } catch {
      // Index may not exist
    }

    return [...scopeMap.entries()].map(([scopeName, count]) => ({
      projectId,
      scopeName,
      lastIndexedAt: new Date().toISOString(),
      documentCount: count
    }));
  }

  async getContentHashes(scope: Scope): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    let cursor = "0";

    try {
      for (;;) {
        const result = await this.index.range<ChunkVectorMetadata>({
          cursor,
          limit: 100,
          includeMetadata: true
        });
        for (const doc of result.vectors) {
          if (
            doc.metadata?.projectId === scope.projectId &&
            doc.metadata?.scopeName === scope.scopeName &&
            doc.metadata?.type === "chunk" &&
            doc.metadata?.contentHash
          ) {
            map.set(String(doc.id), doc.metadata.contentHash);
          }
        }
        if (!result.nextCursor || result.nextCursor === "0") break;
        cursor = result.nextCursor;
      }
    } catch {
      // Index may not exist yet
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
      const result = await this.index.range<PageVectorMetadata>({
        cursor,
        limit,
        includeMetadata: true
      });

      const pages = result.vectors
        .filter(
          (doc) =>
            doc.metadata?.projectId === scope.projectId &&
            doc.metadata?.scopeName === scope.scopeName &&
            doc.metadata?.type === "page" &&
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
        const result = await this.index.range<PageVectorMetadata>({
          cursor,
          limit: 100,
          includeMetadata: true
        });
        for (const doc of result.vectors) {
          if (
            doc.metadata?.projectId === scope.projectId &&
            doc.metadata?.scopeName === scope.scopeName &&
            doc.metadata?.type === "page" &&
            doc.metadata?.contentHash
          ) {
            map.set(String(doc.id), doc.metadata.contentHash);
          }
        }
        if (!result.nextCursor || result.nextCursor === "0") break;
        cursor = result.nextCursor;
      }
    } catch {
      // Index may not exist yet
    }

    return map;
  }

  async deletePagesByIds(ids: string[], _scope: Scope): Promise<void> {
    if (ids.length === 0) return;

    const BATCH_SIZE = 50;
    for (let i = 0; i < ids.length; i += BATCH_SIZE) {
      const batch = ids.slice(i, i + BATCH_SIZE);
      await this.index.delete(batch);
    }
  }

  async upsertPages(
    pages: Array<{
      id: string;
      vector: number[];
      metadata: Record<string, unknown>;
    }>,
    scope: Scope
  ): Promise<void> {
    if (pages.length === 0) return;

    const BATCH_SIZE = 50;
    for (let i = 0; i < pages.length; i += BATCH_SIZE) {
      const batch = pages.slice(i, i + BATCH_SIZE);
      await this.index.upsert(
        batch.map((p) => ({
          id: p.id,
          vector: p.vector,
          metadata: {
            ...p.metadata,
            projectId: scope.projectId,
            scopeName: scope.scopeName,
            type: "page"
          }
        }))
      );
    }
  }

  async getPage(url: string, scope: Scope): Promise<PageRecord | null> {
    try {
      const results = await this.index.fetch<PageVectorMetadata>([url], {
        includeMetadata: true
      });
      const doc = results[0];
      if (!doc || !doc.metadata) return null;

      return {
        url: doc.metadata.url,
        title: doc.metadata.title,
        markdown: doc.metadata.markdown,
        projectId: doc.metadata.projectId,
        scopeName: doc.metadata.scopeName,
        routeFile: doc.metadata.routeFile,
        routeResolution: doc.metadata.routeResolution as "exact" | "best-effort",
        incomingLinks: doc.metadata.incomingLinks,
        outgoingLinks: doc.metadata.outgoingLinks,
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

  async deletePages(scope: Scope): Promise<void> {
    // Delete all page vectors for this scope
    const ids: string[] = [];
    let cursor = "0";
    try {
      for (;;) {
        const result = await this.index.range<PageVectorMetadata>({
          cursor,
          limit: 100,
          includeMetadata: true
        });
        for (const doc of result.vectors) {
          if (
            doc.metadata?.projectId === scope.projectId &&
            doc.metadata?.scopeName === scope.scopeName &&
            doc.metadata?.type === "page"
          ) {
            ids.push(String(doc.id));
          }
        }
        if (!result.nextCursor || result.nextCursor === "0") break;
        cursor = result.nextCursor;
      }
    } catch {
      // Index may not exist
    }

    if (ids.length > 0) {
      await this.deleteByIds(ids, scope);
    }
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
    // Range scan to find all vectors with this projectId, then delete
    const ids: string[] = [];
    let cursor = "0";
    try {
      for (;;) {
        const result = await this.index.range<ChunkVectorMetadata>({
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
      // Ignore errors
    }

    if (ids.length > 0) {
      const BATCH_SIZE = 100;
      for (let i = 0; i < ids.length; i += BATCH_SIZE) {
        const batch = ids.slice(i, i + BATCH_SIZE);
        await this.index.delete(batch);
      }
    }
  }
}
