import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { QueryOpts, Scope, ScopeInfo, VectorHit, VectorRecord, VectorStore } from "../types";
import { safeJsonParse } from "../utils/text";

function toBuffer(vector: number[]): Buffer {
  const typed = Float32Array.from(vector);
  return Buffer.from(typed.buffer);
}

function fromBuffer(buffer: Buffer): number[] {
  const copied = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  return Array.from(new Float32Array(copied));
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;

  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const aVal = a[i] ?? 0;
    const bVal = b[i] ?? 0;
    dot += aVal * bVal;
    normA += aVal * aVal;
    normB += bVal * bVal;
  }

  if (!normA || !normB) {
    return 0;
  }

  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export class LocalVectorStore implements VectorStore {
  private readonly db: Database.Database;

  constructor(filePath: string) {
    const resolved = path.resolve(filePath);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    this.db = new Database(resolved);
    this.db.pragma("journal_mode = WAL");

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS vectors (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        scope_name TEXT NOT NULL,
        url TEXT NOT NULL,
        path TEXT NOT NULL,
        title TEXT NOT NULL,
        section_title TEXT NOT NULL,
        heading_path TEXT NOT NULL,
        snippet TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        model_id TEXT NOT NULL,
        depth INTEGER NOT NULL,
        incoming_links INTEGER NOT NULL,
        route_file TEXT NOT NULL,
        tags TEXT NOT NULL,
        vector BLOB NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_vectors_scope ON vectors(project_id, scope_name);
      CREATE INDEX IF NOT EXISTS idx_vectors_path ON vectors(path);

      CREATE TABLE IF NOT EXISTS registry (
        project_id TEXT NOT NULL,
        scope_name TEXT NOT NULL,
        model_id TEXT NOT NULL,
        last_indexed_at TEXT NOT NULL,
        vector_count INTEGER,
        PRIMARY KEY (project_id, scope_name)
      );
    `);
  }

  async upsert(records: VectorRecord[], scope: Scope): Promise<void> {
    if (records.length === 0) {
      return;
    }

    const statement = this.db.prepare(`
      INSERT INTO vectors (
        id, project_id, scope_name, url, path, title, section_title, heading_path,
        snippet, content_hash, model_id, depth, incoming_links, route_file, tags,
        vector, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(id) DO UPDATE SET
        project_id = excluded.project_id,
        scope_name = excluded.scope_name,
        url = excluded.url,
        path = excluded.path,
        title = excluded.title,
        section_title = excluded.section_title,
        heading_path = excluded.heading_path,
        snippet = excluded.snippet,
        content_hash = excluded.content_hash,
        model_id = excluded.model_id,
        depth = excluded.depth,
        incoming_links = excluded.incoming_links,
        route_file = excluded.route_file,
        tags = excluded.tags,
        vector = excluded.vector,
        updated_at = excluded.updated_at
    `);

    const transaction = this.db.transaction((items: VectorRecord[]) => {
      for (const item of items) {
        statement.run(
          item.id,
          item.metadata.projectId,
          scope.scopeName,
          item.metadata.url,
          item.metadata.path,
          item.metadata.title,
          item.metadata.sectionTitle,
          JSON.stringify(item.metadata.headingPath),
          item.metadata.snippet,
          item.metadata.contentHash,
          item.metadata.modelId,
          item.metadata.depth,
          item.metadata.incomingLinks,
          item.metadata.routeFile,
          JSON.stringify(item.metadata.tags),
          toBuffer(item.vector)
        );
      }
    });

    transaction(records);
  }

  async query(queryVector: number[], opts: QueryOpts, scope: Scope): Promise<VectorHit[]> {
    const clauses: string[] = ["project_id = ?", "scope_name = ?"];
    const values: unknown[] = [scope.projectId, scope.scopeName];

    if (opts.pathPrefix) {
      clauses.push("path LIKE ?");
      values.push(`${opts.pathPrefix}%`);
    }

    const rows = this.db
      .prepare(
        `SELECT id, url, path, title, section_title, heading_path, snippet, content_hash,
                model_id, depth, incoming_links, route_file, tags, vector
         FROM vectors
         WHERE ${clauses.join(" AND ")}`
      )
      .all(...values) as Array<{
      id: string;
      url: string;
      path: string;
      title: string;
      section_title: string;
      heading_path: string;
      snippet: string;
      content_hash: string;
      model_id: string;
      depth: number;
      incoming_links: number;
      route_file: string;
      tags: string;
      vector: Buffer;
    }>;

    const tagSet = new Set(opts.tags ?? []);

    const hits = rows
      .filter((row) => {
        if (tagSet.size === 0) {
          return true;
        }

        const tags = safeJsonParse<string[]>(row.tags, []);
        return [...tagSet].every((tag) => tags.includes(tag));
      })
      .map((row) => {
        const vector = fromBuffer(row.vector);
        const score = cosineSimilarity(queryVector, vector);
        const tags = safeJsonParse<string[]>(row.tags, []);
        const headingPath = safeJsonParse<string[]>(row.heading_path, []);

        return {
          id: row.id,
          score,
          metadata: {
            projectId: scope.projectId,
            scopeName: scope.scopeName,
            url: row.url,
            path: row.path,
            title: row.title,
            sectionTitle: row.section_title,
            headingPath,
            snippet: row.snippet,
            contentHash: row.content_hash,
            modelId: row.model_id,
            depth: row.depth,
            incomingLinks: row.incoming_links,
            routeFile: row.route_file,
            tags
          }
        } satisfies VectorHit;
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, opts.topK);

    return hits;
  }

  async deleteByIds(ids: string[], scope: Scope): Promise<void> {
    if (ids.length === 0) {
      return;
    }

    const placeholders = ids.map(() => "?").join(", ");
    this.db
      .prepare(
        `DELETE FROM vectors WHERE project_id = ? AND scope_name = ? AND id IN (${placeholders})`
      )
      .run(scope.projectId, scope.scopeName, ...ids);
  }

  async deleteScope(scope: Scope): Promise<void> {
    this.db
      .prepare("DELETE FROM vectors WHERE project_id = ? AND scope_name = ?")
      .run(scope.projectId, scope.scopeName);

    this.db
      .prepare("DELETE FROM registry WHERE project_id = ? AND scope_name = ?")
      .run(scope.projectId, scope.scopeName);
  }

  async listScopes(scopeProjectId: string): Promise<ScopeInfo[]> {
    const rows = this.db
      .prepare(
        `SELECT project_id, scope_name, model_id, last_indexed_at, vector_count
         FROM registry
         WHERE project_id = ?`
      )
      .all(scopeProjectId) as Array<{
      project_id: string;
      scope_name: string;
      model_id: string;
      last_indexed_at: string;
      vector_count: number | null;
    }>;

    return rows.map((row) => ({
      projectId: row.project_id,
      scopeName: row.scope_name,
      modelId: row.model_id,
      lastIndexedAt: row.last_indexed_at,
      vectorCount: row.vector_count ?? undefined
    }));
  }

  async recordScope(info: ScopeInfo): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO registry (project_id, scope_name, model_id, last_indexed_at, vector_count)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(project_id, scope_name) DO UPDATE SET
           model_id = excluded.model_id,
           last_indexed_at = excluded.last_indexed_at,
           vector_count = excluded.vector_count`
      )
      .run(info.projectId, info.scopeName, info.modelId, info.lastIndexedAt, info.vectorCount ?? null);
  }

  async health(): Promise<{ ok: boolean; details?: string }> {
    try {
      this.db.prepare("SELECT 1").get();
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        details: error instanceof Error ? error.message : "Unknown sqlite error"
      };
    }
  }
}
