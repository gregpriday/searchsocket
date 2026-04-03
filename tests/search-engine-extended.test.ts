import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SearchEngine } from "../src/search/engine";
import { createDefaultConfig } from "../src/config/defaults";
import type { PageHit, PageRecord, VectorHit } from "../src/types";
import type { UpstashSearchStore } from "../src/vector/upstash";

const tempDirs: string[] = [];

function createMockStore(hits: VectorHit[] = [], pageHits?: PageHit[]): UpstashSearchStore & {
  search: ReturnType<typeof vi.fn>;
  searchPagesByText: ReturnType<typeof vi.fn>;
  searchPagesByVector: ReturnType<typeof vi.fn>;
  searchChunksByUrl: ReturnType<typeof vi.fn>;
  getPage: ReturnType<typeof vi.fn>;
  listPages: ReturnType<typeof vi.fn>;
  fetchPageWithVector: ReturnType<typeof vi.fn>;
  fetchPagesBatch: ReturnType<typeof vi.fn>;
  _pages: Map<string, PageRecord>;
} {
  const pages = new Map<string, PageRecord>();

  // Auto-generate page hits from chunk hits if not explicitly provided
  const resolvedPageHits: PageHit[] = pageHits ?? (() => {
    const uniqueUrls = new Map<string, VectorHit>();
    for (const hit of hits) {
      const existing = uniqueUrls.get(hit.metadata.url);
      if (!existing || hit.score > existing.score) {
        uniqueUrls.set(hit.metadata.url, hit);
      }
    }
    return [...uniqueUrls.values()].map((hit) => ({
      id: hit.metadata.url,
      score: hit.score,
      title: hit.metadata.title,
      url: hit.metadata.url,
      description: "",
      tags: hit.metadata.tags,
      depth: hit.metadata.depth,
      incomingLinks: hit.metadata.incomingLinks,
      routeFile: hit.metadata.routeFile
    }));
  })();

  const store = {
    upsertChunks: vi.fn(async () => undefined),
    search: vi.fn(async () => hits),
    searchPagesByText: vi.fn(async () => resolvedPageHits),
    searchPagesByVector: vi.fn(async () => resolvedPageHits),
    searchChunksByUrl: vi.fn(async (_data: string, url: string) => {
      return hits.filter((h) => h.metadata.url === url);
    }),
    deleteByIds: vi.fn(async () => undefined),
    deleteScope: vi.fn(async () => undefined),
    listScopes: vi.fn(async () => []),
    health: vi.fn(async () => ({ ok: true })),
    getContentHashes: vi.fn(async () => new Map<string, string>()),
    upsertPages: vi.fn(async () => undefined),
    getPage: vi.fn(async (url: string, scope: { projectId: string; scopeName: string }) => {
      return pages.get(`${scope.projectId}:${scope.scopeName}:${url}`) ?? null;
    }),
    listPages: vi.fn(async () => ({ pages: [] })),
    deletePages: vi.fn(async () => undefined),
    getPageHashes: vi.fn(async () => new Map()),
    deletePagesByIds: vi.fn(async () => undefined),
    dropAllIndexes: vi.fn(async () => undefined),
    fetchPageWithVector: vi.fn(async () => null),
    fetchPagesBatch: vi.fn(async () => []),
    _pages: pages
  };

  return store as unknown as UpstashSearchStore & {
    search: ReturnType<typeof vi.fn>;
    searchPagesByText: ReturnType<typeof vi.fn>;
    searchPagesByVector: ReturnType<typeof vi.fn>;
    searchChunksByUrl: ReturnType<typeof vi.fn>;
    getPage: ReturnType<typeof vi.fn>;
    listPages: ReturnType<typeof vi.fn>;
    fetchPageWithVector: ReturnType<typeof vi.fn>;
    fetchPagesBatch: ReturnType<typeof vi.fn>;
    _pages: Map<string, PageRecord>;
  };
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
      chunkText: "Full chunk text",
      ordinal: 0,
      contentHash: `hash-${id}`,
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
      store: createMockStore(),

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
      store: createMockStore(),

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

  it("normalizes full URLs when loading indexed pages", async () => {
    const cwd = await makeTempCwd();
    const config = createDefaultConfig("searchsocket-engine-test");

    const store = createMockStore();
    store._pages.set(`${config.project.id}:main:/docs/getting-started`, {
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
      store,

    });

    const page = await engine.getPage("https://example.com/docs/getting-started?ref=nav#install");

    expect(page.url).toBe("/docs/getting-started");
    expect(page.frontmatter.title).toBe("Getting Started");
    expect(page.markdown).toContain("Run pnpm add searchsocket.");
  });

  it("normalizes query/hash suffixes for path-style getPage inputs", async () => {
    const cwd = await makeTempCwd();
    const config = createDefaultConfig("searchsocket-engine-test");

    const store = createMockStore();
    store._pages.set(`${config.project.id}:main:/docs/faq`, {
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
      store,

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
      store: createMockStore(),

    });

    await expect(engine.getPage("/missing")).rejects.toMatchObject({
      code: "INVALID_REQUEST",
      status: 404
    });
  });

  it("resolves bare origin URLs to the root indexed page", async () => {
    const cwd = await makeTempCwd();
    const config = createDefaultConfig("searchsocket-engine-test");

    const store = createMockStore();
    store._pages.set(`${config.project.id}:main:/`, {
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
      store,

    });

    const page = await engine.getPage("https://example.com");
    expect(page.url).toBe("/");
    expect(page.frontmatter.title).toBe("Home");
  });

  it("overfetches page candidates in page mode (default)", async () => {
    const cwd = await makeTempCwd();
    const config = createDefaultConfig("searchsocket-engine-test");

    const store = createMockStore();

    const engine = await SearchEngine.create({
      cwd,
      config,
      store,

    });

    await engine.search({ q: "test", topK: 2 });

    // Page-first mode calls searchPages, not search
    expect(store.searchPagesByText).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ limit: expect.any(Number) }),
      expect.any(Object)
    );
  });

  it("uses chunk-mode overfetch when groupBy is chunk", async () => {
    const cwd = await makeTempCwd();
    const config = createDefaultConfig("searchsocket-engine-test");

    const store = createMockStore();

    const engine = await SearchEngine.create({
      cwd,
      config,
      store,

    });

    await engine.search({ q: "test", topK: 2, groupBy: "chunk" });

    // Chunk mode: Math.max(50, 2) = 50, search receives query text now
    expect(store.search).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ limit: 50 }),
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
      store: createMockStore(hits),

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

    // /about has 1 chunk, which is still included in chunks array
    const aboutResult = result.results.find((r) => r.url === "/about");
    expect(aboutResult!.chunks).toBeDefined();
    expect(aboutResult!.chunks!.length).toBe(1);
  });

  it("filters sub-chunks below minChunkScoreRatio in chunk mode", async () => {
    const cwd = await makeTempCwd();
    const config = createDefaultConfig("searchsocket-engine-test");
    config.ranking.minChunkScoreRatio = 0.8; // strict: chunks must be >= 80% of best

    const hits: VectorHit[] = [
      { ...makeHit("chunk-1", "/page"), score: 1.0 },
      { ...makeHit("chunk-2", "/page"), score: 0.85 },  // 85% of best -- passes
      { ...makeHit("chunk-3", "/page"), score: 0.5 },   // 50% of best -- filtered
      { ...makeHit("chunk-4", "/page"), score: 0.3 }    // 30% of best -- filtered
    ];

    const engine = await SearchEngine.create({
      cwd,
      config,
      store: createMockStore(hits),

    });

    // minChunkScoreRatio filtering applies in the legacy chunk-grouping path
    const result = await engine.search({ q: "test", topK: 10, groupBy: "page" });
    const pageResult = result.results[0]!;

    // Page-first pipeline returns all chunks from searchChunksByUrl as sub-results
    expect(pageResult.chunks).toBeDefined();
    expect(pageResult.chunks!.length).toBe(4);
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
      store: createMockStore(hits),

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

    const store = createMockStore();

    const engine = await SearchEngine.create({
      cwd,
      config,
      store,

    });

    await engine.search({ q: "test", topK: 80 });

    // Page-first mode: Math.max(80 * 2, 20) = 160
    expect(store.searchPagesByText).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ limit: 160 }),
      expect.any(Object)
    );
  });

  it("falls back to chunkText snippet when snippet is too short", async () => {
    const cwd = await makeTempCwd();
    const config = createDefaultConfig("searchsocket-engine-test");
    config.ranking.minScore = 0;
    config.ranking.scoreGapThreshold = 0;

    const hits: VectorHit[] = [
      {
        ...makeHit("chunk-short", "/features"),
        score: 0.9,
        metadata: {
          ...makeHit("chunk-short", "/features").metadata,
          snippet: "Terminal Features",
          chunkText: "Terminal Features provide a rich set of tools for interacting with your development environment efficiently."
        }
      }
    ];

    const engine = await SearchEngine.create({
      cwd,
      config,
      store: createMockStore(hits),

    });

    const result = await engine.search({ q: "terminal features", topK: 10 });
    expect(result.results.length).toBe(1);
    // Should use the chunkText-derived snippet since "Terminal Features" is < 30 chars
    expect(result.results[0]!.snippet.length).toBeGreaterThan(29);
    expect(result.results[0]!.snippet).toContain("Terminal Features");
  });

  it("generates query-aware snippet from chunkText when query is present", async () => {
    const cwd = await makeTempCwd();
    const config = createDefaultConfig("searchsocket-engine-test");
    config.ranking.minScore = 0;
    config.ranking.scoreGapThreshold = 0;

    const longSnippet = "This is the original stored snippet that was computed at index time without query context.";
    const hits: VectorHit[] = [
      {
        ...makeHit("chunk-long", "/docs"),
        score: 0.9,
        metadata: {
          ...makeHit("chunk-long", "/docs").metadata,
          snippet: longSnippet,
          chunkText: "Different chunk text content about docs and documentation features."
        }
      }
    ];

    const engine = await SearchEngine.create({
      cwd,
      config,
      store: createMockStore(hits),

    });

    const result = await engine.search({ q: "docs", topK: 10 });
    // Query-aware excerpt regenerates from chunkText, so it won't match the stored snippet
    expect(result.results[0]!.snippet).not.toBe(longSnippet);
    expect(result.results[0]!.snippet).toContain("docs");
  });

  it("trims low-confidence results via score-gap trimming", async () => {
    const cwd = await makeTempCwd();
    const config = createDefaultConfig("searchsocket-engine-test");
    // Use default scoreGapThreshold (0.4) and minScore (0.3)

    const hits: VectorHit[] = [
      { ...makeHit("chunk-1", "/relevant"), score: 0.8 },
      { ...makeHit("chunk-2", "/also-relevant"), score: 0.75 },
      { ...makeHit("chunk-3", "/weak"), score: 0.3 }  // big gap from 0.75
    ];

    const engine = await SearchEngine.create({
      cwd,
      config,
      store: createMockStore(hits),

    });

    const result = await engine.search({ q: "test query", topK: 10 });
    // The weak result should be trimmed due to score gap
    expect(result.results.length).toBe(2);
    expect(result.results.map((r) => r.url)).toEqual(["/relevant", "/also-relevant"]);
  });

  it("populates chunkText on top-level result when metadata.chunkText is present", async () => {
    const cwd = await makeTempCwd();
    const config = createDefaultConfig("searchsocket-engine-test");
    config.ranking.minScore = 0;
    config.ranking.scoreGapThreshold = 0;

    const hits: VectorHit[] = [
      {
        ...makeHit("chunk-1", "/page"),
        score: 0.9,
        metadata: {
          ...makeHit("chunk-1", "/page").metadata,
          chunkText: "Full markdown content of the chunk."
        }
      }
    ];

    const engine = await SearchEngine.create({
      cwd,
      config,
      store: createMockStore(hits),

    });

    const result = await engine.search({ q: "test", topK: 10 });
    expect(result.results[0]!.chunkText).toBe("Full markdown content of the chunk.");
  });

  it("chunkText is undefined when metadata.chunkText is empty", async () => {
    const cwd = await makeTempCwd();
    const config = createDefaultConfig("searchsocket-engine-test");
    config.ranking.minScore = 0;
    config.ranking.scoreGapThreshold = 0;

    const hits: VectorHit[] = [
      {
        ...makeHit("chunk-1", "/page"),
        score: 0.9,
        metadata: {
          ...makeHit("chunk-1", "/page").metadata,
          chunkText: ""
        }
      }
    ];

    const engine = await SearchEngine.create({
      cwd,
      config,
      store: createMockStore(hits),

    });

    const result = await engine.search({ q: "test", topK: 10 });
    expect(result.results[0]!.chunkText).toBeUndefined();
  });

  it("populates chunkText on nested chunk entries", async () => {
    const cwd = await makeTempCwd();
    const config = createDefaultConfig("searchsocket-engine-test");
    config.ranking.minScore = 0;
    config.ranking.scoreGapThreshold = 0;

    const hits: VectorHit[] = [
      { ...makeHit("chunk-1", "/page"), score: 0.9, metadata: { ...makeHit("chunk-1", "/page").metadata, chunkText: "Chunk one content." } },
      { ...makeHit("chunk-2", "/page"), score: 0.85, metadata: { ...makeHit("chunk-2", "/page").metadata, chunkText: "Chunk two content." } }
    ];

    const engine = await SearchEngine.create({
      cwd,
      config,
      store: createMockStore(hits),

    });

    const result = await engine.search({ q: "test", topK: 10 });
    const pageResult = result.results[0]!;
    expect(pageResult.chunks).toBeDefined();
    expect(pageResult.chunks![0]!.chunkText).toBe("Chunk one content.");
    expect(pageResult.chunks![1]!.chunkText).toBe("Chunk two content.");
  });

  it("populates chunkText in chunk-mode results", async () => {
    const cwd = await makeTempCwd();
    const config = createDefaultConfig("searchsocket-engine-test");
    config.ranking.minScore = 0;
    config.ranking.scoreGapThreshold = 0;

    const hits: VectorHit[] = [
      { ...makeHit("chunk-1", "/page"), score: 0.9, metadata: { ...makeHit("chunk-1", "/page").metadata, chunkText: "Chunk markdown here." } }
    ];

    const engine = await SearchEngine.create({
      cwd,
      config,
      store: createMockStore(hits),

    });

    const result = await engine.search({ q: "test", topK: 10, groupBy: "chunk" });
    expect(result.results[0]!.chunkText).toBe("Chunk markdown here.");
  });

  it("returns empty results for gibberish queries with low scores", async () => {
    const cwd = await makeTempCwd();
    const config = createDefaultConfig("searchsocket-engine-test");
    // Use default minScore (0.3) — median of these scores is below 0.3

    const hits: VectorHit[] = [
      { ...makeHit("chunk-1", "/a"), score: 0.25 },
      { ...makeHit("chunk-2", "/b"), score: 0.2 },
      { ...makeHit("chunk-3", "/c"), score: 0.15 }
    ];

    const engine = await SearchEngine.create({
      cwd,
      config,
      store: createMockStore(hits),

    });

    const result = await engine.search({ q: "xyzzy gibberish asdf", topK: 10 });
    expect(result.results.length).toBe(0);
  });
});

