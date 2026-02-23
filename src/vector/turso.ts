import { createClient, type Client, type InStatement } from "@libsql/client";
import type { QueryOpts, Scope, ScopeInfo, VectorHit, VectorRecord, VectorStore } from "../types";

export interface TursoVectorStoreOptions {
  url?: string;
  authToken?: string;
  dimension?: number;
}

export class TursoVectorStore implements VectorStore {
  private readonly client: Client;
  private readonly dimension: number | undefined;
  private chunksReady = false;
  private registryReady = false;

  constructor(opts: TursoVectorStoreOptions = {}) {
    this.dimension = opts.dimension;
    this.client = createClient({
      url: opts.url ?? "file:vectors.db",
      authToken: opts.authToken
    });
  }

  private async ensureRegistry(): Promise<void> {
    if (this.registryReady) return;
    await this.client.execute(`
      CREATE TABLE IF NOT EXISTS registry (
        scope_key   TEXT PRIMARY KEY,
        project_id  TEXT NOT NULL,
        scope_name  TEXT NOT NULL,
        model_id    TEXT NOT NULL,
        last_indexed_at TEXT NOT NULL,
        vector_count INTEGER
      )
    `);
    this.registryReady = true;
  }

  private async ensureChunks(dim: number): Promise<void> {
    if (this.chunksReady) return;
    await this.client.batch([
      `CREATE TABLE IF NOT EXISTS chunks (
        id             TEXT PRIMARY KEY,
        project_id     TEXT NOT NULL,
        scope_name     TEXT NOT NULL,
        url            TEXT NOT NULL,
        path           TEXT NOT NULL,
        title          TEXT NOT NULL,
        section_title  TEXT NOT NULL DEFAULT '',
        heading_path   TEXT NOT NULL DEFAULT '[]',
        snippet        TEXT NOT NULL DEFAULT '',
        content_hash   TEXT NOT NULL DEFAULT '',
        model_id       TEXT NOT NULL DEFAULT '',
        depth          INTEGER NOT NULL DEFAULT 0,
        incoming_links INTEGER NOT NULL DEFAULT 0,
        route_file     TEXT NOT NULL DEFAULT '',
        tags           TEXT NOT NULL DEFAULT '[]',
        embedding      F32_BLOB(${dim})
      )`,
      `CREATE INDEX IF NOT EXISTS idx ON chunks (libsql_vector_idx(embedding, 'metric=cosine'))`
    ]);
    this.chunksReady = true;
  }

  async upsert(records: VectorRecord[], _scope: Scope): Promise<void> {
    if (records.length === 0) return;

    const dim = this.dimension ?? records[0]!.vector.length;
    await this.ensureChunks(dim);

    const BATCH_SIZE = 100;
    for (let i = 0; i < records.length; i += BATCH_SIZE) {
      const batch = records.slice(i, i + BATCH_SIZE);
      const stmts: InStatement[] = batch.map((r) => ({
        sql: `INSERT OR REPLACE INTO chunks
              (id, project_id, scope_name, url, path, title, section_title,
               heading_path, snippet, content_hash, model_id, depth,
               incoming_links, route_file, tags, embedding)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, vector(?))`,
        args: [
          r.id,
          r.metadata.projectId,
          r.metadata.scopeName,
          r.metadata.url,
          r.metadata.path,
          r.metadata.title,
          r.metadata.sectionTitle,
          JSON.stringify(r.metadata.headingPath),
          r.metadata.snippet,
          r.metadata.contentHash,
          r.metadata.modelId,
          r.metadata.depth,
          r.metadata.incomingLinks,
          r.metadata.routeFile,
          JSON.stringify(r.metadata.tags),
          JSON.stringify(r.vector)
        ]
      }));
      await this.client.batch(stmts);
    }
  }

