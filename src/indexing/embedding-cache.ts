import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

function vectorToBuffer(vector: number[]): Buffer {
  const typed = Float32Array.from(vector);
  return Buffer.from(typed.buffer);
}

function bufferToVector(blob: Buffer): number[] {
  const copied = blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength);
  return Array.from(new Float32Array(copied));
}

export class EmbeddingCache {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    const resolved = path.resolve(dbPath);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });

    this.db = new Database(resolved);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS embeddings_cache (
        content_hash TEXT NOT NULL,
        model_id TEXT NOT NULL,
        embedding BLOB NOT NULL,
        token_estimate INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (content_hash, model_id)
      );
    `);
  }

  get(contentHash: string, modelId: string): { embedding: number[]; tokenEstimate: number } | null {
    const row = this.db
      .prepare(
        `SELECT embedding, token_estimate
         FROM embeddings_cache
         WHERE content_hash = ? AND model_id = ?`
      )
      .get(contentHash, modelId) as { embedding: Buffer; token_estimate: number } | undefined;

    if (!row) {
      return null;
    }

    return {
      embedding: bufferToVector(row.embedding),
      tokenEstimate: row.token_estimate
    };
  }

  put(contentHash: string, modelId: string, embedding: number[], tokenEstimate: number): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO embeddings_cache (content_hash, model_id, embedding, token_estimate, created_at)
         VALUES (?, ?, ?, ?, datetime('now'))`
      )
      .run(contentHash, modelId, vectorToBuffer(embedding), tokenEstimate);
  }

  close(): void {
    this.db.close();
  }
}
