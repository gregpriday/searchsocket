import type { Search } from "@upstash/search";
import type {
  PageRecord,
  Scope,
  ScopeInfo,
  VectorHit
} from "../types";

/** Content fields stored in Upstash Search (indexed and searchable) */
interface ChunkContent {
  title: string;
  sectionTitle: string;
  text: string;
  url: string;
  tags: string;
  headingPath: string;
  [key: string]: unknown;
}

/** Metadata fields stored in Upstash Search (returned but not searchable) */
interface ChunkMetadata {
  projectId: string;
  scopeName: string;
  path: string;
  snippet: string;
  ordinal: number;
  contentHash: string;
  depth: number;
  incomingLinks: number;
  routeFile: string;
  description: string;
  keywords: string;
  [key: string]: unknown;
}

/** Content fields for full page documents in Upstash Search */
interface PageContent {
  title: string;
  url: string;
  type: string;
  [key: string]: unknown;
}

/** Metadata fields for full page documents in Upstash Search */
interface PageMetadata {
  markdown: string;
  projectId: string;
  scopeName: string;
  routeFile: string;
  routeResolution: string;
  incomingLinks: number;
  outgoingLinks: number;
  depth: number;
  tags: string;
  indexedAt: string;
  [key: string]: unknown;
}

export interface UpstashSearchStoreOptions {
  client: Search;
}

/**
 * Derives the Upstash Search index name for a given scope.
 * Each scope gets its own index for isolation (multi-branch support).
 */
function chunkIndexName(scope: Scope): string {
  return `${scope.projectId}--${scope.scopeName}`;
}

function pageIndexName(scope: Scope): string {
  return `${scope.projectId}--${scope.scopeName}--pages`;
}

export class UpstashSearchStore {
  private readonly client: Search;

  constructor(opts: UpstashSearchStoreOptions) {
    this.client = opts.client;
  }

  private chunkIndex(scope: Scope) {
    return this.client.index<ChunkContent, ChunkMetadata>(chunkIndexName(scope));
  }

  private pageIndex(scope: Scope) {
    return this.client.index<PageContent, PageMetadata>(pageIndexName(scope));
  }

