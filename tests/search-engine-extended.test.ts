import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SearchEngine } from "../src/search/engine";
import { createDefaultConfig } from "../src/config/defaults";
import type { PageHit, PageRecord, VectorHit } from "../src/types";
import type { UpstashSearchStore } from "../src/vector/upstash";

const tempDirs: string[] = [];

function createMockStore(hits: VectorHit[] = [], pageHits: PageHit[] = []): UpstashSearchStore & {
  search: ReturnType<typeof vi.fn>;
  searchPages: ReturnType<typeof vi.fn>;
  getPage: ReturnType<typeof vi.fn>;
  _pages: Map<string, PageRecord>;
} {
  const pages = new Map<string, PageRecord>();

  const store = {
    upsertChunks: vi.fn(async () => undefined),
    search: vi.fn(async () => hits),
    searchPages: vi.fn(async () => pageHits),
    deleteByIds: vi.fn(async () => undefined),
    deleteScope: vi.fn(async () => undefined),
    listScopes: vi.fn(async () => []),
    health: vi.fn(async () => ({ ok: true })),
    getContentHashes: vi.fn(async () => new Map<string, string>()),
    upsertPages: vi.fn(async () => undefined),
    getPage: vi.fn(async (url: string, scope: { projectId: string; scopeName: string }) => {
      return pages.get(`${scope.projectId}:${scope.scopeName}:${url}`) ?? null;
    }),
    deletePages: vi.fn(async () => undefined),
    dropAllIndexes: vi.fn(async () => undefined),
    _pages: pages
  };

  return store as unknown as UpstashSearchStore & {
    search: ReturnType<typeof vi.fn>;
    searchPages: ReturnType<typeof vi.fn>;
    getPage: ReturnType<typeof vi.fn>;
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
      store: createMockStore()
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
      store: createMockStore()
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
      store
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
      store
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
      store: createMockStore()
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
      store
    });

    const page = await engine.getPage("https://example.com");
    expect(page.url).toBe("/");
    expect(page.frontmatter.title).toBe("Home");
  });

  it("overfetches vector candidates with higher multiplier in page mode (default)", async () => {
    const cwd = await makeTempCwd();
    const config = createDefaultConfig("searchsocket-engine-test");
    // Disable dual search to test legacy overfetch behavior
    config.search.dualSearch = false;

    const store = createMockStore();

    const engine = await SearchEngine.create({
      cwd,
      config,
      store
    });

    await engine.search({ q: "test", topK: 2 });

    // Default is page mode: Math.max(2 * 10, 50) = 50
    expect(store.search).toHaveBeenCalledWith(
      "test",
      expect.objectContaining({ limit: 50 }),
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
      store
    });

    await engine.search({ q: "test", topK: 2, groupBy: "chunk" });

    // Chunk mode: Math.max(50, 2) = 50
    expect(store.search).toHaveBeenCalledWith(
      "test",
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
      store: createMockStore(hits)
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
      { ...makeHit("chunk-2", "/page"), score: 0.85 },  // 85% of best -- passes
      { ...makeHit("chunk-3", "/page"), score: 0.5 },   // 50% of best -- filtered
      { ...makeHit("chunk-4", "/page"), score: 0.3 }    // 30% of best -- filtered
    ];

    const engine = await SearchEngine.create({
      cwd,
      config,
      store: createMockStore(hits)
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
      store: createMockStore(hits)
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
    // Disable dual search to test legacy overfetch behavior
    config.search.dualSearch = false;

    const store = createMockStore();

    const engine = await SearchEngine.create({
      cwd,
      config,
      store
    });

    await engine.search({ q: "test", topK: 80 });

    // Page mode: Math.max(80 * 10, 50) = 800
    expect(store.search).toHaveBeenCalledWith(
      "test",
      expect.objectContaining({ limit: 800 }),
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
      store: createMockStore(hits)
    });

    const result = await engine.search({ q: "terminal features", topK: 10 });
    expect(result.results.length).toBe(1);
    // Should use the chunkText-derived snippet since "Terminal Features" is < 30 chars
    expect(result.results[0]!.snippet.length).toBeGreaterThan(29);
    expect(result.results[0]!.snippet).toContain("Terminal Features");
  });

  it("keeps original snippet when it is long enough", async () => {
    const cwd = await makeTempCwd();
    const config = createDefaultConfig("searchsocket-engine-test");
    config.ranking.minScore = 0;
    config.ranking.scoreGapThreshold = 0;

    const longSnippet = "This is a sufficiently long snippet that should not be replaced by chunk text fallback.";
    const hits: VectorHit[] = [
      {
        ...makeHit("chunk-long", "/docs"),
        score: 0.9,
        metadata: {
          ...makeHit("chunk-long", "/docs").metadata,
          snippet: longSnippet,
          chunkText: "Different chunk text content."
        }
      }
    ];

    const engine = await SearchEngine.create({
      cwd,
      config,
      store: createMockStore(hits)
    });

    const result = await engine.search({ q: "docs", topK: 10 });
    expect(result.results[0]!.snippet).toBe(longSnippet);
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
      store: createMockStore(hits)
    });

    const result = await engine.search({ q: "test query", topK: 10 });
    // The weak result should be trimmed due to score gap
    expect(result.results.length).toBe(2);
    expect(result.results.map((r) => r.url)).toEqual(["/relevant", "/also-relevant"]);
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
      store: createMockStore(hits)
    });

    const result = await engine.search({ q: "xyzzy gibberish asdf", topK: 10 });
    expect(result.results.length).toBe(0);
  });
});

