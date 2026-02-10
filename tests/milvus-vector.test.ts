import { describe, expect, it, vi } from "vitest";
import { MilvusVectorStore } from "../src/vector/milvus";
import type { Scope, VectorRecord } from "../src/types";

const scope: Scope = {
  projectId: "searchsocket-test",
  scopeName: "main",
  scopeId: "searchsocket-test:main"
};

function makeRecord(id: string): VectorRecord {
  return {
    id,
    vector: [0.1, 0.2, 0.3],
    metadata: {
      projectId: scope.projectId,
      scopeName: scope.scopeName,
      url: "/docs/page",
      path: "/docs/page",
      title: "Page",
      sectionTitle: "Section",
      headingPath: ["Docs", "Page"],
      snippet: "snippet",
      contentHash: "hash",
      modelId: "text-embedding-3-small",
      depth: 2,
      incomingLinks: 3,
      routeFile: "src/routes/docs/page/+page.svelte",
      tags: ["docs", "guide"]
    }
  };
}

describe("MilvusVectorStore", () => {
  it("builds expected filters for scoped search", async () => {
    const search = vi.fn().mockResolvedValue({
      results: [
        {
          id: "chunk-1",
          score: 0.88,
          projectId: scope.projectId,
          scopeName: scope.scopeName,
          url: "/docs/page",
          path: "/docs/page",
          title: "Page",
          sectionTitle: "Section",
          headingPath: JSON.stringify(["Docs", "Page"]),
          snippet: "snippet",
          contentHash: "hash",
          modelId: "text-embedding-3-small",
          depth: 2,
          incomingLinks: 3,
          routeFile: "src/routes/docs/page/+page.svelte",
          tags: JSON.stringify(["docs", "guide"])
        }
      ]
    });

    const fakeClient = {
      hasCollection: vi.fn().mockResolvedValue({ value: true }),
      createCollection: vi.fn(),
      createIndex: vi.fn(),
      loadCollection: vi.fn(),
      upsert: vi.fn(),
      search,
      delete: vi.fn(),
      query: vi.fn().mockResolvedValue({ data: [] }),
      showCollections: vi.fn()
    };

    const store = new MilvusVectorStore({
      address: "http://localhost:19530",
      collectionName: "searchsocket_chunks",
      registryCollectionName: "searchsocket_registry",
      client: fakeClient
    });

    const hits = await store.query([0.1, 0.2, 0.3], { topK: 10, pathPrefix: "/docs", tags: ["docs"] }, scope);

    expect(hits.length).toBe(1);
    expect(search).toHaveBeenCalledTimes(1);

    const args = search.mock.calls[0]?.[0] as { filter?: string };
    expect(args.filter).toContain("projectId == \"searchsocket-test\"");
    expect(args.filter).toContain("scopeName == \"main\"");
    expect(args.filter).toContain("(path == \"/docs\" or path like \"/docs/%\")");
    expect(args.filter).toContain("tags like \"%\\\"docs\\\"%\"");
  });

  it("normalizes pathPrefix values that omit a leading slash", async () => {
    const search = vi.fn().mockResolvedValue({ results: [] });

    const fakeClient = {
      hasCollection: vi.fn().mockResolvedValue({ value: true }),
      createCollection: vi.fn(),
      createIndex: vi.fn(),
      loadCollection: vi.fn(),
      upsert: vi.fn(),
      search,
      delete: vi.fn(),
      query: vi.fn().mockResolvedValue({ data: [] }),
      showCollections: vi.fn()
    };

    const store = new MilvusVectorStore({
      address: "http://localhost:19530",
      collectionName: "searchsocket_chunks",
      registryCollectionName: "searchsocket_registry",
      client: fakeClient
    });

    await store.query([0.1, 0.2, 0.3], { topK: 10, pathPrefix: "docs" }, scope);

    const args = search.mock.calls[0]?.[0] as { filter?: string };
    expect(args.filter).toContain("(path == \"/docs\" or path like \"/docs/%\")");
  });

  it("creates collection and upserts records", async () => {
    const fakeClient = {
      hasCollection: vi.fn().mockResolvedValue({ value: false }),
      createCollection: vi.fn().mockResolvedValue({}),
      createIndex: vi.fn().mockResolvedValue({}),
      loadCollection: vi.fn().mockResolvedValue({}),
      upsert: vi.fn().mockResolvedValue({}),
      search: vi.fn().mockResolvedValue({ results: [] }),
      delete: vi.fn().mockResolvedValue({}),
      query: vi.fn().mockResolvedValue({ data: [] }),
      showCollections: vi.fn().mockResolvedValue({})
    };

    const store = new MilvusVectorStore({
      address: "http://localhost:19530",
      collectionName: "searchsocket_chunks",
      registryCollectionName: "searchsocket_registry",
      client: fakeClient
    });

    await store.upsert([makeRecord("chunk-1")], scope);

    expect(fakeClient.createCollection).toHaveBeenCalledTimes(1);
    expect(fakeClient.createIndex).toHaveBeenCalledTimes(1);
    expect(fakeClient.upsert).toHaveBeenCalledTimes(1);
  });

  it("paginates registry scope listing beyond 1000 rows", async () => {
    const pageA = Array.from({ length: 1000 }, (_v, i) => ({
      projectId: "searchsocket-test",
      scopeName: `scope-${i}`,
      modelId: "text-embedding-3-small",
      lastIndexedAt: "2026-01-01T00:00:00.000Z",
      vectorCount: i
    }));
    const pageB = [
      {
        projectId: "searchsocket-test",
        scopeName: "scope-1000",
        modelId: "text-embedding-3-small",
        lastIndexedAt: "2026-01-01T00:00:00.000Z",
        vectorCount: 1000
      },
      {
        projectId: "searchsocket-test",
        scopeName: "scope-1001",
        modelId: "text-embedding-3-small",
        lastIndexedAt: "2026-01-01T00:00:00.000Z",
        vectorCount: 1001
      }
    ];

    const query = vi
      .fn()
      .mockResolvedValueOnce({ data: pageA })
      .mockResolvedValueOnce({ data: pageB });

    const fakeClient = {
      hasCollection: vi.fn().mockResolvedValue({ value: true }),
      createCollection: vi.fn().mockResolvedValue({}),
      createIndex: vi.fn().mockResolvedValue({}),
      loadCollection: vi.fn().mockResolvedValue({}),
      upsert: vi.fn().mockResolvedValue({}),
      search: vi.fn().mockResolvedValue({ results: [] }),
      delete: vi.fn().mockResolvedValue({}),
      query,
      showCollections: vi.fn().mockResolvedValue({})
    };

    const store = new MilvusVectorStore({
      address: "http://localhost:19530",
      collectionName: "searchsocket_chunks",
      registryCollectionName: "searchsocket_registry",
      client: fakeClient
    });

    const scopes = await store.listScopes("searchsocket-test");

    expect(scopes).toHaveLength(1002);
    expect(query).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        limit: 1000,
        offset: 0
      })
    );
    expect(query).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        limit: 1000,
        offset: 1000
      })
    );
  });
});