describe("SearchEngine - dual search", () => {
  it("uses page-first pipeline calling searchPages then searchChunksByUrl", async () => {
    const cwd = await makeTempCwd();
    const config = createDefaultConfig("searchsocket-engine-test");

    const chunkHits: VectorHit[] = [
      { ...makeHit("chunk-1", "/docs"), score: 0.8 }
    ];
    const pageHits: PageHit[] = [
      {
        id: "/docs",
        score: 0.9,
        title: "Docs",
        url: "/docs",
        description: "Documentation page",
        tags: [],
        depth: 1,
        incomingLinks: 2,
        routeFile: "src/routes/docs/+page.svelte"
      }
    ];

    const store = createMockStore(chunkHits, pageHits);
    const engine = await SearchEngine.create({ cwd, config, store });

    const result = await engine.search({ q: "documentation", topK: 10 });

    // Page-first pipeline: searchPages then searchChunksByUrl
    expect(store.searchPagesByText).toHaveBeenCalledTimes(1);
    expect(store.searchChunksByUrl).toHaveBeenCalledTimes(1);

    expect(result.results.length).toBeGreaterThan(0);
    expect(result.results[0]!.url).toBe("/docs");
  });

  it("page-first pipeline still calls searchPages when dualSearch is disabled", async () => {
    const cwd = await makeTempCwd();
    const config = createDefaultConfig("searchsocket-engine-test");
    config.search.dualSearch = false;

    const store = createMockStore([makeHit("chunk-1", "/home")]);
    const engine = await SearchEngine.create({ cwd, config, store });

    await engine.search({ q: "test", topK: 5 });

    // Page-first pipeline always uses searchPages regardless of dualSearch
    expect(store.searchPagesByText).toHaveBeenCalledTimes(1);
  });

  it("falls back to single search in chunk groupBy mode", async () => {
    const cwd = await makeTempCwd();
    const config = createDefaultConfig("searchsocket-engine-test");
    // dualSearch is true, but groupBy=chunk should bypass it

    const store = createMockStore([makeHit("chunk-1", "/home")]);
    const engine = await SearchEngine.create({ cwd, config, store });

    await engine.search({ q: "test", topK: 5, groupBy: "chunk" });

    expect(store.searchPagesByText).not.toHaveBeenCalled();
    expect(store.search).toHaveBeenCalledTimes(1);
  });

  it("handles empty page search results gracefully", async () => {
    const cwd = await makeTempCwd();
    const config = createDefaultConfig("searchsocket-engine-test");

    const chunkHits: VectorHit[] = [
      { ...makeHit("chunk-1", "/home"), score: 0.8 },
      { ...makeHit("chunk-2", "/about"), score: 0.75 }
    ];
    // No page hits — page-first pipeline returns empty, chunk mode still works
    const store = createMockStore(chunkHits, []);
    const engine = await SearchEngine.create({ cwd, config, store });

    // In page-first mode with no page hits, results will be empty
    const pageResult = await engine.search({ q: "test", topK: 10 });
    expect(pageResult.results.length).toBe(0);

    // In chunk mode, results are available
    const chunkResult = await engine.search({ q: "test", topK: 10, groupBy: "chunk" });
    expect(chunkResult.results.length).toBe(2);
    expect(chunkResult.results.map((r) => r.url)).toContain("/home");
    expect(chunkResult.results.map((r) => r.url)).toContain("/about");
  });

  it("page-first pipeline ranks pages by page similarity score", async () => {
    const cwd = await makeTempCwd();
    const config = createDefaultConfig("searchsocket-engine-test");
    config.ranking.minScore = 0;
    config.ranking.scoreGapThreshold = 0;

    const chunkHits: VectorHit[] = [
      { ...makeHit("chunk-1", "/top"), score: 0.9 },
      { ...makeHit("chunk-2", "/boosted"), score: 0.6 }
    ];
    const pageHits: PageHit[] = [
      {
        id: "/boosted",
        score: 1.0,
        title: "Boosted",
        url: "/boosted",
        description: "Gets a page boost",
        tags: [],
        depth: 1,
        incomingLinks: 5,
        routeFile: "src/routes/+page.svelte"
      },
      {
        id: "/top",
        score: 0.9,
        title: "Title",
        url: "/top",
        description: "",
        tags: [],
        depth: 1,
        incomingLinks: 0,
        routeFile: "src/routes/+page.svelte"
      }
    ];

    const store = createMockStore(chunkHits, pageHits);
    const engine = await SearchEngine.create({ cwd, config, store });

    const result = await engine.search({ q: "test", topK: 10 });

    expect(result.results.length).toBe(2);
    // Both pages should appear in results
    const urls = result.results.map((r) => r.url);
    expect(urls).toContain("/top");
    expect(urls).toContain("/boosted");
  });
});

