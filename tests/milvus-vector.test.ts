import { describe, expect, it, vi } from "vitest";
import { MilvusVectorStore } from "../src/vector/milvus";
import type { Scope, VectorRecord } from "../src/types";

const scope: Scope = {
  projectId: "sitescribe-test",
  scopeName: "main",
  scopeId: "sitescribe-test:main"
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
      collectionName: "sitescribe_chunks",
      registryCollectionName: "sitescribe_registry",
      client: fakeClient
    });

    const hits = await store.query([0.1, 0.2, 0.3], { topK: 10, pathPrefix: "/docs", tags: ["docs"] }, scope);

    expect(hits.length).toBe(1);
    expect(search).toHaveBeenCalledTimes(1);

    const args = search.mock.calls[0]?.[0] as { filter?: string };
    expect(args.filter).toContain("projectId == \"sitescribe-test\"");
    expect(args.filter).toContain("scopeName == \"main\"");
    expect(args.filter).toContain("(path == \"/docs\" or path like \"/docs/%\")");
    expect(args.filter).toContain("tags like \"%\\\"docs\\\"%\"");
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
      collectionName: "sitescribe_chunks",
      registryCollectionName: "sitescribe_registry",
      client: fakeClient
    });

    await store.upsert([makeRecord("chunk-1")], scope);

    expect(fakeClient.createCollection).toHaveBeenCalledTimes(1);
    expect(fakeClient.createIndex).toHaveBeenCalledTimes(1);
    expect(fakeClient.upsert).toHaveBeenCalledTimes(1);
  });
});