  async upsertChunks(
    chunks: Array<{
      id: string;
      content: ChunkContent;
      metadata: ChunkMetadata;
    }>,
    scope: Scope
  ): Promise<void> {
    if (chunks.length === 0) return;

    const index = this.chunkIndex(scope);
    const BATCH_SIZE = 100;
    for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
      const batch = chunks.slice(i, i + BATCH_SIZE);
      await index.upsert(batch);
    }
  }

  async search(
    query: string,
    opts: {
      limit: number;
      semanticWeight?: number;
      inputEnrichment?: boolean;
      reranking?: boolean;
      filter?: string;
    },
    scope: Scope
  ): Promise<VectorHit[]> {
    const index = this.chunkIndex(scope);

    const results = await index.search({
      query,
      limit: opts.limit,
      semanticWeight: opts.semanticWeight,
      inputEnrichment: opts.inputEnrichment,
      reranking: opts.reranking,
      filter: opts.filter
    });

    return results.map((doc) => ({
      id: doc.id,
      score: doc.score,
      metadata: {
        projectId: (doc.metadata?.projectId as string) ?? "",
        scopeName: (doc.metadata?.scopeName as string) ?? "",
        url: doc.content.url as string,
        path: (doc.metadata?.path as string) ?? "",
        title: doc.content.title as string,
        sectionTitle: doc.content.sectionTitle as string,
        headingPath: doc.content.headingPath ? (doc.content.headingPath as string).split(" > ").filter(Boolean) : [],
        snippet: (doc.metadata?.snippet as string) ?? "",
        chunkText: doc.content.text as string,
        ordinal: (doc.metadata?.ordinal as number) ?? 0,
        contentHash: (doc.metadata?.contentHash as string) ?? "",
        depth: (doc.metadata?.depth as number) ?? 0,
        incomingLinks: (doc.metadata?.incomingLinks as number) ?? 0,
        routeFile: (doc.metadata?.routeFile as string) ?? "",
        tags: doc.content.tags ? (doc.content.tags as string).split(",").filter(Boolean) : [],
        description: (doc.metadata?.description as string) || undefined,
        keywords: doc.metadata?.keywords ? (doc.metadata.keywords as string).split(",").filter(Boolean) : undefined
      }
    }));
  }

  async deleteByIds(ids: string[], scope: Scope): Promise<void> {
    if (ids.length === 0) return;

    const index = this.chunkIndex(scope);
    const BATCH_SIZE = 500;
    for (let i = 0; i < ids.length; i += BATCH_SIZE) {
      const batch = ids.slice(i, i + BATCH_SIZE);
      await index.delete(batch);
    }
  }

  async deleteScope(scope: Scope): Promise<void> {
    try {
      const chunkIdx = this.chunkIndex(scope);
      await chunkIdx.deleteIndex();
    } catch {
      // Index may not exist
    }

    try {
      const pageIdx = this.pageIndex(scope);
      await pageIdx.deleteIndex();
    } catch {
      // Index may not exist
    }
  }

  async listScopes(projectId: string): Promise<ScopeInfo[]> {
    const allIndexes = await this.client.listIndexes();
    const prefix = `${projectId}--`;

    const scopeNames = new Set<string>();
    for (const name of allIndexes) {
      if (name.startsWith(prefix) && !name.endsWith("--pages")) {
        const scopeName = name.slice(prefix.length);
        scopeNames.add(scopeName);
      }
    }

    const scopes: ScopeInfo[] = [];
    for (const scopeName of scopeNames) {
      const scope: Scope = {
        projectId,
        scopeName,
        scopeId: `${projectId}:${scopeName}`
      };

      try {
        const info = await this.chunkIndex(scope).info();
        scopes.push({
          projectId,
          scopeName,
          lastIndexedAt: new Date().toISOString(),
          documentCount: info.documentCount
        });
      } catch {
        scopes.push({
          projectId,
          scopeName,
          lastIndexedAt: "unknown",
          documentCount: 0
        });
      }
    }

    return scopes;
  }

  async getContentHashes(scope: Scope): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    const index = this.chunkIndex(scope);

    let cursor = "0";
    try {
      for (;;) {
        const result = await index.range({ cursor, limit: 100 });
        for (const doc of result.documents) {
          if (doc.metadata?.contentHash) {
            map.set(doc.id, doc.metadata.contentHash as string);
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

  async upsertPages(pages: PageRecord[], scope: Scope): Promise<void> {
    if (pages.length === 0) return;

    const index = this.pageIndex(scope);
    const BATCH_SIZE = 50;
    for (let i = 0; i < pages.length; i += BATCH_SIZE) {
      const batch = pages.slice(i, i + BATCH_SIZE);
      const docs = batch.map((p) => ({
        id: p.url,
        content: {
          title: p.title,
          url: p.url,
          type: "page"
        } as PageContent,
        metadata: {
          markdown: p.markdown,
          projectId: p.projectId,
          scopeName: p.scopeName,
          routeFile: p.routeFile,
          routeResolution: p.routeResolution,
          incomingLinks: p.incomingLinks,
          outgoingLinks: p.outgoingLinks,
          depth: p.depth,
          tags: JSON.stringify(p.tags),
          indexedAt: p.indexedAt
        } as PageMetadata
      }));
      await index.upsert(docs);
    }
  }

  async getPage(url: string, scope: Scope): Promise<PageRecord | null> {
    const index = this.pageIndex(scope);

    try {
      const results = await index.fetch([url]);
      const doc = results[0];
      if (!doc) return null;

      return {
        url: doc.content.url as string,
        title: doc.content.title as string,
        markdown: doc.metadata.markdown as string,
        projectId: doc.metadata.projectId as string,
        scopeName: doc.metadata.scopeName as string,
        routeFile: doc.metadata.routeFile as string,
        routeResolution: (doc.metadata.routeResolution as string) as "exact" | "best-effort",
        incomingLinks: doc.metadata.incomingLinks as number,
        outgoingLinks: doc.metadata.outgoingLinks as number,
        depth: doc.metadata.depth as number,
        tags: JSON.parse((doc.metadata.tags as string) || "[]"),
        indexedAt: doc.metadata.indexedAt as string
      };
    } catch {
      return null;
    }
  }

  async deletePages(scope: Scope): Promise<void> {
    try {
      const index = this.pageIndex(scope);
      await index.reset();
    } catch {
      // Index may not exist
    }
  }

  async health(): Promise<{ ok: boolean; details?: string }> {
    try {
      await this.client.info();
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        details: error instanceof Error ? error.message : "unknown error"
      };
    }
  }

  async dropAllIndexes(projectId: string): Promise<void> {
    const allIndexes = await this.client.listIndexes();
    const prefix = `${projectId}--`;

    for (const name of allIndexes) {
      if (name.startsWith(prefix)) {
        try {
          const index = this.client.index(name);
          await index.deleteIndex();
        } catch {
          // Ignore deletion failures
        }
      }
    }
  }
}
