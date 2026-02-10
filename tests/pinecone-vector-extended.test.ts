import { describe, expect, it, vi } from "vitest";
import { PineconeVectorStore } from "../src/vector/pinecone";
import type { Scope, VectorRecord } from "../src/types";

const scope: Scope = {
  projectId: "searchsocket-test",
  scopeName: "main",
  scopeId: "searchsocket-test:main"
};

function makeRecord(id: string, snippet: string): VectorRecord {
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
      snippet,
      contentHash: "hash",
      modelId: "text-embedding-3-small",
      depth: 2,
      incomingLinks: 3,
      routeFile: "src/routes/docs/page/+page.svelte",
      tags: ["docs"]
    }
  };
}

describe("PineconeVectorStore - extended", () => {
  it("truncates snippet metadata by UTF-8 byte length for multi-byte text", async () => {
    const upsert = vi.fn().mockResolvedValue(undefined);
    const fakeIndex = {
      upsert,
      query: vi.fn().mockResolvedValue({ matches: [] }),
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

    await store.upsert([makeRecord("chunk-1", "😀".repeat(4000))], scope);

    const args = upsert.mock.calls[0]?.[0] as {
      records?: Array<{ metadata?: { snippet?: string } }>;
    };
    const snippet = args.records?.[0]?.metadata?.snippet ?? "";
    expect(Buffer.byteLength(snippet, "utf8")).toBeLessThanOrEqual(8000);
  });

  it("falls back to query-based registry lookup when list API is unavailable", async () => {
    const query = vi.fn().mockResolvedValue({
      matches: [
        {
          id: "searchsocket-test:main",
          metadata: {
            projectId: "searchsocket-test",
            scopeName: "main",
            modelId: "text-embedding-3-small",
            lastIndexedAt: "2026-01-01T00:00:00.000Z",
            vectorCount: 42
          }
        }
      ]
    });

    const fakeIndex = {
      upsert: vi.fn().mockResolvedValue(undefined),
      query,
      deleteMany: vi.fn().mockResolvedValue(undefined),
      deleteAll: vi.fn().mockResolvedValue(undefined),
      describeIndexStats: vi.fn().mockRejectedValue(new Error("stats unavailable")),
      listPaginated: vi.fn().mockRejectedValue(new Error("list unavailable")),
      fetch: vi.fn().mockResolvedValue({ records: {} })
    };

    const store = new PineconeVectorStore({
      apiKey: "pc-test",
      indexName: "searchsocket",
      embeddingModel: "text-embedding-3-small",
      index: fakeIndex
    });

    const scopes = await store.listScopes("searchsocket-test");
    expect(scopes).toEqual([
      {
        projectId: "searchsocket-test",
        scopeName: "main",
        modelId: "text-embedding-3-small",
        lastIndexedAt: "2026-01-01T00:00:00.000Z",
        vectorCount: 42
      }
    ]);
  });
});
