import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultConfig } from "../src/config/defaults";
import type { EmbeddingsProvider, Scope, ScopeInfo, VectorHit, VectorRecord, VectorStore } from "../src/types";

const mocks = vi.hoisted(() => {
  return {
    createReranker: vi.fn(() => ({ rerank: vi.fn() }))
  };
});

vi.mock("../src/rerank", () => {
  return {
    createReranker: mocks.createReranker
  };
});

import { SearchEngine } from "../src/search/engine";

const fakeEmbeddings: EmbeddingsProvider = {
  estimateTokens: (text: string) => text.length,
  embedTexts: async () => [[1, 0, 0]]
};

const fakeStore: VectorStore = {
  upsert: async (_records: VectorRecord[], _scope: Scope) => undefined,
  query: async () => [] as VectorHit[],
  deleteByIds: async () => undefined,
  deleteScope: async () => undefined,
  listScopes: async () => [] as ScopeInfo[],
  recordScope: async () => undefined,
  health: async () => ({ ok: true }),
  getContentHashes: async () => new Map<string, string>(),
  upsertPages: async () => undefined,
  getPage: async () => null,
  deletePages: async () => undefined,
  getScopeModelId: async () => null
};

describe("SearchEngine.create options", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not create a reranker when reranker is explicitly null", async () => {
    const config = createDefaultConfig("searchsocket-engine-create");

    await SearchEngine.create({
      config,
      embeddingsProvider: fakeEmbeddings,
      vectorStore: fakeStore,
      reranker: null
    });

    expect(mocks.createReranker).not.toHaveBeenCalled();
  });

  it("creates a reranker from config when reranker option is omitted", async () => {
    const config = createDefaultConfig("searchsocket-engine-create");

    await SearchEngine.create({
      config,
      embeddingsProvider: fakeEmbeddings,
      vectorStore: fakeStore
    });

    expect(mocks.createReranker).toHaveBeenCalledTimes(1);
  });
});
