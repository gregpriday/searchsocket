import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createClient, type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TursoVectorStore } from "../src/vector/turso";
import type { Scope, VectorRecord } from "../src/types";

let tmpDir: string;
let dbPath: string;
let client: Client;

const scopeA: Scope = { projectId: "proj", scopeName: "main", scopeId: "proj:main" };

function makeRecord(id: string, vector: number[], overrides: Partial<VectorRecord["metadata"]> = {}): VectorRecord {
  return {
    id,
    vector,
    metadata: {
      projectId: "proj",
      scopeName: "main",
      url: `https://example.com${overrides.path ?? "/page"}`,
      path: overrides.path ?? "/page",
      title: overrides.title ?? "Page",
      sectionTitle: overrides.sectionTitle ?? "",
      headingPath: overrides.headingPath ?? [],
      snippet: overrides.snippet ?? "snippet text",
      chunkText: overrides.chunkText ?? "full chunk text for testing",
      ordinal: overrides.ordinal ?? 0,
      contentHash: overrides.contentHash ?? "abc123",
      modelId: overrides.modelId ?? "jina-embeddings-v3",
      depth: overrides.depth ?? 0,
      incomingLinks: overrides.incomingLinks ?? 0,
      routeFile: overrides.routeFile ?? "+page.svelte",
      tags: overrides.tags ?? [],
      ...overrides
    }
  };
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "turso-dim-mismatch-"));
  dbPath = path.join(tmpDir, "test.db");
  client = createClient({ url: `file:${dbPath}` });
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("TursoVectorStore dimension mismatch handling", () => {
  it("recreates chunks table when dimension changes", async () => {
    const DIM_A = 4;
    const DIM_B = 8;

    // Create a store with dimension 4 and insert a record
    const storeA = new TursoVectorStore({ client, dimension: DIM_A });
    await storeA.upsert(
      [makeRecord("r1", [1, 0, 0, 0])],
      scopeA
    );

    // Verify the record exists
    const hitsA = await storeA.query([1, 0, 0, 0], { topK: 5 }, scopeA);
    expect(hitsA).toHaveLength(1);
    expect(hitsA[0]!.id).toBe("r1");

    // Create a new store instance with dimension 8 (same DB)
    // The chunksReady flag is false on the new instance, so ensureChunks will run
    const storeB = new TursoVectorStore({ client, dimension: DIM_B });
    await storeB.upsert(
      [makeRecord("r2", [1, 0, 0, 0, 0, 0, 0, 0])],
      scopeA
    );

    // The old record should be gone (table was dropped and recreated)
    const hitsB = await storeB.query([1, 0, 0, 0, 0, 0, 0, 0], { topK: 10 }, scopeA);
    expect(hitsB.map((h) => h.id)).toContain("r2");
    expect(hitsB.map((h) => h.id)).not.toContain("r1");
  });

  it("preserves chunks table when dimension stays the same", async () => {
    const DIM = 4;

    // Create a store and insert a record
    const store1 = new TursoVectorStore({ client, dimension: DIM });
    await store1.upsert(
      [makeRecord("r1", [1, 0, 0, 0])],
      scopeA
    );

    // Create a new store instance with the same dimension
    const store2 = new TursoVectorStore({ client, dimension: DIM });
    await store2.upsert(
      [makeRecord("r2", [0, 1, 0, 0])],
      scopeA
    );

    // Both records should exist since the table was not dropped
    const hits = await store2.query([1, 0, 0, 0], { topK: 10 }, scopeA);
    expect(hits.map((h) => h.id)).toContain("r1");
    expect(hits.map((h) => h.id)).toContain("r2");
  });

  it("works after multiple dimension changes", async () => {
    // Start with dimension 4
    const store4 = new TursoVectorStore({ client, dimension: 4 });
    await store4.upsert(
      [makeRecord("a", [1, 0, 0, 0])],
      scopeA
    );

    // Switch to dimension 8
    const store8 = new TursoVectorStore({ client, dimension: 8 });
    await store8.upsert(
      [makeRecord("b", [1, 0, 0, 0, 0, 0, 0, 0])],
      scopeA
    );

    // Switch back to dimension 4
    const store4b = new TursoVectorStore({ client, dimension: 4 });
    await store4b.upsert(
      [makeRecord("c", [0, 0, 0, 1])],
      scopeA
    );

    // Only the last record should exist
    const hits = await store4b.query([0, 0, 0, 1], { topK: 10 }, scopeA);
    expect(hits.map((h) => h.id)).toContain("c");
    expect(hits.map((h) => h.id)).not.toContain("a");
    expect(hits.map((h) => h.id)).not.toContain("b");
  });
});

