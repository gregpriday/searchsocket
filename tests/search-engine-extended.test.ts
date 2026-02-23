import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SearchEngine } from "../src/search/engine";
import { createDefaultConfig } from "../src/config/defaults";
import type { EmbeddingsProvider, PageRecord, VectorHit, VectorStore } from "../src/types";

const tempDirs: string[] = [];

class FakeEmbeddings implements EmbeddingsProvider {
  estimateTokens(text: string): number {
    return text.length;
  }

  async embedTexts(): Promise<number[][]> {
    return [[1, 0, 0]];
  }
}

class FakeStore implements VectorStore {
  private pages = new Map<string, PageRecord>();
  private scopeModelId: string | null = null;

  constructor(private readonly hits: VectorHit[] = []) {}

  withPage(page: PageRecord): FakeStore {
    this.pages.set(`${page.projectId}:${page.scopeName}:${page.url}`, page);
    return this;
  }

  withScopeModelId(modelId: string): FakeStore {
    this.scopeModelId = modelId;
    return this;
  }

  async upsert(): Promise<void> {
    return;
  }

  async query(): Promise<VectorHit[]> {
    return this.hits;
  }

  async deleteByIds(): Promise<void> {
    return;
  }

  async deleteScope(): Promise<void> {
    return;
  }

  async listScopes() {
    return [];
  }

  async recordScope(): Promise<void> {
    return;
  }

  async health() {
    return { ok: true };
  }

  async getContentHashes() {
    return new Map<string, string>();
  }

  async upsertPages(): Promise<void> {
    return;
  }

  async getPage(url: string, scope: { projectId: string; scopeName: string }): Promise<PageRecord | null> {
    return this.pages.get(`${scope.projectId}:${scope.scopeName}:${url}`) ?? null;
  }

  async deletePages(): Promise<void> {
    return;
  }

  async getScopeModelId(): Promise<string | null> {
    return this.scopeModelId;
  }
}

function makeHit(id: string, url: string): VectorHit {
  return {
    id,
    score: 0.8,
    metadata: {
      projectId: "searchsocket-engine-test",
      scopeName: "main",
      url,
      path: url,
      title: "Title",
      sectionTitle: "",
      headingPath: [],
      snippet: "Snippet",
      contentHash: `hash-${id}`,
      modelId: "text-embedding-3-small",
      depth: 1,
      incomingLinks: 0,
      routeFile: "src/routes/+page.svelte",
      tags: []
    }
  };
}