describe("SearchEngine - dual search", () => {
  it("calls both searchPages and search in parallel when dualSearch is enabled", async () => {
    const cwd = await makeTempCwd();
    const config = createDefaultConfig("searchsocket-engine-test");
    // dualSearch is true by default

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

    // Both search methods should have been called
    expect(store.searchPages).toHaveBeenCalledTimes(1);
    expect(store.search).toHaveBeenCalledTimes(1);

    // Chunk search should NOT have reranking (dual search disables it for chunks)
    expect(store.search).toHaveBeenCalledWith(
      "documentation",
      expect.objectContaining({ reranking: false }),
      expect.any(Object)
    );

    expect(result.results.length).toBeGreaterThan(0);
    expect(result.results[0]!.url).toBe("/docs");
  });

  it("falls back to single search when dualSearch is disabled", async () => {
    const cwd = await makeTempCwd();
    const config = createDefaultConfig("searchsocket-engine-test");
    config.search.dualSearch = false;

    const store = createMockStore([makeHit("chunk-1", "/home")]);
    const engine = await SearchEngine.create({ cwd, config, store });

    await engine.search({ q: "test", topK: 5 });

    expect(store.searchPages).not.toHaveBeenCalled();
    expect(store.search).toHaveBeenCalledTimes(1);
    // Single search should use the configured reranking setting
    expect(store.search).toHaveBeenCalledWith(
      "test",
      expect.objectContaining({ reranking: true }),
      expect.any(Object)
    );
  });

  it("falls back to single search in chunk groupBy mode", async () => {
    const cwd = await makeTempCwd();
    const config = createDefaultConfig("searchsocket-engine-test");
    // dualSearch is true, but groupBy=chunk should bypass it

    const store = createMockStore([makeHit("chunk-1", "/home")]);
    const engine = await SearchEngine.create({ cwd, config, store });

    await engine.search({ q: "test", topK: 5, groupBy: "chunk" });

    expect(store.searchPages).not.toHaveBeenCalled();
    expect(store.search).toHaveBeenCalledTimes(1);
  });

  it("handles empty page search results gracefully", async () => {
    const cwd = await makeTempCwd();
    const config = createDefaultConfig("searchsocket-engine-test");

    const chunkHits: VectorHit[] = [
      { ...makeHit("chunk-1", "/home"), score: 0.8 },
      { ...makeHit("chunk-2", "/about"), score: 0.75 }
    ];
    // No page hits (e.g., page index not yet populated)
    const store = createMockStore(chunkHits, []);
    const engine = await SearchEngine.create({ cwd, config, store });

    const result = await engine.search({ q: "test", topK: 10 });

    expect(result.results.length).toBe(2);
    expect(result.results.map((r) => r.url)).toContain("/home");
    expect(result.results.map((r) => r.url)).toContain("/about");
  });

  it("blends page scores into chunk results", async () => {
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
      }
    ];

    const store = createMockStore(chunkHits, pageHits);
    const engine = await SearchEngine.create({ cwd, config, store });

    const result = await engine.search({ q: "test", topK: 10 });

    expect(result.results.length).toBe(2);
    // /top should still be first since its chunk score (0.9) is higher than /boosted's blended score
    // /boosted blended: (1-0.3)*0.6 + 0.3*1.0 = 0.42 + 0.3 = 0.72 (plus ranking boosts)
    expect(result.results[0]!.url).toBe("/top");
    expect(result.results[1]!.url).toBe("/boosted");
  });
});
