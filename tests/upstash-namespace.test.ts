import { describe, expect, it, vi } from "vitest";
import { UpstashSearchStore } from "../src/vector/upstash";
import { QueryMode } from "@upstash/vector";
import type { Index } from "@upstash/vector";
import type { Scope } from "../src/types";

interface FakeVector {
  id: string;
  metadata: Record<string, unknown>;
}

function createFakeNamespace() {
  return {
    upsert: vi.fn(async () => undefined),
    query: vi.fn(async () => []),
    fetch: vi.fn(async () => []),
    range: vi.fn(async () => ({ vectors: [] as FakeVector[], nextCursor: "0" })),
    delete: vi.fn(async () => undefined)
  };
}

function createFakeIndex() {
  const pagesNs = createFakeNamespace();
  const chunksNs = createFakeNamespace();
  const namespaceMap: Record<string, ReturnType<typeof createFakeNamespace>> = {
    pages: pagesNs,
    chunks: chunksNs
  };

  const index = {
    namespace: vi.fn((name: string) => namespaceMap[name]),
    info: vi.fn(async () => ({ vectorCount: 0, pendingVectorCount: 0, indexSize: 0, dimension: 1024, similarityFunction: "COSINE" })),
    listNamespaces: vi.fn(async () => ["pages", "chunks"]),
    deleteNamespace: vi.fn(async () => "Success")
  } as unknown as Index;

  return { index, pagesNs, chunksNs };
}

const scope: Scope = { projectId: "test-project", scopeName: "main", scopeId: "test-project:main" };

