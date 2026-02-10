import { describe, expect, it, vi } from "vitest";
import { PineconeVectorStore } from "../src/vector/pinecone";
import type { Scope, VectorRecord } from "../src/types";

const scope: Scope = {
  projectId: "searchsocket-test",
  scopeName: "main",
  scopeId: "searchsocket-test:main"
};

function makeRecord(id: string, pathValue: string): VectorRecord {
  return {
    id,
    vector: [0.1, 0.2, 0.3],
    metadata: {
      projectId: scope.projectId,
      scopeName: scope.scopeName,
      url: pathValue,
      path: pathValue,
      title: "Page",
      sectionTitle: "Section",
      headingPath: ["Docs", "Page"],
      snippet: "snippet",
      contentHash: "hash",
      modelId: "text-embedding-3-small",
      depth: 2,
      incomingLinks: 3,
      routeFile: "src/routes/docs/page/+page.svelte",
      tags: ["docs"]
    }
  };
}

describe("PineconeVectorStore", () => {
  it("upserts/query records with namespace and prefix/tag filters", async () => {
    const upsert = vi.fn().mockResolvedValue(undefined);
    const query = vi.fn().mockResolvedValue({
      matches: [
        {
          id: "chunk-1",
          score: 0.91,
          metadata: {
            projectId: "searchsocket-test",
            scopeName: "main",
            url: "/docs/page",
            path: "/docs/page",
            title: "Page",
            sectionTitle: "Section",
            headingPath: ["Docs", "Page"],
            snippet: "snippet",
            contentHash: "hash",
            modelId: "text-embedding-3-small",
            depth: 2,
            incomingLinks: 1,
            routeFile: "src/routes/docs/page/+page.svelte",
            tags: ["docs"]
          }
        }
      ]
    });

    const fakeIndex = {
      upsert,
      query,
      deleteMany: vi.fn().mockResolvedValue(undefined),
      deleteAll: vi.fn().mockResolvedValue(undefined),
      describeIndexStats: vi.fn().mockResolvedValue({ dimension: 3 }),
      listPaginated: vi.fn().mockResolvedValue({ vectors: [], pagination: {} }),
      fetch: vi.fn().mockResolvedValue({ records: {} })
    };

    const store = new PineconeVectorStore({
      apiKey: "pc-test",
      indexName: "searchsocket",
      embeddingModel: "text-embedding-3-small",
      index: fakeIndex
    });

    await store.upsert([makeRecord("chunk-1", "/docs/page")], scope);
    const hits = await store.query([0.1, 0.2, 0.3], { topK: 5, pathPrefix: "/docs", tags: ["docs"] }, scope);

    expect(upsert).toHaveBeenCalledTimes(1);
    const upsertArgs = upsert.mock.calls[0]?.[0] as { namespace?: string; records?: Array<{ metadata?: Record<string, unknown> }> };
    expect(upsertArgs.namespace).toBe("main");
    expect(upsertArgs.records?.[0]?.metadata?.dir0).toBe("docs");
    expect(upsertArgs.records?.[0]?.metadata?.tags).toEqual(["docs"]);
    expect(upsertArgs.records?.[0]?.metadata).not.toHaveProperty("tag_docs");

    expect(query).toHaveBeenCalledTimes(1);
    const queryArgs = query.mock.calls[0]?.[0] as { filter?: { $and?: Array<Record<string, unknown>> } };
    const clauses = queryArgs.filter?.$and ?? [];
    expect(clauses).toContainEqual({ projectId: { $eq: "searchsocket-test" } });
    expect(clauses).toContainEqual({ scopeName: { $eq: "main" } });
    expect(clauses).toContainEqual({ dir0: { $eq: "docs" } });
    expect(clauses).toContainEqual({ tags: { $in: ["docs"] } });

    expect(hits.length).toBe(1);
    expect(hits[0]?.metadata.url).toBe("/docs/page");
  });

  it("builds an all-tags filter when multiple tags are requested", async () => {
    const query = vi.fn().mockResolvedValue({ matches: [] });

    const fakeIndex = {
      upsert: vi.fn().mockResolvedValue(undefined),
      query,
      deleteMany: vi.fn().mockResolvedValue(undefined),
      deleteAll: vi.fn().mockResolvedValue(undefined),
      describeIndexStats: vi.fn().mockResolvedValue({ dimension: 3 }),
      listPaginated: vi.fn().mockResolvedValue({ vectors: [], pagination: {} }),
      fetch: vi.fn().mockResolvedValue({ records: {} })
    };

    const store = new PineconeVectorStore({
      apiKey: "pc-test",
      indexName: "searchsocket",
      embeddingModel: "text-embedding-3-small",
      index: fakeIndex
    });

    await store.query([0.1, 0.2, 0.3], { topK: 5, pathPrefix: "/docs", tags: ["docs", "guide"] }, scope);

    const queryArgs = query.mock.calls[0]?.[0] as { filter?: { $and?: Array<Record<string, unknown>> } };
    const clauses = queryArgs.filter?.$and ?? [];

    expect(clauses).toContainEqual({ tags: { $in: ["docs"] } });
    expect(clauses).toContainEqual({ tags: { $in: ["guide"] } });
  });
});