  async query(queryVector: number[], opts: QueryOpts, scope: Scope): Promise<VectorHit[]> {
    const dim = this.dimension ?? queryVector.length;
    await this.ensureChunks(dim);

    const overfetch = opts.topK * 3;
    const queryJson = JSON.stringify(queryVector);
    const rs = await this.client.execute({
      sql: `SELECT c.id, c.project_id, c.scope_name, c.url, c.path, c.title,
                   c.section_title, c.heading_path, c.snippet, c.content_hash,
                   c.model_id, c.depth, c.incoming_links, c.route_file, c.tags,
                   vector_distance_cos(c.embedding, vector(?)) AS distance
            FROM vector_top_k('idx', vector(?), ?) AS v
            JOIN chunks AS c ON c.rowid = v.id`,
      args: [queryJson, queryJson, overfetch]
    });

    let hits: VectorHit[] = [];

    for (const row of rs.rows) {
      const projectId = row.project_id as string;
      const scopeName = row.scope_name as string;

      if (projectId !== scope.projectId || scopeName !== scope.scopeName) {
        continue;
      }

      const rowPath = row.path as string;
      if (opts.pathPrefix) {
        const rawPrefix = opts.pathPrefix.startsWith("/") ? opts.pathPrefix : `/${opts.pathPrefix}`;
        const prefix = rawPrefix.endsWith("/") ? rawPrefix : `${rawPrefix}/`;
        const normalizedPath = rowPath.replace(/\/$/, "");
        const normalizedPrefix = rawPrefix.replace(/\/$/, "");
        if (normalizedPath !== normalizedPrefix && !rowPath.startsWith(prefix)) {
          continue;
        }
      }

      const tags: string[] = JSON.parse((row.tags as string) || "[]");
      if (opts.tags && opts.tags.length > 0) {
        if (!opts.tags.every((t) => tags.includes(t))) {
          continue;
        }
      }

      const distance = row.distance as number;
      const score = 1 - distance;

      hits.push({
        id: row.id as string,
        score,
        metadata: {
          projectId,
          scopeName,
          url: row.url as string,
          path: rowPath,
          title: row.title as string,
          sectionTitle: row.section_title as string,
          headingPath: JSON.parse((row.heading_path as string) || "[]"),
          snippet: row.snippet as string,
          contentHash: row.content_hash as string,
          modelId: row.model_id as string,
          depth: row.depth as number,
          incomingLinks: row.incoming_links as number,
          routeFile: row.route_file as string,
          tags
        }
      });
    }

    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, opts.topK);
  }

  async deleteByIds(ids: string[], _scope: Scope): Promise<void> {
    if (ids.length === 0) return;

    const BATCH_SIZE = 500;
    for (let i = 0; i < ids.length; i += BATCH_SIZE) {
      const batch = ids.slice(i, i + BATCH_SIZE);
      const placeholders = batch.map(() => "?").join(", ");
      await this.client.execute({
        sql: `DELETE FROM chunks WHERE id IN (${placeholders})`,
        args: batch
      });
    }
  }

  async deleteScope(scope: Scope): Promise<void> {
    await this.ensureRegistry();

    // Delete chunks - table may not exist yet for a fresh DB
    try {
      await this.client.execute({
        sql: `DELETE FROM chunks WHERE project_id = ? AND scope_name = ?`,
        args: [scope.projectId, scope.scopeName]
      });
    } catch {
      // chunks table doesn't exist yet, that's fine
    }

    await this.client.execute({
      sql: `DELETE FROM registry WHERE project_id = ? AND scope_name = ?`,
      args: [scope.projectId, scope.scopeName]
    });
  }

  async listScopes(scopeProjectId: string): Promise<ScopeInfo[]> {
    await this.ensureRegistry();
    const rs = await this.client.execute({
      sql: `SELECT project_id, scope_name, model_id, last_indexed_at, vector_count
            FROM registry WHERE project_id = ?`,
      args: [scopeProjectId]
    });

    return rs.rows.map((row) => ({
      projectId: row.project_id as string,
      scopeName: row.scope_name as string,
      modelId: row.model_id as string,
      lastIndexedAt: row.last_indexed_at as string,
      vectorCount: row.vector_count as number | undefined
    }));
  }

  async recordScope(info: ScopeInfo): Promise<void> {
    await this.ensureRegistry();
    const key = `${info.projectId}:${info.scopeName}`;
    await this.client.execute({
      sql: `INSERT OR REPLACE INTO registry
            (scope_key, project_id, scope_name, model_id, last_indexed_at, vector_count)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: [key, info.projectId, info.scopeName, info.modelId, info.lastIndexedAt, info.vectorCount ?? null]
    });
  }

  async health(): Promise<{ ok: boolean; details?: string }> {
    try {
      await this.client.execute("SELECT 1");
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        details: error instanceof Error ? error.message : "unknown error"
      };
    }
  }
}