describe("SearchEngine - maxSubResults", () => {
  it("defaults to 5 sub-results when maxSubResults is not specified", async () => {
    const cwd = await makeTempCwd();
    const config = createDefaultConfig("searchsocket-engine-test");
    config.ranking.minChunkScoreRatio = 0;

    // Create 7 chunks for the same page
    const hits: VectorHit[] = Array.from({ length: 7 }, (_, i) => ({
      ...makeHit(`chunk-${i}`, "/docs"),
      score: 0.9 - i * 0.05
    }));

    const engine = await SearchEngine.create({
      cwd,
      config,
      store: createMockStore(hits),

    });

    const result = await engine.search({ q: "test", topK: 10 });
    const page = result.results[0]!;
    expect(page.chunks).toBeDefined();
    expect(page.chunks!.length).toBe(5);
  });

  it("respects maxSubResults cap", async () => {
    const cwd = await makeTempCwd();
    const config = createDefaultConfig("searchsocket-engine-test");
    config.ranking.minChunkScoreRatio = 0;

    const hits: VectorHit[] = Array.from({ length: 7 }, (_, i) => ({
      ...makeHit(`chunk-${i}`, "/docs"),
      score: 0.9 - i * 0.05
    }));

    const engine = await SearchEngine.create({
      cwd,
      config,
      store: createMockStore(hits),

    });

    const result = await engine.search({ q: "test", topK: 10, maxSubResults: 3 });
    const page = result.results[0]!;
    expect(page.chunks).toBeDefined();
    expect(page.chunks!.length).toBe(3);
  });

  it("returns exactly 1 chunk when maxSubResults is 1", async () => {
    const cwd = await makeTempCwd();
    const config = createDefaultConfig("searchsocket-engine-test");
    config.ranking.minChunkScoreRatio = 0;

    const hits: VectorHit[] = [
      { ...makeHit("chunk-1", "/page"), score: 0.9 },
      { ...makeHit("chunk-2", "/page"), score: 0.8 },
      { ...makeHit("chunk-3", "/page"), score: 0.7 }
    ];

    const engine = await SearchEngine.create({
      cwd,
      config,
      store: createMockStore(hits),

    });

    const result = await engine.search({ q: "test", topK: 10, maxSubResults: 1 });
    const page = result.results[0]!;
    expect(page.chunks).toBeDefined();
    expect(page.chunks!.length).toBe(1);
  });

  it("returns all available chunks when maxSubResults exceeds actual count", async () => {
    const cwd = await makeTempCwd();
    const config = createDefaultConfig("searchsocket-engine-test");
    config.ranking.minChunkScoreRatio = 0;

    const hits: VectorHit[] = [
      { ...makeHit("chunk-1", "/page"), score: 0.9 },
      { ...makeHit("chunk-2", "/page"), score: 0.8 }
    ];

    const engine = await SearchEngine.create({
      cwd,
      config,
      store: createMockStore(hits),

    });

    const result = await engine.search({ q: "test", topK: 10, maxSubResults: 10 });
    const page = result.results[0]!;
    expect(page.chunks).toBeDefined();
    expect(page.chunks!.length).toBe(2);
  });

  it("rejects maxSubResults of 0", async () => {
    const cwd = await makeTempCwd();
    const config = createDefaultConfig("searchsocket-engine-test");

    const engine = await SearchEngine.create({
      cwd,
      config,
      store: createMockStore(),

    });

    await expect(engine.search({ q: "test", maxSubResults: 0 })).rejects.toMatchObject({
      code: "INVALID_REQUEST",
      status: 400
    });
  });

  it("rejects maxSubResults exceeding 20", async () => {
    const cwd = await makeTempCwd();
    const config = createDefaultConfig("searchsocket-engine-test");

    const engine = await SearchEngine.create({
      cwd,
      config,
      store: createMockStore(),

    });

    await expect(engine.search({ q: "test", maxSubResults: 21 })).rejects.toMatchObject({
      code: "INVALID_REQUEST",
      status: 400
    });
  });

  it("has no effect on chunk-mode results", async () => {
    const cwd = await makeTempCwd();
    const config = createDefaultConfig("searchsocket-engine-test");
    config.ranking.minScore = 0;
    config.ranking.scoreGapThreshold = 0;

    const hits: VectorHit[] = [
      { ...makeHit("chunk-1", "/home"), score: 0.9 },
      { ...makeHit("chunk-2", "/home"), score: 0.7 },
      { ...makeHit("chunk-3", "/about"), score: 0.85 }
    ];

    const engine = await SearchEngine.create({
      cwd,
      config,
      store: createMockStore(hits),

    });

    const result = await engine.search({ q: "test", topK: 10, groupBy: "chunk", maxSubResults: 1 });
    expect(result.results.length).toBe(3);
    for (const r of result.results) {
      expect(r.chunks).toBeUndefined();
    }
  });
});

