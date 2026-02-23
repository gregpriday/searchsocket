import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createClient } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TursoVectorStore } from "../src/vector/turso";
import type { PageRecord, Scope, ScopeInfo, VectorRecord } from "../src/types";

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
  const client = createClient({ url: `file:${dbPath}` });
  store = new TursoVectorStore({ client, dimension: DIM });
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

  it("getContentHashes returns id->hash map from chunks", async () => {
    await store.upsert(
      [
        makeRecord("ch1", [1, 0, 0, 0], { contentHash: "hash-a" }),
        makeRecord("ch2", [0, 1, 0, 0], { contentHash: "hash-b" })
      ],
      scopeA
    );

    const hashes = await store.getContentHashes(scopeA);
    expect(hashes.size).toBe(2);
    expect(hashes.get("ch1")).toBe("hash-a");
    expect(hashes.get("ch2")).toBe("hash-b");
  });

  it("getContentHashes returns empty map when chunks table does not exist", async () => {
    const hashes = await store.getContentHashes(scopeA);
    expect(hashes.size).toBe(0);
  });

  it("upsertPages + getPage round-trip", async () => {
    const page: PageRecord = {
      url: "/docs/intro",
      title: "Intro",
      markdown: "# Intro\n\nWelcome.",
      projectId: "proj",
      scopeName: "main",
      routeFile: "src/routes/docs/intro/+page.svelte",
      routeResolution: "exact",
      incomingLinks: 3,
      outgoingLinks: 1,
      depth: 2,
      tags: ["guide"],
      indexedAt: "2026-01-01T00:00:00.000Z"
    };

    await store.upsertPages([page], scopeA);
    const result = await store.getPage("/docs/intro", scopeA);

    expect(result).not.toBeNull();
    expect(result!.url).toBe("/docs/intro");
    expect(result!.title).toBe("Intro");
    expect(result!.markdown).toBe("# Intro\n\nWelcome.");
    expect(result!.routeFile).toBe("src/routes/docs/intro/+page.svelte");
    expect(result!.routeResolution).toBe("exact");
    expect(result!.incomingLinks).toBe(3);
    expect(result!.outgoingLinks).toBe(1);
    expect(result!.depth).toBe(2);
    expect(result!.tags).toEqual(["guide"]);
    expect(result!.indexedAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("getPage returns null for missing page", async () => {
    const result = await store.getPage("/missing", scopeA);
    expect(result).toBeNull();
  });

  it("deletePages removes all pages for a scope", async () => {
    const pages: PageRecord[] = [
      {
        url: "/a", title: "A", markdown: "A", projectId: "proj", scopeName: "main",
        routeFile: "", routeResolution: "exact", incomingLinks: 0, outgoingLinks: 0,
        depth: 0, tags: [], indexedAt: "2026-01-01T00:00:00.000Z"
      },
      {
        url: "/b", title: "B", markdown: "B", projectId: "proj", scopeName: "main",
        routeFile: "", routeResolution: "exact", incomingLinks: 0, outgoingLinks: 0,
        depth: 0, tags: [], indexedAt: "2026-01-01T00:00:00.000Z"
      }
    ];

    await store.upsertPages(pages, scopeA);
    await store.deletePages(scopeA);

    expect(await store.getPage("/a", scopeA)).toBeNull();
    expect(await store.getPage("/b", scopeA)).toBeNull();
  });

  it("getScopeModelId returns model from registry", async () => {
    await store.recordScope({
      projectId: "proj",
      scopeName: "main",
      modelId: "text-embedding-3-small",
      lastIndexedAt: "2026-01-01T00:00:00.000Z",
      vectorCount: 10
    });

    const modelId = await store.getScopeModelId(scopeA);
    expect(modelId).toBe("text-embedding-3-small");
  });

  it("getScopeModelId returns null when scope not in registry", async () => {
    const modelId = await store.getScopeModelId(scopeA);
    expect(modelId).toBeNull();
  });

  it("recordScope and listScopes handle estimate fields", async () => {
    const info: ScopeInfo = {
      projectId: "proj",
      scopeName: "main",
      modelId: "text-embedding-3-small",
      lastIndexedAt: "2026-01-01T00:00:00.000Z",
      vectorCount: 42,
      lastEstimateTokens: 1000,
      lastEstimateCostUSD: 0.00002,
      lastEstimateChangedChunks: 5
    };

    await store.recordScope(info);
    const scopes = await store.listScopes("proj");
    expect(scopes).toHaveLength(1);
    expect(scopes[0]!.lastEstimateTokens).toBe(1000);
    expect(scopes[0]!.lastEstimateCostUSD).toBeCloseTo(0.00002);
    expect(scopes[0]!.lastEstimateChangedChunks).toBe(5);
  });
});
