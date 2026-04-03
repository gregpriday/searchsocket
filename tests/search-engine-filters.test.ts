import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SearchEngine } from "../src/search/engine";
import { createDefaultConfig } from "../src/config/defaults";
import type { PageHit, VectorHit } from "../src/types";
import type { UpstashSearchStore } from "../src/vector/upstash";

const tempDirs: string[] = [];

function createMockStore(hits: VectorHit[] = [], pageHits: PageHit[] = []): UpstashSearchStore & {
  search: ReturnType<typeof vi.fn>;
  searchPagesByText: ReturnType<typeof vi.fn>;
  searchPagesByVector: ReturnType<typeof vi.fn>;
  searchChunksByUrl: ReturnType<typeof vi.fn>;
} {
  const store = {
    upsertChunks: vi.fn(async () => undefined),
    search: vi.fn(async () => hits),
    searchPagesByText: vi.fn(async () => pageHits),
    searchPagesByVector: vi.fn(async () => pageHits),
    searchChunksByUrl: vi.fn(async (_data: string, url: string) => {
      return hits.filter((h) => h.metadata.url === url);
    }),
    deleteByIds: vi.fn(async () => undefined),
    deleteScope: vi.fn(async () => undefined),
    listScopes: vi.fn(async () => []),
    health: vi.fn(async () => ({ ok: true })),
    getContentHashes: vi.fn(async () => new Map<string, string>()),
    fetchContentHashesForKeys: vi.fn(async () => new Map<string, string>()),
    scanChunkIds: vi.fn(async () => new Set<string>()),
    upsertPages: vi.fn(async () => undefined),
    getPage: vi.fn(async () => null),
    listPages: vi.fn(async () => ({ pages: [] })),
    deletePages: vi.fn(async () => undefined),
    getPageHashes: vi.fn(async () => new Map()),
    deletePagesByIds: vi.fn(async () => undefined),
    dropAllIndexes: vi.fn(async () => undefined)
  };
  return store as unknown as UpstashSearchStore & {
    search: ReturnType<typeof vi.fn>;
    searchPagesByText: ReturnType<typeof vi.fn>;
    searchPagesByVector: ReturnType<typeof vi.fn>;
    searchChunksByUrl: ReturnType<typeof vi.fn>;
  };
}

function makeHit(id: string, url: string): VectorHit {
  return {
    id,
    score: 0.8,
    metadata: {
      projectId: "test",
      scopeName: "main",
      url,
      path: url,
      title: "Title",
      sectionTitle: "",
      headingPath: [],
      snippet: "Snippet text here for testing purposes",
      chunkText: "Full chunk text content",
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
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ss-filter-"));
  tempDirs.push(cwd);
  return cwd;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("SearchEngine — metadata filters", () => {
  it("passes metadata filter string to store.search() in chunk mode", async () => {
    const cwd = await makeTempCwd();
    const config = createDefaultConfig("test");
    const store = createMockStore([makeHit("1", "/page")]);

    const engine = await SearchEngine.create({
      cwd,
      config,
      store,

    });

    await engine.search({
      q: "test query",
      groupBy: "chunk",
      filters: { version: 2 }
    });

    expect(store.search).toHaveBeenCalledTimes(1);
    const callArgs = store.search.mock.calls[0]!;
    expect(callArgs[1].filter).toBe("meta.version = 2");
  });

  it("passes metadata filter to searchPages in page-first mode", async () => {
    const cwd = await makeTempCwd();
    const config = createDefaultConfig("test");
    const pageHits: PageHit[] = [
      { id: "/page", score: 0.8, title: "Title", url: "/page", description: "", tags: [], depth: 1, incomingLinks: 0, routeFile: "" }
    ];
    const store = createMockStore([makeHit("1", "/page")], pageHits);

    const engine = await SearchEngine.create({
      cwd,
      config,
      store,

    });

    await engine.search({
      q: "test query",
      filters: { deprecated: false, category: "auth" }
    });

    expect(store.searchPagesByText).toHaveBeenCalledTimes(1);

    const pageFilter = store.searchPagesByText.mock.calls[0]![1].filter;
    expect(pageFilter).toContain("meta.deprecated = false");
    expect(pageFilter).toContain("meta.category CONTAINS 'auth'");

    // searchChunksByUrl also receives the filter
    expect(store.searchChunksByUrl).toHaveBeenCalledTimes(1);
    const chunkFilter = store.searchChunksByUrl.mock.calls[0]![2].filter;
    expect(chunkFilter).toBe(pageFilter);
  });

  it("does not pass filter when filters is empty", async () => {
    const cwd = await makeTempCwd();
    const config = createDefaultConfig("test");
    const store = createMockStore([makeHit("1", "/page")]);

    const engine = await SearchEngine.create({
      cwd,
      config,
      store,

    });

    await engine.search({ q: "test", groupBy: "chunk", filters: {} });

    const callArgs = store.search.mock.calls[0]!;
    expect(callArgs[1].filter).toBeUndefined();
  });

  it("does not pass filter when filters is omitted", async () => {
    const cwd = await makeTempCwd();
    const config = createDefaultConfig("test");
    const store = createMockStore([makeHit("1", "/page")]);

    const engine = await SearchEngine.create({
      cwd,
      config,
      store,

    });

    await engine.search({ q: "test", groupBy: "chunk" });

    const callArgs = store.search.mock.calls[0]!;
    expect(callArgs[1].filter).toBeUndefined();
  });
});