async function makeTempCwd(): Promise<string> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "searchsocket-engine-"));
  tempDirs.push(cwd);
  return cwd;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("SearchEngine - adversarial cases", () => {
  it("rejects invalid requests with empty query", async () => {
    const cwd = await makeTempCwd();
    const config = createDefaultConfig("searchsocket-engine-test");

    const engine = await SearchEngine.create({
      cwd,
      config,
      embeddingsProvider: new FakeEmbeddings(),
      vectorStore: new FakeStore()
    });

    await expect(engine.search({ q: "   " })).rejects.toMatchObject({
      code: "INVALID_REQUEST",
      status: 400
    });
  });

  it("rejects invalid topK values outside schema bounds", async () => {
    const cwd = await makeTempCwd();
    const config = createDefaultConfig("searchsocket-engine-test");

    const engine = await SearchEngine.create({
      cwd,
      config,
      embeddingsProvider: new FakeEmbeddings(),
      vectorStore: new FakeStore()
    });

    await expect(engine.search({ q: "test", topK: 0 })).rejects.toMatchObject({
      code: "INVALID_REQUEST",
      status: 400
    });
    await expect(engine.search({ q: "test", topK: 101 })).rejects.toMatchObject({
      code: "INVALID_REQUEST",
      status: 400
    });
  });

  it("rejects rerank=true when rerank provider is disabled", async () => {
    const cwd = await makeTempCwd();
    const config = createDefaultConfig("searchsocket-engine-test");
    config.rerank.provider = "none";

    const engine = await SearchEngine.create({
      cwd,
      config,
      embeddingsProvider: new FakeEmbeddings(),
      vectorStore: new FakeStore([makeHit("a", "/a")])
    });

    await expect(engine.search({ q: "test", rerank: true })).rejects.toMatchObject({
      code: "INVALID_REQUEST",
      status: 400
    });
  });

  it("rejects rerank=true when jina is configured but API key is missing", async () => {
    const cwd = await makeTempCwd();
    const config = createDefaultConfig("searchsocket-engine-test");
    config.rerank.provider = "jina";
    config.rerank.jina.apiKeyEnv = "SEARCHSOCKET_TEST_MISSING_JINA_KEY";
    delete process.env.SEARCHSOCKET_TEST_MISSING_JINA_KEY;

    const engine = await SearchEngine.create({
      cwd,
      config,
      embeddingsProvider: new FakeEmbeddings(),
      vectorStore: new FakeStore([makeHit("a", "/a")])
    });

    await expect(engine.search({ q: "test", rerank: true })).rejects.toMatchObject({
      code: "CONFIG_MISSING",
      status: 400
    });
  });

  it("normalizes full URLs when loading indexed pages", async () => {
    const cwd = await makeTempCwd();
    const config = createDefaultConfig("searchsocket-engine-test");

    const store = new FakeStore().withPage({
      url: "/docs/getting-started",
      title: "Getting Started",
      markdown: "## Install\n\nRun pnpm add searchsocket.",
      projectId: config.project.id,
      scopeName: "main",
      routeFile: "src/routes/docs/getting-started/+page.svelte",
      routeResolution: "exact",
      incomingLinks: 0,
      outgoingLinks: 0,
      depth: 2,
      tags: [],
      indexedAt: "2026-01-01T00:00:00.000Z"
    });

    const engine = await SearchEngine.create({
      cwd,
      config,
      embeddingsProvider: new FakeEmbeddings(),
      vectorStore: store
    });

    const page = await engine.getPage("https://example.com/docs/getting-started?ref=nav#install");

    expect(page.url).toBe("/docs/getting-started");
    expect(page.frontmatter.title).toBe("Getting Started");
    expect(page.markdown).toContain("Run pnpm add searchsocket.");
  });

  it("normalizes query/hash suffixes for path-style getPage inputs", async () => {
    const cwd = await makeTempCwd();
    const config = createDefaultConfig("searchsocket-engine-test");

    const store = new FakeStore().withPage({
      url: "/docs/faq",
      title: "FAQ",
      markdown: "Frequently asked questions.",
      projectId: config.project.id,
      scopeName: "main",
      routeFile: "src/routes/docs/faq/+page.svelte",
      routeResolution: "exact",
      incomingLinks: 0,
      outgoingLinks: 0,
      depth: 2,
      tags: [],
      indexedAt: "2026-01-01T00:00:00.000Z"
    });

    const engine = await SearchEngine.create({
      cwd,
      config,
      embeddingsProvider: new FakeEmbeddings(),
      vectorStore: store
    });

    const page = await engine.getPage("/docs/faq?ref=nav#pricing");
    expect(page.url).toBe("/docs/faq");
    expect(page.frontmatter.title).toBe("FAQ");
  });

  it("returns 404 when requested indexed page does not exist", async () => {
    const cwd = await makeTempCwd();
    const config = createDefaultConfig("searchsocket-engine-test");

    const engine = await SearchEngine.create({
      cwd,
      config,
      embeddingsProvider: new FakeEmbeddings(),
      vectorStore: new FakeStore()
    });

    await expect(engine.getPage("/missing")).rejects.toMatchObject({
      code: "INVALID_REQUEST",
      status: 404
    });
  });

  it("resolves bare origin URLs to the root indexed page", async () => {
    const cwd = await makeTempCwd();
    const config = createDefaultConfig("searchsocket-engine-test");

    const store = new FakeStore().withPage({
      url: "/",
      title: "Home",
      markdown: "Welcome home.",
      projectId: config.project.id,
      scopeName: "main",
      routeFile: "src/routes/+page.svelte",
      routeResolution: "exact",
      incomingLinks: 0,
      outgoingLinks: 2,
      depth: 0,
      tags: [],
      indexedAt: "2026-01-01T00:00:00.000Z"
    });

    const engine = await SearchEngine.create({
      cwd,
      config,
      embeddingsProvider: new FakeEmbeddings(),
      vectorStore: store
    });

    const page = await engine.getPage("https://example.com");
    expect(page.url).toBe("/");
    expect(page.frontmatter.title).toBe("Home");
  });

  it("fails fast when scope model does not match active embedding model", async () => {
    const cwd = await makeTempCwd();
    const config = createDefaultConfig("searchsocket-engine-test");

    const store = new FakeStore().withScopeModelId("text-embedding-3-large");

    const engine = await SearchEngine.create({
      cwd,
      config,
      embeddingsProvider: new FakeEmbeddings(),
      vectorStore: store
    });

    await expect(engine.search({ q: "test" })).rejects.toMatchObject({
      code: "EMBEDDING_MODEL_MISMATCH"
    });
  });

  it("rejects empty embedding vectors instead of querying the backend with invalid data", async () => {
    const cwd = await makeTempCwd();
    const config = createDefaultConfig("searchsocket-engine-test");

    const query = vi.fn().mockResolvedValue([]);
    const store: VectorStore = {
      upsert: async () => undefined,
      query,
      deleteByIds: async () => undefined,
      deleteScope: async () => undefined,
      listScopes: async () => [],
      recordScope: async () => undefined,
      health: async () => ({ ok: true }),
      getContentHashes: async () => new Map(),
      upsertPages: async () => undefined,
      getPage: async () => null,
      deletePages: async () => undefined,
      getScopeModelId: async () => null
    };

    const embeddings: EmbeddingsProvider = {
      estimateTokens: (text) => text.length,
      embedTexts: async () => [[]]
    };

    const engine = await SearchEngine.create({
      cwd,
      config,
      embeddingsProvider: embeddings,
      vectorStore: store
    });

    await expect(engine.search({ q: "test" })).rejects.toMatchObject({
      code: "VECTOR_BACKEND_UNAVAILABLE"
    });
    expect(query).not.toHaveBeenCalled();
  });

  it("rejects non-finite query embedding values", async () => {
    const cwd = await makeTempCwd();
    const config = createDefaultConfig("searchsocket-engine-test");

    const query = vi.fn().mockResolvedValue([]);
    const store: VectorStore = {
      upsert: async () => undefined,
      query,
      deleteByIds: async () => undefined,
      deleteScope: async () => undefined,
      listScopes: async () => [],
      recordScope: async () => undefined,
      health: async () => ({ ok: true }),
      getContentHashes: async () => new Map(),
      upsertPages: async () => undefined,
      getPage: async () => null,
      deletePages: async () => undefined,
      getScopeModelId: async () => null
    };

    const embeddings: EmbeddingsProvider = {
      estimateTokens: (text) => text.length,
      embedTexts: async () => [[0.12, Number.NaN, 0.34]]
    };

    const engine = await SearchEngine.create({
      cwd,
      config,
      embeddingsProvider: embeddings,
      vectorStore: store
    });

    await expect(engine.search({ q: "test" })).rejects.toMatchObject({
      code: "VECTOR_BACKEND_UNAVAILABLE"
    });
    expect(query).not.toHaveBeenCalled();
  });

  it("overfetches vector candidates with higher multiplier in page mode (default)", async () => {
    const cwd = await makeTempCwd();
    const config = createDefaultConfig("searchsocket-engine-test");

    const query = vi.fn(async () => [] as VectorHit[]);
    const store: VectorStore = {
      upsert: async () => undefined,
      query,
      deleteByIds: async () => undefined,
      deleteScope: async () => undefined,
      listScopes: async () => [],
      recordScope: async () => undefined,
      health: async () => ({ ok: true }),
      getContentHashes: async () => new Map(),
      upsertPages: async () => undefined,
      getPage: async () => null,
      deletePages: async () => undefined,
      getScopeModelId: async () => null
    };

    const engine = await SearchEngine.create({
      cwd,
      config,
      embeddingsProvider: new FakeEmbeddings(),
      vectorStore: store
    });

    await engine.search({ q: "test", topK: 2 });

    // Default is page mode: Math.max(2 * 10, 50) = 50
    expect(query).toHaveBeenCalledWith(
      [1, 0, 0],
      expect.objectContaining({ topK: 50 }),
      expect.any(Object)
    );
  });

  it("uses chunk-mode overfetch when groupBy is chunk", async () => {
    const cwd = await makeTempCwd();
    const config = createDefaultConfig("searchsocket-engine-test");

    const query = vi.fn(async () => [] as VectorHit[]);
    const store: VectorStore = {
      upsert: async () => undefined,
      query,
      deleteByIds: async () => undefined,
      deleteScope: async () => undefined,
      listScopes: async () => [],
      recordScope: async () => undefined,
      health: async () => ({ ok: true }),
      getContentHashes: async () => new Map(),
      upsertPages: async () => undefined,
      getPage: async () => null,
      deletePages: async () => undefined,
      getScopeModelId: async () => null
    };

    const engine = await SearchEngine.create({
      cwd,
      config,
      embeddingsProvider: new FakeEmbeddings(),
      vectorStore: store
    });

    await engine.search({ q: "test", topK: 2, groupBy: "chunk" });

    // Chunk mode: Math.max(50, 2) = 50
    expect(query).toHaveBeenCalledWith(
      [1, 0, 0],
      expect.objectContaining({ topK: 50 }),
      expect.any(Object)
    );
  });

  it("default page mode returns deduplicated page results", async () => {
    const cwd = await makeTempCwd();
    const config = createDefaultConfig("searchsocket-engine-test");

    const hits: VectorHit[] = [
      { ...makeHit("chunk-1", "/home"), score: 0.9 },
      { ...makeHit("chunk-2", "/home"), score: 0.7 },
      { ...makeHit("chunk-3", "/home"), score: 0.6 },
      { ...makeHit("chunk-4", "/about"), score: 0.85 }
    ];

    const engine = await SearchEngine.create({
      cwd,
      config,
      embeddingsProvider: new FakeEmbeddings(),
      vectorStore: new FakeStore(hits)
    });

    const result = await engine.search({ q: "test", topK: 10 });

    // Should have 2 deduplicated page results, not 4 chunks
    expect(result.results.length).toBe(2);
    const urls = result.results.map((r) => r.url);
    expect(urls).toContain("/home");
    expect(urls).toContain("/about");

    // /home should have sub-chunks since it has 3 matching chunks
    const homeResult = result.results.find((r) => r.url === "/home");
    expect(homeResult!.chunks).toBeDefined();
    expect(homeResult!.chunks!.length).toBe(3);

    // /about should NOT have sub-chunks since it has only 1 chunk
    const aboutResult = result.results.find((r) => r.url === "/about");
    expect(aboutResult!.chunks).toBeUndefined();
  });

  it("filters sub-chunks below minChunkScoreRatio", async () => {
    const cwd = await makeTempCwd();
    const config = createDefaultConfig("searchsocket-engine-test");
    config.ranking.minChunkScoreRatio = 0.8; // strict: chunks must be >= 80% of best

    const hits: VectorHit[] = [
      { ...makeHit("chunk-1", "/page"), score: 1.0 },
      { ...makeHit("chunk-2", "/page"), score: 0.85 },  // 85% of best — passes
      { ...makeHit("chunk-3", "/page"), score: 0.5 },   // 50% of best — filtered
      { ...makeHit("chunk-4", "/page"), score: 0.3 }    // 30% of best — filtered
    ];

    const engine = await SearchEngine.create({
      cwd,
      config,
      embeddingsProvider: new FakeEmbeddings(),
      vectorStore: new FakeStore(hits)
    });

    const result = await engine.search({ q: "test", topK: 10 });
    const pageResult = result.results[0]!;

    // Only 2 chunks pass the 80% threshold, so chunks should be included (2 > 1)
    expect(pageResult.chunks).toBeDefined();
    expect(pageResult.chunks!.length).toBe(2);
  });

  it("groupBy chunk returns raw chunk results without deduplication", async () => {
    const cwd = await makeTempCwd();
    const config = createDefaultConfig("searchsocket-engine-test");

    const hits: VectorHit[] = [
      { ...makeHit("chunk-1", "/home"), score: 0.9 },
      { ...makeHit("chunk-2", "/home"), score: 0.7 },
      { ...makeHit("chunk-3", "/about"), score: 0.85 }
    ];

    const engine = await SearchEngine.create({
      cwd,
      config,
      embeddingsProvider: new FakeEmbeddings(),
      vectorStore: new FakeStore(hits)
    });

    const result = await engine.search({ q: "test", topK: 10, groupBy: "chunk" });

    // Should have all 3 individual chunk results
    expect(result.results.length).toBe(3);
    // No chunks sub-array in chunk mode
    for (const r of result.results) {
      expect(r.chunks).toBeUndefined();
    }
  });

  it("uses requested topK when it exceeds the candidate floor", async () => {
    const cwd = await makeTempCwd();
    const config = createDefaultConfig("searchsocket-engine-test");

    const query = vi.fn(async () => [] as VectorHit[]);
    const store: VectorStore = {
      upsert: async () => undefined,
      query,
      deleteByIds: async () => undefined,
      deleteScope: async () => undefined,
      listScopes: async () => [],
      recordScope: async () => undefined,
      health: async () => ({ ok: true }),
      getContentHashes: async () => new Map(),
      upsertPages: async () => undefined,
      getPage: async () => null,
      deletePages: async () => undefined,
      getScopeModelId: async () => null
    };

    const engine = await SearchEngine.create({
      cwd,
      config,
      embeddingsProvider: new FakeEmbeddings(),
      vectorStore: store
    });

    await engine.search({ q: "test", topK: 80 });

    // Page mode: Math.max(80 * 10, 50) = 800
    expect(query).toHaveBeenCalledWith(
      [1, 0, 0],
      expect.objectContaining({ topK: 800 }),
      expect.any(Object)
    );
  });
});
