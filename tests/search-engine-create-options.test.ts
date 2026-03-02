import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultConfig } from "../src/config/defaults";
import { SearchEngine } from "../src/search/engine";
import type { UpstashSearchStore } from "../src/vector/upstash";

function createMockStore(): UpstashSearchStore {
  return {
    upsertChunks: vi.fn(async () => undefined),
    search: vi.fn(async () => []),
    deleteByIds: vi.fn(async () => undefined),
    deleteScope: vi.fn(async () => undefined),
    listScopes: vi.fn(async () => []),
    health: vi.fn(async () => ({ ok: true })),
    getContentHashes: vi.fn(async () => new Map<string, string>()),
    upsertPages: vi.fn(async () => undefined),
    getPage: vi.fn(async () => null),
    deletePages: vi.fn(async () => undefined),
    dropAllIndexes: vi.fn(async () => undefined)
  } as unknown as UpstashSearchStore;
}

describe("SearchEngine.create options", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates an engine with a provided store", async () => {
    const config = createDefaultConfig("searchsocket-engine-create");
    const store = createMockStore();

    const engine = await SearchEngine.create({
      config,
      store
    });

    expect(engine).toBeDefined();
    expect(typeof engine.search).toBe("function");
    expect(typeof engine.getPage).toBe("function");
  });

  it("returns config via getConfig", async () => {
    const config = createDefaultConfig("searchsocket-engine-create");
    const store = createMockStore();

    const engine = await SearchEngine.create({
      config,
      store
    });

    expect(engine.getConfig()).toBe(config);
  });
});