describe("TursoVectorStore.dropAllTables()", () => {
  it("removes chunks, registry, and pages tables", async () => {
    const DIM = 4;
    const store = new TursoVectorStore({ client, dimension: DIM });

    // Populate all three tables
    await store.upsert(
      [makeRecord("r1", [1, 0, 0, 0])],
      scopeA
    );
    await store.recordScope({
      projectId: "proj",
      scopeName: "main",
      modelId: "jina-embeddings-v3",
      lastIndexedAt: "2026-01-01T00:00:00.000Z",
      vectorCount: 1
    });
    await store.upsertPages(
      [{
        url: "/test", title: "Test", markdown: "# Test", projectId: "proj",
        scopeName: "main", routeFile: "", routeResolution: "exact",
        incomingLinks: 0, outgoingLinks: 0, depth: 0, tags: [],
        indexedAt: "2026-01-01T00:00:00.000Z"
      }],
      scopeA
    );

    // Drop everything
    await store.dropAllTables();

    // Verify all tables are gone by checking sqlite_master
    const rs = await client.execute(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('chunks', 'registry', 'pages')"
    );
    expect(rs.rows).toHaveLength(0);
  });

  it("drops the vector index along with tables", async () => {
    const DIM = 4;
    const store = new TursoVectorStore({ client, dimension: DIM });

    // Create the chunks table (and its index) by upserting
    await store.upsert(
      [makeRecord("r1", [1, 0, 0, 0])],
      scopeA
    );

    await store.dropAllTables();

    // Verify the index is also gone
    const rs = await client.execute(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='idx'"
    );
    expect(rs.rows).toHaveLength(0);
  });

  it("allows re-creating tables after drop", async () => {
    const DIM = 4;
    const store = new TursoVectorStore({ client, dimension: DIM });

    // Create and populate
    await store.upsert(
      [makeRecord("r1", [1, 0, 0, 0])],
      scopeA
    );

    // Drop everything
    await store.dropAllTables();

    // Re-create by using the store again (new instance to reset chunksReady flag)
    const store2 = new TursoVectorStore({ client, dimension: DIM });
    await store2.upsert(
      [makeRecord("r2", [0, 1, 0, 0])],
      scopeA
    );

    const hits = await store2.query([0, 1, 0, 0], { topK: 5 }, scopeA);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.id).toBe("r2");
  });

  it("resets internal ready flags so tables can be recreated on same instance", async () => {
    const DIM = 4;
    const store = new TursoVectorStore({ client, dimension: DIM });

    // Create tables
    await store.upsert([makeRecord("r1", [1, 0, 0, 0])], scopeA);
    await store.recordScope({
      projectId: "proj",
      scopeName: "main",
      modelId: "jina-embeddings-v3",
      lastIndexedAt: "2026-01-01T00:00:00.000Z",
      vectorCount: 1
    });

    // Drop and reuse the same instance
    await store.dropAllTables();

    // These should not throw -- the internal flags were reset
    await store.upsert([makeRecord("r2", [0, 1, 0, 0])], scopeA);
    await store.recordScope({
      projectId: "proj",
      scopeName: "main",
      modelId: "jina-embeddings-v3",
      lastIndexedAt: "2026-02-01T00:00:00.000Z",
      vectorCount: 1
    });

    const hits = await store.query([0, 1, 0, 0], { topK: 5 }, scopeA);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.id).toBe("r2");

    const scopes = await store.listScopes("proj");
    expect(scopes).toHaveLength(1);
  });
});

describe("TursoVectorStore.getChunksDimension() (tested indirectly)", () => {
  it("dimension mismatch detection works when chunks table has data", async () => {
    // getChunksDimension is private, so we test it indirectly via the
    // dimension mismatch behavior: if it correctly reads the dimension,
    // upserting with a different dimension will succeed (drop+recreate).
    const store4 = new TursoVectorStore({ client, dimension: 4 });
    await store4.upsert(
      [makeRecord("r1", [1, 0, 0, 0])],
      scopeA
    );

    // Verify the F32_BLOB dimension is in the schema
    const rs = await client.execute(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='chunks'"
    );
    expect(rs.rows).toHaveLength(1);
    const sql = rs.rows[0]!.sql as string;
    expect(sql).toMatch(/F32_BLOB\(4\)/i);

    // Now a store with dimension 8 should drop and recreate
    const store8 = new TursoVectorStore({ client, dimension: 8 });
    await store8.upsert(
      [makeRecord("r2", [1, 0, 0, 0, 0, 0, 0, 0])],
      scopeA
    );

    // Schema should now show dimension 8
    const rs2 = await client.execute(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='chunks'"
    );
    expect(rs2.rows).toHaveLength(1);
    const sql2 = rs2.rows[0]!.sql as string;
    expect(sql2).toMatch(/F32_BLOB\(8\)/i);
  });

  it("returns correct dimension for query path too", async () => {
    // ensureChunks is also called from query(), so dimension mismatch
    // should be handled there as well.
    const store4 = new TursoVectorStore({ client, dimension: 4 });
    await store4.upsert(
      [makeRecord("r1", [1, 0, 0, 0])],
      scopeA
    );

    // Query with a different dimension store should trigger table recreation
    const store8 = new TursoVectorStore({ client, dimension: 8 });
    // This should not throw -- ensureChunks will drop+recreate the table
    const hits = await store8.query([1, 0, 0, 0, 0, 0, 0, 0], { topK: 5 }, scopeA);
    // Table was recreated empty, so no results
    expect(hits).toHaveLength(0);
  });
});
