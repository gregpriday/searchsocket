import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalVectorStore } from "../src/vector/local";
import type { Scope, ScopeInfo, VectorRecord } from "../src/types";

const tempDirs: string[] = [];
const scope: Scope = {
  projectId: "test-proj",
  scopeName: "main",
  scopeId: "test-proj:main"
};

const otherScope: Scope = {
  projectId: "test-proj",
  scopeName: "feature",
  scopeId: "test-proj:feature"
};

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "searchsocket-vec-"));
  tempDirs.push(dir);
  return dir;
}

function record(id: string, vector: number[], url: string, tags: string[] = []): VectorRecord {
  return {
    id,
    vector,
    metadata: {
      projectId: scope.projectId,
      scopeName: scope.scopeName,
      url,
      path: url,
      title: `Title ${id}`,
      sectionTitle: "",
      headingPath: [],
      snippet: `Snippet ${id}`,
      contentHash: `hash_${id}`,
      modelId: "text-embedding-3-small",
      depth: url.split("/").filter(Boolean).length,
      incomingLinks: 0,
      routeFile: "src/routes/+page.svelte",
      tags
    }
  };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

describe("LocalVectorStore contract", () => {
  it("upserts and queries records", async () => {
    const dir = await makeTempDir();
    const store = new LocalVectorStore(path.join(dir, "test.sqlite"));

    await store.upsert(
      [
        record("a", [1, 0, 0], "/docs/a"),
        record("b", [0, 1, 0], "/docs/b"),
        record("c", [0, 0, 1], "/blog/c")
      ],
      scope
    );

    const hits = await store.query([1, 0, 0], { topK: 10 }, scope);
    expect(hits.length).toBe(3);
    expect(hits[0]?.id).toBe("a"); // most similar
    expect(hits[0]?.score).toBeGreaterThan(0.9);
  });

  it("filters by pathPrefix", async () => {
    const dir = await makeTempDir();
    const store = new LocalVectorStore(path.join(dir, "test.sqlite"));

    await store.upsert(
      [
        record("a", [1, 0, 0], "/docs/a"),
        record("b", [0.9, 0.1, 0], "/blog/b")
      ],
      scope
    );

    const hits = await store.query([1, 0, 0], { topK: 10, pathPrefix: "/docs" }, scope);
    expect(hits.length).toBe(1);
    expect(hits[0]?.metadata.url).toBe("/docs/a");
  });

  it("filters by tags", async () => {
    const dir = await makeTempDir();
    const store = new LocalVectorStore(path.join(dir, "test.sqlite"));

    await store.upsert(
      [
        record("a", [1, 0, 0], "/docs/a", ["guide"]),
        record("b", [0.9, 0.1, 0], "/docs/b", ["api"])
      ],
      scope
    );

    const hits = await store.query([1, 0, 0], { topK: 10, tags: ["guide"] }, scope);
    expect(hits.length).toBe(1);
    expect(hits[0]?.metadata.url).toBe("/docs/a");
  });

  it("isolates scopes", async () => {
    const dir = await makeTempDir();
    const store = new LocalVectorStore(path.join(dir, "test.sqlite"));

    await store.upsert([record("a", [1, 0, 0], "/a")], scope);
    await store.upsert(
      [
        {
          ...record("b", [0, 1, 0], "/b"),
          metadata: { ...record("b", [0, 1, 0], "/b").metadata, scopeName: "feature" }
        }
      ],
      otherScope
    );

    const mainHits = await store.query([1, 0, 0], { topK: 10 }, scope);
    expect(mainHits.length).toBe(1);
    expect(mainHits[0]?.id).toBe("a");
  });

  it("deletes by ids", async () => {
    const dir = await makeTempDir();
    const store = new LocalVectorStore(path.join(dir, "test.sqlite"));

    await store.upsert(
      [record("a", [1, 0, 0], "/a"), record("b", [0, 1, 0], "/b")],
      scope
    );

    await store.deleteByIds(["a"], scope);

    const hits = await store.query([1, 0, 0], { topK: 10 }, scope);
    expect(hits.length).toBe(1);
    expect(hits[0]?.id).toBe("b");
  });

  it("deletes entire scope", async () => {
    const dir = await makeTempDir();
    const store = new LocalVectorStore(path.join(dir, "test.sqlite"));

    await store.upsert([record("a", [1, 0, 0], "/a")], scope);
    await store.deleteScope(scope);

    const hits = await store.query([1, 0, 0], { topK: 10 }, scope);
    expect(hits.length).toBe(0);
  });

  it("records and lists scopes via registry", async () => {
    const dir = await makeTempDir();
    const store = new LocalVectorStore(path.join(dir, "test.sqlite"));

    const info: ScopeInfo = {
      projectId: "test-proj",
      scopeName: "main",
      modelId: "text-embedding-3-small",
      lastIndexedAt: "2026-01-01T00:00:00.000Z",
      vectorCount: 10
    };

    await store.recordScope(info);
    const scopes = await store.listScopes("test-proj");
    expect(scopes).toHaveLength(1);
    expect(scopes[0]?.scopeName).toBe("main");
    expect(scopes[0]?.vectorCount).toBe(10);
  });

  it("deleteScope removes registry entry", async () => {
    const dir = await makeTempDir();
    const store = new LocalVectorStore(path.join(dir, "test.sqlite"));

    await store.recordScope({
      projectId: "test-proj",
      scopeName: "main",
      modelId: "text-embedding-3-small",
      lastIndexedAt: "2026-01-01T00:00:00.000Z",
      vectorCount: 10
    });

    await store.deleteScope(scope);
    const scopes = await store.listScopes("test-proj");
    expect(scopes).toHaveLength(0);
  });

  it("health returns ok", async () => {
    const dir = await makeTempDir();
    const store = new LocalVectorStore(path.join(dir, "test.sqlite"));
    const health = await store.health();
    expect(health.ok).toBe(true);
  });

  it("upserts update existing records", async () => {
    const dir = await makeTempDir();
    const store = new LocalVectorStore(path.join(dir, "test.sqlite"));

    await store.upsert([record("a", [1, 0, 0], "/old")], scope);
    await store.upsert([record("a", [0, 1, 0], "/new")], scope);

    const hits = await store.query([0, 1, 0], { topK: 10 }, scope);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.metadata.url).toBe("/new");
  });
});