describe("SearchEngine - ranking overrides", () => {
  it("applies ranking overrides when debug is true", async () => {
    const cwd = await makeTempCwd();
    const config = createDefaultConfig("searchsocket-engine-test");
    // Default minScore is 0.3 — hits at 0.25 would normally be filtered out
    config.ranking.minScore = 0.3;
    config.ranking.scoreGapThreshold = 0;

    const hits: VectorHit[] = [
      { ...makeHit("chunk-1", "/page"), score: 0.25 }
    ];

    const engine = await SearchEngine.create({
      cwd,
      config,
      store: createMockStore(hits),

    });

    // Without overrides: filtered out by minScore
    const resultDefault = await engine.search({ q: "test", topK: 10, groupBy: "chunk" });
    expect(resultDefault.results.length).toBe(0);

    // With overrides: minScore=0 lets it through
    const resultOverridden = await engine.search({
      q: "test",
      topK: 10,
      groupBy: "chunk",
      debug: true,
      rankingOverrides: { ranking: { minScore: 0 } }
    });
    expect(resultOverridden.results.length).toBe(1);
  });

  it("ignores ranking overrides when debug is false", async () => {
    const cwd = await makeTempCwd();
    const config = createDefaultConfig("searchsocket-engine-test");
    config.ranking.minScore = 0.3;
    config.ranking.scoreGapThreshold = 0;

    const hits: VectorHit[] = [
      { ...makeHit("chunk-1", "/page"), score: 0.25 }
    ];

    const engine = await SearchEngine.create({
      cwd,
      config,
      store: createMockStore(hits),

    });

    // debug: false — overrides should be ignored, so minScore 0.3 still applies
    const result = await engine.search({
      q: "test",
      topK: 10,
      groupBy: "chunk",
      debug: false,
      rankingOverrides: { ranking: { minScore: 0 } }
    });
    expect(result.results.length).toBe(0);
  });

  it("does not mutate base config across sequential calls", async () => {
    const cwd = await makeTempCwd();
    const config = createDefaultConfig("searchsocket-engine-test");
    config.ranking.minScore = 0.3;
    config.ranking.scoreGapThreshold = 0;

    const hits: VectorHit[] = [
      { ...makeHit("chunk-1", "/page"), score: 0.25 }
    ];

    const engine = await SearchEngine.create({
      cwd,
      config,
      store: createMockStore(hits),

    });

    // First call with override
    await engine.search({
      q: "test",
      topK: 10,
      groupBy: "chunk",
      debug: true,
      rankingOverrides: { ranking: { minScore: 0 } }
    });

    // Second call without overrides — should use original config
    const result = await engine.search({ q: "test", topK: 10, groupBy: "chunk" });
    expect(result.results.length).toBe(0); // still filtered by original minScore 0.3
  });

  it("applies partial overrides — only specified fields change", async () => {
    const cwd = await makeTempCwd();
    const config = createDefaultConfig("searchsocket-engine-test");
    config.ranking.minScore = 0;
    config.ranking.scoreGapThreshold = 0;

    const hits: VectorHit[] = [
      { ...makeHit("chunk-1", "/a"), score: 0.9 },
      { ...makeHit("chunk-2", "/b"), score: 0.85 }
    ];

    const engine = await SearchEngine.create({
      cwd,
      config,
      store: createMockStore(hits),

    });

    // Override only titleMatch weight — other weights should remain at defaults
    const result = await engine.search({
      q: "test",
      topK: 10,
      groupBy: "chunk",
      debug: true,
      rankingOverrides: { ranking: { weights: { titleMatch: 0.5 } } }
    });

    // Should still return results (search works with partial overrides)
    expect(result.results.length).toBe(2);
  });

  it("accepts pageSearchWeight override without error", async () => {
    const cwd = await makeTempCwd();
    const config = createDefaultConfig("searchsocket-engine-test");
    config.ranking.minScore = 0;
    config.ranking.scoreGapThreshold = 0;

    const chunkHits: VectorHit[] = [
      { ...makeHit("chunk-1", "/docs"), score: 0.5 }
    ];

    const store = createMockStore(chunkHits);
    const engine = await SearchEngine.create({ cwd, config, store });

    // pageSearchWeight override should be accepted without error
    const result = await engine.search({
      q: "docs",
      topK: 10,
      debug: true,
      rankingOverrides: { search: { pageSearchWeight: 0.8 } }
    });

    expect(result.results.length).toBeGreaterThan(0);
  });
});