describe("UpstashSearchStore namespace routing", () => {
  it("routes upsertChunks to chunks namespace", async () => {
    const { index, chunksNs, pagesNs } = createFakeIndex();
    const store = new UpstashSearchStore({ index, pagesNamespace: "pages", chunksNamespace: "chunks" });

    await store.upsertChunks(
      [{ id: "c1", data: "test text", metadata: { url: "/test" } }],
      scope
    );

    expect(chunksNs.upsert).toHaveBeenCalledTimes(1);
    expect(pagesNs.upsert).not.toHaveBeenCalled();
    // Verify type metadata is preserved for debugging
    const call = chunksNs.upsert.mock.lastCall as unknown as [Array<{ metadata: Record<string, unknown> }>];
    expect(call[0][0]!.metadata.type).toBe("chunk");
  });

  it("routes upsertPages to pages namespace", async () => {
    const { index, chunksNs, pagesNs } = createFakeIndex();
    const store = new UpstashSearchStore({ index, pagesNamespace: "pages", chunksNamespace: "chunks" });

    await store.upsertPages(
      [{ id: "p1", data: "test text", metadata: { url: "/test" } }],
      scope
    );

    expect(pagesNs.upsert).toHaveBeenCalledTimes(1);
    expect(chunksNs.upsert).not.toHaveBeenCalled();
    const call = pagesNs.upsert.mock.lastCall as unknown as [Array<{ metadata: Record<string, unknown> }>];
    expect(call[0][0]!.metadata.type).toBe("page");
  });

  it("routes search to chunks namespace without type filter", async () => {
    const { index, chunksNs } = createFakeIndex();
    const store = new UpstashSearchStore({ index, pagesNamespace: "pages", chunksNamespace: "chunks" });

    await store.search("test query", { limit: 10 }, scope);

    expect(chunksNs.query).toHaveBeenCalledTimes(1);
    const queryArgs = (chunksNs.query.mock.lastCall as unknown as [{ filter: string; data: string }])[0];
    expect(queryArgs.data).toBe("test query");
    expect(queryArgs.filter).not.toContain("type");
    expect(queryArgs.filter).toContain("projectId = 'test-project'");
    expect(queryArgs.filter).toContain("scopeName = 'main'");
  });

  it("routes searchPagesByText to pages namespace without type filter", async () => {
    const { index, pagesNs } = createFakeIndex();
    const store = new UpstashSearchStore({ index, pagesNamespace: "pages", chunksNamespace: "chunks" });

    await store.searchPagesByText("test query", { limit: 10 }, scope);

    expect(pagesNs.query).toHaveBeenCalledTimes(1);
    const queryArgs = (pagesNs.query.mock.lastCall as unknown as [{ filter: string; data: string }])[0];
    expect(queryArgs.data).toBe("test query");
    expect(queryArgs.filter).not.toContain("type");
  });

  it("routes searchPagesByVector to pages namespace with vector", async () => {
    const { index, pagesNs } = createFakeIndex();
    const store = new UpstashSearchStore({ index, pagesNamespace: "pages", chunksNamespace: "chunks" });

    await store.searchPagesByVector([0.1, 0.2], { limit: 10 }, scope);

    expect(pagesNs.query).toHaveBeenCalledTimes(1);
    const queryArgs = (pagesNs.query.mock.lastCall as unknown as [{ filter: string; vector: number[] }])[0];
    expect(queryArgs.vector).toEqual([0.1, 0.2]);
    expect(queryArgs.filter).not.toContain("type");
  });

  it("routes searchChunksByUrl to chunks namespace without type filter", async () => {
    const { index, chunksNs } = createFakeIndex();
    const store = new UpstashSearchStore({ index, pagesNamespace: "pages", chunksNamespace: "chunks" });

    await store.searchChunksByUrl("test query", "/test", { limit: 10 }, scope);

    expect(chunksNs.query).toHaveBeenCalledTimes(1);
    const queryArgs = (chunksNs.query.mock.lastCall as unknown as [{ filter: string; data: string }])[0];
    expect(queryArgs.data).toBe("test query");
    expect(queryArgs.filter).not.toContain("type");
    expect(queryArgs.filter).toContain("url = '/test'");
  });

  it("routes deleteByIds to chunks namespace", async () => {
    const { index, chunksNs, pagesNs } = createFakeIndex();
    const store = new UpstashSearchStore({ index, pagesNamespace: "pages", chunksNamespace: "chunks" });

    await store.deleteByIds(["c1", "c2"], scope);

    expect(chunksNs.delete).toHaveBeenCalledWith(["c1", "c2"]);
    expect(pagesNs.delete).not.toHaveBeenCalled();
  });

  it("routes deletePagesByIds to pages namespace", async () => {
    const { index, chunksNs, pagesNs } = createFakeIndex();
    const store = new UpstashSearchStore({ index, pagesNamespace: "pages", chunksNamespace: "chunks" });

    await store.deletePagesByIds(["p1", "p2"], scope);

    expect(pagesNs.delete).toHaveBeenCalledWith(["p1", "p2"]);
    expect(chunksNs.delete).not.toHaveBeenCalled();
  });

  it("routes getPage to pages namespace", async () => {
    const { index, pagesNs, chunksNs } = createFakeIndex();
    const store = new UpstashSearchStore({ index, pagesNamespace: "pages", chunksNamespace: "chunks" });

    await store.getPage("/test", scope);

    expect(pagesNs.fetch).toHaveBeenCalled();
    expect(chunksNs.fetch).not.toHaveBeenCalled();
  });

  it("routes getContentHashes to chunks namespace", async () => {
    const { index, chunksNs, pagesNs } = createFakeIndex();
    const store = new UpstashSearchStore({ index, pagesNamespace: "pages", chunksNamespace: "chunks" });

    await store.getContentHashes(scope);

    expect(chunksNs.range).toHaveBeenCalled();
    expect(pagesNs.range).not.toHaveBeenCalled();
  });

  it("routes getPageHashes to pages namespace", async () => {
    const { index, chunksNs, pagesNs } = createFakeIndex();
    const store = new UpstashSearchStore({ index, pagesNamespace: "pages", chunksNamespace: "chunks" });

    await store.getPageHashes(scope);

    expect(pagesNs.range).toHaveBeenCalled();
    expect(chunksNs.range).not.toHaveBeenCalled();
  });

  it("health uses index.info() not namespace methods", async () => {
    const { index, pagesNs, chunksNs } = createFakeIndex();
    const store = new UpstashSearchStore({ index, pagesNamespace: "pages", chunksNamespace: "chunks" });

    const result = await store.health();

    expect(result.ok).toBe(true);
    expect(index.info).toHaveBeenCalled();
    expect(pagesNs.range).not.toHaveBeenCalled();
    expect(chunksNs.range).not.toHaveBeenCalled();
  });

  it("deleteScope scans both namespaces", async () => {
    const { index, chunksNs, pagesNs } = createFakeIndex();
    chunksNs.range.mockResolvedValueOnce({
      vectors: [{ id: "c1", metadata: { projectId: "test-project", scopeName: "main" } }] as FakeVector[],
      nextCursor: "0"
    });
    pagesNs.range.mockResolvedValueOnce({
      vectors: [{ id: "p1", metadata: { projectId: "test-project", scopeName: "main" } }] as FakeVector[],
      nextCursor: "0"
    });

    const store = new UpstashSearchStore({ index, pagesNamespace: "pages", chunksNamespace: "chunks" });
    await store.deleteScope(scope);

    expect(chunksNs.range).toHaveBeenCalled();
    expect(pagesNs.range).toHaveBeenCalled();
    expect(chunksNs.delete).toHaveBeenCalledWith(["c1"]);
    expect(pagesNs.delete).toHaveBeenCalledWith(["p1"]);
  });

  it("listScopes scans both namespaces and sums counts", async () => {
    const { index, chunksNs, pagesNs } = createFakeIndex();
    chunksNs.range.mockResolvedValueOnce({
      vectors: [
        { id: "c1", metadata: { projectId: "test-project", scopeName: "main" } },
        { id: "c2", metadata: { projectId: "test-project", scopeName: "main" } }
      ] as FakeVector[],
      nextCursor: "0"
    });
    pagesNs.range.mockResolvedValueOnce({
      vectors: [
        { id: "p1", metadata: { projectId: "test-project", scopeName: "main" } }
      ] as FakeVector[],
      nextCursor: "0"
    });

    const store = new UpstashSearchStore({ index, pagesNamespace: "pages", chunksNamespace: "chunks" });
    const scopes = await store.listScopes("test-project");

    expect(scopes).toHaveLength(1);
    expect(scopes[0]!.scopeName).toBe("main");
    expect(scopes[0]!.documentCount).toBe(3);
  });

  it("dropAllIndexes scans both namespaces filtered by projectId", async () => {
    const { index, chunksNs, pagesNs } = createFakeIndex();
    chunksNs.range.mockResolvedValueOnce({
      vectors: [
        { id: "c1", metadata: { projectId: "test-project" } },
        { id: "c2", metadata: { projectId: "other-project" } }
      ] as FakeVector[],
      nextCursor: "0"
    });
    pagesNs.range.mockResolvedValueOnce({
      vectors: [
        { id: "p1", metadata: { projectId: "test-project" } }
      ] as FakeVector[],
      nextCursor: "0"
    });

    const store = new UpstashSearchStore({ index, pagesNamespace: "pages", chunksNamespace: "chunks" });
    await store.dropAllIndexes("test-project");

    // Only test-project vectors should be deleted
    expect(chunksNs.delete).toHaveBeenCalledWith(["c1"]);
    expect(pagesNs.delete).toHaveBeenCalledWith(["p1"]);
    // deleteNamespace should NOT be called
    expect(index.deleteNamespace).not.toHaveBeenCalled();
  });

  it("handles empty ID arrays as no-ops", async () => {
    const { index, chunksNs, pagesNs } = createFakeIndex();
    const store = new UpstashSearchStore({ index, pagesNamespace: "pages", chunksNamespace: "chunks" });

    await store.deleteByIds([], scope);
    await store.deletePagesByIds([], scope);
    await store.upsertChunks([], scope);
    await store.upsertPages([], scope);

    expect(chunksNs.delete).not.toHaveBeenCalled();
    expect(pagesNs.delete).not.toHaveBeenCalled();
    expect(chunksNs.upsert).not.toHaveBeenCalled();
    expect(pagesNs.upsert).not.toHaveBeenCalled();
  });

  it("supports custom namespace names", async () => {
    const customPagesNs = createFakeNamespace();
    const customChunksNs = createFakeNamespace();
    const index = {
      namespace: vi.fn((name: string) => {
        if (name === "my-pages") return customPagesNs;
        if (name === "my-chunks") return customChunksNs;
        return createFakeNamespace();
      }),
      info: vi.fn(async () => ({}))
    } as unknown as Index;

    const store = new UpstashSearchStore({ index, pagesNamespace: "my-pages", chunksNamespace: "my-chunks" });

    await store.upsertPages([{ id: "p1", data: "test text", metadata: {} }], scope);
    await store.upsertChunks([{ id: "c1", data: "test text", metadata: {} }], scope);

    expect(customPagesNs.upsert).toHaveBeenCalledTimes(1);
    expect(customChunksNs.upsert).toHaveBeenCalledTimes(1);
    expect(index.namespace).toHaveBeenCalledWith("my-pages");
    expect(index.namespace).toHaveBeenCalledWith("my-chunks");
  });
});

