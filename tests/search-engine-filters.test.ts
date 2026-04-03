import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SearchEngine } from "../src/search/engine";
import { createDefaultConfig } from "../src/config/defaults";
import type { PageHit, VectorHit } from "../src/types";
import type { UpstashSearchStore } from "../src/vector/upstash";
import { createMockEmbedder } from "./helpers/mock-embedder";

const tempDirs: string[] = [];

function createMockStore(hits: VectorHit[] = [], pageHits: PageHit[] = []): UpstashSearchStore & {
  search: ReturnType<typeof vi.fn>;
  searchPages: ReturnType<typeof vi.fn>;
} {
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
    getPage: vi.fn(async () => null),
    listPages: vi.fn(async () => ({ pages: [] })),
    deletePages: vi.fn(async () => undefined),
    getPageHashes: vi.fn(async () => new Map()),
    deletePagesByIds: vi.fn(async () => undefined),
    dropAllIndexes: vi.fn(async () => undefined)
  };
  return store as unknown as UpstashSearchStore & {
    search: ReturnType<typeof vi.fn>;
    searchPages: ReturnType<typeof vi.fn>;
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
  it("passes metadata filter string to store.search()", async () => {
    const cwd = await makeTempCwd();
    const config = createDefaultConfig("test");
    config.search.dualSearch = false;
    const store = createMockStore([makeHit("1", "/page")]);

    const engine = await SearchEngine.create({
      cwd,
      config,
      store,
      embedder: createMockEmbedder()
    });

    await engine.search({
      q: "test query",
      filters: { version: 2 }
    });

    expect(store.search).toHaveBeenCalledTimes(1);
    const callArgs = store.search.mock.calls[0];
    expect(callArgs[1].filter).toBe("meta.version = 2");
  });

  it("passes metadata filter to both store.search and store.searchPages in dual search", async () => {
    const cwd = await makeTempCwd();
    const config = createDefaultConfig("test");
    config.search.dualSearch = true;
    const store = createMockStore([makeHit("1", "/page")], []);

    const engine = await SearchEngine.create({
      cwd,
      config,
      store,
      embedder: createMockEmbedder()
    });

    await engine.search({
      q: "test query",
      filters: { deprecated: false, category: "auth" }
    });

    expect(store.search).toHaveBeenCalledTimes(1);
    expect(store.searchPages).toHaveBeenCalledTimes(1);

    const chunkFilter = store.search.mock.calls[0][1].filter;
    const pageFilter = store.searchPages.mock.calls[0][1].filter;

    // Both should have the same filter
    expect(chunkFilter).toBe(pageFilter);
    expect(chunkFilter).toContain("meta.deprecated = false");
    expect(chunkFilter).toContain("meta.category CONTAINS 'auth'");
  });

  it("does not pass filter when filters is empty", async () => {
    const cwd = await makeTempCwd();
    const config = createDefaultConfig("test");
    config.search.dualSearch = false;
    const store = createMockStore([makeHit("1", "/page")]);

    const engine = await SearchEngine.create({
      cwd,
      config,
      store,
      embedder: createMockEmbedder()
    });

    await engine.search({ q: "test", filters: {} });

    const callArgs = store.search.mock.calls[0];
    expect(callArgs[1].filter).toBeUndefined();
  });

  it("does not pass filter when filters is omitted", async () => {
    const cwd = await makeTempCwd();
    const config = createDefaultConfig("test");
    config.search.dualSearch = false;
    const store = createMockStore([makeHit("1", "/page")]);

    const engine = await SearchEngine.create({
      cwd,
      config,
      store,
      embedder: createMockEmbedder()
    });

    await engine.search({ q: "test" });

    const callArgs = store.search.mock.calls[0];
    expect(callArgs[1].filter).toBeUndefined();
  });
});