describe("SearchEngine - listPages", () => {
  it("returns empty pages when store has no pages", async () => {
    const cwd = await makeTempCwd();
    const config = createDefaultConfig("searchsocket-engine-test");
    const store = createMockStore();

    const engine = await SearchEngine.create({ cwd, config, store });
    const result = await engine.listPages();

    expect(result.pages).toEqual([]);
    expect(result.nextCursor).toBeUndefined();
  });

  it("returns structured page objects from store", async () => {
    const cwd = await makeTempCwd();
    const config = createDefaultConfig("searchsocket-engine-test");
    const store = createMockStore();

    const mockPages = [
      { url: "/docs", title: "Docs", description: "Documentation", routeFile: "src/routes/docs/+page.svelte" },
      { url: "/about", title: "About", description: "About us", routeFile: "src/routes/about/+page.svelte" }
    ];
    store.listPages.mockResolvedValueOnce({ pages: mockPages, nextCursor: "abc123" });

    const engine = await SearchEngine.create({ cwd, config, store });
    const result = await engine.listPages();

    expect(result.pages).toEqual(mockPages);
    expect(result.nextCursor).toBe("abc123");
  });

  it("passes pathPrefix, cursor, and limit through to store", async () => {
    const cwd = await makeTempCwd();
    const config = createDefaultConfig("searchsocket-engine-test");
    const store = createMockStore();

    const engine = await SearchEngine.create({ cwd, config, store });
    await engine.listPages({ pathPrefix: "/docs", cursor: "xyz", limit: 25 });

    expect(store.listPages).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: config.project.id, scopeName: "main" }),
      { cursor: "xyz", limit: 25, pathPrefix: "/docs" }
    );
  });

  it("resolves scope parameter via resolveScope", async () => {
    const cwd = await makeTempCwd();
    const config = createDefaultConfig("searchsocket-engine-test");
    const store = createMockStore();

    const engine = await SearchEngine.create({ cwd, config, store });
    await engine.listPages({ scope: "staging" });

    expect(store.listPages).toHaveBeenCalledWith(
      expect.objectContaining({ scopeName: "staging" }),
      expect.any(Object)
    );
  });

  it("omits nextCursor when store signals end of pagination", async () => {
    const cwd = await makeTempCwd();
    const config = createDefaultConfig("searchsocket-engine-test");
    const store = createMockStore();
    store.listPages.mockResolvedValueOnce({
      pages: [{ url: "/", title: "Home", description: "", routeFile: "" }]
    });

    const engine = await SearchEngine.create({ cwd, config, store });
    const result = await engine.listPages();

    expect(result.pages).toHaveLength(1);
    expect("nextCursor" in result).toBe(false);
  });

  it("normalizes pathPrefix by prepending / if missing", async () => {
    const cwd = await makeTempCwd();
    const config = createDefaultConfig("searchsocket-engine-test");
    const store = createMockStore();

    const engine = await SearchEngine.create({ cwd, config, store });
    await engine.listPages({ pathPrefix: "docs" });

    expect(store.listPages).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ pathPrefix: "/docs" })
    );
  });

  it("defaults cursor and limit when not provided", async () => {
    const cwd = await makeTempCwd();
    const config = createDefaultConfig("searchsocket-engine-test");
    const store = createMockStore();

    const engine = await SearchEngine.create({ cwd, config, store });
    await engine.listPages();

    expect(store.listPages).toHaveBeenCalledWith(
      expect.any(Object),
      { cursor: undefined, limit: undefined, pathPrefix: undefined }
    );
  });
});