describe("UpstashSearchStore hybrid query mode", () => {
  it("search() always passes queryMode HYBRID", async () => {
    const { index, chunksNs } = createFakeIndex();
    const store = new UpstashSearchStore({ index, pagesNamespace: "pages", chunksNamespace: "chunks" });

    await store.search("test query", { limit: 10 }, scope);

    const queryArgs = (chunksNs.query.mock.lastCall as unknown as [Record<string, unknown>])[0];
    expect(queryArgs.queryMode).toBe(QueryMode.HYBRID);
  });

  it("searchChunksByUrl() always passes queryMode HYBRID", async () => {
    const { index, chunksNs } = createFakeIndex();
    const store = new UpstashSearchStore({ index, pagesNamespace: "pages", chunksNamespace: "chunks" });

    await store.searchChunksByUrl("test query", "/test", { limit: 10 }, scope);

    const queryArgs = (chunksNs.query.mock.lastCall as unknown as [Record<string, unknown>])[0];
    expect(queryArgs.queryMode).toBe(QueryMode.HYBRID);
  });

  it("searchPagesByText() passes queryMode HYBRID", async () => {
    const { index, pagesNs } = createFakeIndex();
    const store = new UpstashSearchStore({ index, pagesNamespace: "pages", chunksNamespace: "chunks" });

    await store.searchPagesByText("test query", { limit: 10 }, scope);

    const queryArgs = (pagesNs.query.mock.lastCall as unknown as [Record<string, unknown>])[0];
    expect(queryArgs.queryMode).toBe(QueryMode.HYBRID);
  });

  it("searchPagesByVector() passes queryMode HYBRID", async () => {
    const { index, pagesNs } = createFakeIndex();
    const store = new UpstashSearchStore({ index, pagesNamespace: "pages", chunksNamespace: "chunks" });

    await store.searchPagesByVector([0.1, 0.2], { limit: 10 }, scope);

    const queryArgs = (pagesNs.query.mock.lastCall as unknown as [Record<string, unknown>])[0];
    expect(queryArgs.queryMode).toBe(QueryMode.HYBRID);
  });
});
