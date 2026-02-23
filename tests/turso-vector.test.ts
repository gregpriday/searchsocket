import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TursoVectorStore } from "../src/vector/turso";
import type { Scope, ScopeInfo, VectorRecord } from "../src/types";

const DIM = 4;
let tmpDir: string;
let store: TursoVectorStore;

const scopeA: Scope = { projectId: "proj", scopeName: "main", scopeId: "proj:main" };
const scopeB: Scope = { projectId: "proj", scopeName: "staging", scopeId: "proj:staging" };

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
      contentHash: overrides.contentHash ?? "abc123",
      modelId: overrides.modelId ?? "text-embedding-3-small",
      depth: overrides.depth ?? 0,
      incomingLinks: overrides.incomingLinks ?? 0,
      routeFile: overrides.routeFile ?? "+page.svelte",
      tags: overrides.tags ?? [],
      ...overrides
    }
  };
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "turso-vector-test-"));
  const dbPath = path.join(tmpDir, "test.db");
  store = new TursoVectorStore({ url: `file:${dbPath}`, dimension: DIM });
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("TursoVectorStore", () => {
  it("upsert + query round-trip", async () => {
    const records = [
      makeRecord("r1", [1, 0, 0, 0]),
      makeRecord("r2", [0, 1, 0, 0])
    ];

    await store.upsert(records, scopeA);

    const hits = await store.query([1, 0, 0, 0], { topK: 5 }, scopeA);
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0]!.id).toBe("r1");
    expect(hits[0]!.score).toBeGreaterThan(0);
    expect(hits[0]!.metadata.snippet).toBe("snippet text");
  });

  it("filters by pathPrefix", async () => {
    const records = [
      makeRecord("docs1", [1, 0, 0, 0], { path: "/docs/intro" }),
      makeRecord("blog1", [0.9, 0.1, 0, 0], { path: "/blog/post" })
    ];

    await store.upsert(records, scopeA);

    const hits = await store.query([1, 0, 0, 0], { topK: 10, pathPrefix: "/docs" }, scopeA);
    expect(hits.every((h) => h.metadata.path.startsWith("/docs"))).toBe(true);
    expect(hits.some((h) => h.id === "docs1")).toBe(true);
  });

  it("filters by tags", async () => {
    const records = [
      makeRecord("tagged", [1, 0, 0, 0], { tags: ["guide", "tutorial"] }),
      makeRecord("untagged", [0.9, 0.1, 0, 0], { tags: [] })
    ];

    await store.upsert(records, scopeA);

    const hits = await store.query([1, 0, 0, 0], { topK: 10, tags: ["guide"] }, scopeA);
    expect(hits.every((h) => h.metadata.tags.includes("guide"))).toBe(true);
  });

  it("isolates scopes", async () => {
    await store.upsert([makeRecord("a1", [1, 0, 0, 0])], scopeA);
    await store.upsert(
      [makeRecord("b1", [1, 0, 0, 0], { scopeName: "staging" })],
      scopeB
    );

    const hitsA = await store.query([1, 0, 0, 0], { topK: 10 }, scopeA);
    expect(hitsA.map((h) => h.id)).toContain("a1");
    expect(hitsA.map((h) => h.id)).not.toContain("b1");
  });

  it("deletes by IDs", async () => {
    const records = [
      makeRecord("d1", [1, 0, 0, 0]),
      makeRecord("d2", [0, 1, 0, 0])
    ];

    await store.upsert(records, scopeA);
    await store.deleteByIds(["d1"], scopeA);

    const hits = await store.query([1, 0, 0, 0], { topK: 10 }, scopeA);
    expect(hits.map((h) => h.id)).not.toContain("d1");
    expect(hits.map((h) => h.id)).toContain("d2");
  });

  it("deletes scope", async () => {
    await store.upsert([makeRecord("s1", [1, 0, 0, 0])], scopeA);
    await store.recordScope({
      projectId: "proj",
      scopeName: "main",
      modelId: "text-embedding-3-small",
      lastIndexedAt: new Date().toISOString(),
      vectorCount: 1
    });

    await store.deleteScope(scopeA);

    const hits = await store.query([1, 0, 0, 0], { topK: 10 }, scopeA);
    expect(hits).toHaveLength(0);

    const scopes = await store.listScopes("proj");
    expect(scopes.find((s) => s.scopeName === "main")).toBeUndefined();
  });

  it("records and lists scopes", async () => {
    const info: ScopeInfo = {
      projectId: "proj",
      scopeName: "main",
      modelId: "text-embedding-3-small",
      lastIndexedAt: "2025-01-01T00:00:00Z",
      vectorCount: 42
    };

    await store.recordScope(info);

    const scopes = await store.listScopes("proj");
    expect(scopes).toHaveLength(1);
    expect(scopes[0]!.scopeName).toBe("main");
    expect(scopes[0]!.vectorCount).toBe(42);
  });

  it("health check returns ok", async () => {
    const result = await store.health();
    expect(result).toEqual({ ok: true });
  });

  it("upsert updates existing records", async () => {
    await store.upsert(
      [makeRecord("u1", [1, 0, 0, 0], { snippet: "original" })],
      scopeA
    );

    await store.upsert(
      [makeRecord("u1", [1, 0, 0, 0], { snippet: "updated" })],
      scopeA
    );

    const hits = await store.query([1, 0, 0, 0], { topK: 10 }, scopeA);
    const hit = hits.find((h) => h.id === "u1");
    expect(hit).toBeDefined();
    expect(hit!.metadata.snippet).toBe("updated");
  });
});