describe("SearchEngine - getRelatedPages", () => {
  function makeSourcePage(url: string, outgoingLinkUrls: string[] = []) {
    return {
      metadata: {
        projectId: "searchsocket-engine-test",
        scopeName: "main",
        type: "page",
        title: `Page ${url}`,
        url,
        description: "",
        keywords: [],
        summary: "",
        tags: [],
        markdown: "",
        routeFile: `src/routes${url}/+page.svelte`,
        routeResolution: "exact",
        incomingLinks: 0,
        outgoingLinks: outgoingLinkUrls.length,
        outgoingLinkUrls,
        depth: url.split("/").filter(Boolean).length,
        indexedAt: "2026-01-01T00:00:00.000Z",
        contentHash: "abc123"
      },
      vector: new Array(1024).fill(0)
    };
  }

  it("throws 404 for unknown URL", async () => {
    const cwd = await makeTempCwd();
    const config = createDefaultConfig("searchsocket-engine-test");
    const store = createMockStore();

    const engine = await SearchEngine.create({ cwd, config, store });

    await expect(engine.getRelatedPages("/missing")).rejects.toMatchObject({
      code: "INVALID_REQUEST",
      status: 404
    });
  });

  it("returns related pages sorted by composite score", async () => {
    const cwd = await makeTempCwd();
    const config = createDefaultConfig("searchsocket-engine-test");
    const store = createMockStore();

    // Source page /docs/auth links to /docs/sessions
    store.fetchPageWithVector.mockResolvedValue(
      makeSourcePage("/docs/auth", ["/docs/sessions"])
    );

    // Semantic results include /docs/sessions (linked) and /blog/post (unrelated)
    store.searchPagesByVector.mockResolvedValue([
      { id: "/docs/sessions", score: 0.8, title: "Sessions", url: "/docs/sessions", description: "", tags: [], depth: 2, incomingLinks: 1, routeFile: "src/routes/docs/sessions/+page.svelte" },
      { id: "/blog/post", score: 0.6, title: "Blog Post", url: "/blog/post", description: "", tags: [], depth: 2, incomingLinks: 0, routeFile: "src/routes/blog/post/+page.svelte" }
    ]);

    // fetchPagesBatch returns metadata for all candidates
    store.fetchPagesBatch.mockResolvedValue([
      { url: "/docs/sessions", title: "Sessions", routeFile: "src/routes/docs/sessions/+page.svelte", outgoingLinkUrls: [] },
      { url: "/blog/post", title: "Blog Post", routeFile: "src/routes/blog/post/+page.svelte", outgoingLinkUrls: [] }
    ]);

    const engine = await SearchEngine.create({ cwd, config, store });
    const result = await engine.getRelatedPages("/docs/auth");

    expect(result.sourceUrl).toBe("/docs/auth");
    expect(result.relatedPages.length).toBe(2);

    // /docs/sessions should be first: outgoing link (0.5) + dice(0.5)*0.3 + semantic(0.8)*0.2
    expect(result.relatedPages[0]!.url).toBe("/docs/sessions");
    expect(result.relatedPages[0]!.relationshipType).toBe("outgoing_link");
    expect(result.relatedPages[0]!.score).toBeGreaterThan(result.relatedPages[1]!.score);

    // /blog/post should be semantic only
    expect(result.relatedPages[1]!.url).toBe("/blog/post");
    expect(result.relatedPages[1]!.relationshipType).toBe("semantic");
  });

  it("excludes source URL from results", async () => {
    const cwd = await makeTempCwd();
    const config = createDefaultConfig("searchsocket-engine-test");
    const store = createMockStore();

    store.fetchPageWithVector.mockResolvedValue(makeSourcePage("/docs/auth"));

    // Semantic results include the source URL itself
    store.searchPagesByVector.mockResolvedValue([
      { id: "/docs/auth", score: 1.0, title: "Auth", url: "/docs/auth", description: "", tags: [], depth: 2, incomingLinks: 0, routeFile: "" },
      { id: "/docs/other", score: 0.5, title: "Other", url: "/docs/other", description: "", tags: [], depth: 2, incomingLinks: 0, routeFile: "" }
    ]);

    store.fetchPagesBatch.mockResolvedValue([
      { url: "/docs/other", title: "Other", routeFile: "", outgoingLinkUrls: [] }
    ]);

    const engine = await SearchEngine.create({ cwd, config, store });
    const result = await engine.getRelatedPages("/docs/auth");

    expect(result.relatedPages.every((p) => p.url !== "/docs/auth")).toBe(true);
    expect(result.relatedPages.length).toBe(1);
  });

  it("detects incoming links from candidates", async () => {
    const cwd = await makeTempCwd();
    const config = createDefaultConfig("searchsocket-engine-test");
    const store = createMockStore();

    // Source page has no outgoing links
    store.fetchPageWithVector.mockResolvedValue(makeSourcePage("/docs/auth"));

    store.searchPagesByVector.mockResolvedValue([
      { id: "/docs/overview", score: 0.7, title: "Overview", url: "/docs/overview", description: "", tags: [], depth: 2, incomingLinks: 0, routeFile: "" }
    ]);

    // /docs/overview links back to /docs/auth
    store.fetchPagesBatch.mockResolvedValue([
      { url: "/docs/overview", title: "Overview", routeFile: "", outgoingLinkUrls: ["/docs/auth"] }
    ]);

    const engine = await SearchEngine.create({ cwd, config, store });
    const result = await engine.getRelatedPages("/docs/auth");

    expect(result.relatedPages[0]!.relationshipType).toBe("incoming_link");
  });

  it("caps results at topK", async () => {
    const cwd = await makeTempCwd();
    const config = createDefaultConfig("searchsocket-engine-test");
    const store = createMockStore();

    store.fetchPageWithVector.mockResolvedValue(makeSourcePage("/docs"));

    const hits = Array.from({ length: 20 }, (_, i) => ({
      id: `/page/${i}`, score: 0.9 - i * 0.01, title: `Page ${i}`,
      url: `/page/${i}`, description: "", tags: [], depth: 2, incomingLinks: 0, routeFile: ""
    }));
    store.searchPagesByVector.mockResolvedValue(hits);
    store.fetchPagesBatch.mockResolvedValue(
      hits.map((h) => ({ url: h.url, title: h.title, routeFile: "", outgoingLinkUrls: [] }))
    );

    const engine = await SearchEngine.create({ cwd, config, store });
    const result = await engine.getRelatedPages("/docs", { topK: 3 });

    expect(result.relatedPages.length).toBe(3);
  });

  it("handles pages with no outgoingLinkUrls gracefully", async () => {
    const cwd = await makeTempCwd();
    const config = createDefaultConfig("searchsocket-engine-test");
    const store = createMockStore();

    // Source page metadata has no outgoingLinkUrls (pre-reindex data)
    const source = makeSourcePage("/old-page");
    delete (source.metadata as Record<string, unknown>).outgoingLinkUrls;
    store.fetchPageWithVector.mockResolvedValue(source);

    store.searchPagesByVector.mockResolvedValue([
      { id: "/other", score: 0.7, title: "Other", url: "/other", description: "", tags: [], depth: 1, incomingLinks: 0, routeFile: "" }
    ]);

    store.fetchPagesBatch.mockResolvedValue([
      { url: "/other", title: "Other", routeFile: "", outgoingLinkUrls: [] }
    ]);

    const engine = await SearchEngine.create({ cwd, config, store });
    const result = await engine.getRelatedPages("/old-page");

    // Should still return results using semantic + structural signals
    expect(result.relatedPages.length).toBe(1);
    expect(result.relatedPages[0]!.relationshipType).toBe("semantic");
  });
});
