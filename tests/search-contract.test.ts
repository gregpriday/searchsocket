import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SearchEngine } from "../src/search/engine";
import { rankPageHits } from "../src/search/ranking";
import { createDefaultConfig } from "../src/config/defaults";
import { mergeConfig } from "../src/config/load";
import type { PageHit, ResolvedSearchSocketConfig, VectorHit } from "../src/types";
import type { UpstashSearchStore } from "../src/vector/upstash";

/**
 * Release-blocking invariant: there is one search architecture, every
 * documented ranking control affects it, and its backend cost is bounded.
 *
 * Before this, `search.dualSearch` and `search.pageSearchWeight` were tunable
 * options wired to a function the default path never called, while
 * `enableAnchorTextBoost` and per-page weights had no data to act on.
 */

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

async function makeTempCwd(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "searchsocket-contract-"));
  tempDirs.push(dir);
  return dir;
}

function makePageHit(url: string, overrides: Partial<PageHit> = {}): PageHit {
  return {
    id: url,
    score: 0.5,
    title: url,
    url,
    description: "",
    tags: [],
    depth: 1,
    incomingLinks: 0,
    routeFile: "",
    ...overrides
  };
}

function makeChunkHit(url: string): VectorHit {
  return {
    id: `chunk-${url}`,
    score: 0.5,
    metadata: {
      projectId: "p",
      scopeName: "main",
      url,
      path: url,
      title: url,
      sectionTitle: "",
      headingPath: [],
      snippet: "snippet",
      chunkText: "text",
      ordinal: 0,
      contentHash: "h",
      depth: 1,
      incomingLinks: 0,
      routeFile: "",
      tags: []
    }
  } as VectorHit;
}

describe("removed dual-search contract", () => {
  it("no longer exposes dualSearch or pageSearchWeight", () => {
    const config = createDefaultConfig("x") as ResolvedSearchSocketConfig & {
      search?: unknown;
    };
    expect(config.search).toBeUndefined();
  });

  it("rejects a config that still sets them, naming the replacement", async () => {
    const dir = await makeTempCwd();
    expect(() => mergeConfig(dir, { search: { dualSearch: true } } as never)).toThrow(
      /search\.dualSearch/
    );
    expect(() => mergeConfig(dir, { search: { pageSearchWeight: 0.4 } } as never)).toThrow(
      /ranking\.weights/
    );
  });
});

describe("ranking signals are live, not decorative", () => {
  const base = createDefaultConfig("x");

  it("applies a per-page weight declared on the page itself", () => {
    // Extraction read `searchsocket-weight` but only used it to drop
    // zero-weight pages, so a page asking to rank higher was ignored.
    const config = structuredClone(base);
    const [boosted] = rankPageHits([makePageHit("/a", { weight: 2 })], config, "q");
    const [plain] = rankPageHits([makePageHit("/a")], config, "q");

    expect(boosted!.finalScore).toBeGreaterThan(plain!.finalScore);
    expect(boosted!.pageWeight).toBe(2);
  });

  it("prefers a page's own weight over a config pattern", () => {
    const config = structuredClone(base);
    config.ranking.pageWeights = { "/a": 0.5 };

    const [ranked] = rankPageHits([makePageHit("/a", { weight: 3 })], config, "q");
    expect(ranked!.pageWeight).toBe(3);
  });

  it("lets a config weight of zero veto a page that declares its own weight", () => {
    // Config zero is an operator-level suppression; page markup must not
    // override it, or a page could opt itself back into a suppressed section.
    const config = structuredClone(base);
    config.ranking.pageWeights = { "/legacy": 0 };

    expect(rankPageHits([makePageHit("/legacy", { weight: 1 })], config, "q")).toEqual([]);
  });

  it("still honours a config pattern when the page declares nothing", () => {
    const config = structuredClone(base);
    config.ranking.pageWeights = { "/a": 0.5 };

    const [ranked] = rankPageHits([makePageHit("/a")], config, "q");
    expect(ranked!.pageWeight).toBe(0.5);
  });

  it("drops a page whose own weight is zero", () => {
    const config = structuredClone(base);
    expect(rankPageHits([makePageHit("/a", { weight: 0 })], config, "q")).toEqual([]);
  });

  it("applies the anchor-text boost when enabled", () => {
    // PageHit had no incomingAnchorText, so this documented option was inert.
    const config = structuredClone(base);
    config.ranking.enableAnchorTextBoost = true;

    const [withAnchor] = rankPageHits(
      [makePageHit("/a", { incomingAnchorText: "authentication guide" })],
      config,
      "authentication"
    );
    const [without] = rankPageHits([makePageHit("/a")], config, "authentication");

    expect(withAnchor!.finalScore).toBeGreaterThan(without!.finalScore);
  });

  it("contributes exactly zero when the anchor-text boost is disabled", () => {
    const config = structuredClone(base);
    config.ranking.enableAnchorTextBoost = false;

    const [withAnchor] = rankPageHits(
      [makePageHit("/a", { incomingAnchorText: "authentication guide" })],
      config,
      "authentication"
    );
    const [without] = rankPageHits([makePageHit("/a")], config, "authentication");

    expect(withAnchor!.finalScore).toBe(without!.finalScore);
  });

  it("boosts when the anchor text is a subset of the query, matching chunk mode", () => {
    // Page ranking required the anchor to contain the whole query while chunk
    // ranking accepted either containing the other, so the same anchor boosted
    // one mode and not the other.
    const config = structuredClone(base);
    config.ranking.enableAnchorTextBoost = true;

    const [withAnchor] = rankPageHits(
      [makePageHit("/a", { incomingAnchorText: "authentication" })],
      config,
      "authentication guide"
    );
    const [without] = rankPageHits([makePageHit("/a")], config, "authentication guide");

    expect(withAnchor!.finalScore).toBeGreaterThan(without!.finalScore);
  });

  it("reports every active signal in the debug breakdown", () => {
    const config = structuredClone(base);
    config.ranking.enableAnchorTextBoost = true;

    const [ranked] = rankPageHits(
      [makePageHit("/a", { incomingAnchorText: "guide", weight: 2 })],
      config,
      "guide",
      true
    );

    expect(ranked!.breakdown).toBeDefined();
    expect(ranked!.breakdown!.pageWeight).toBe(2);
    expect(ranked!.breakdown!.anchorTextMatchBoost).toBeGreaterThan(0);
  });
});

describe("bounded backend fan-out", () => {
  function createCountingStore(pageCount: number) {
    const searchChunksByUrl = vi.fn(async () => [makeChunkHit("/p")]);
    const inFlight = { current: 0, peak: 0 };

    const store = {
      searchPagesByText: vi.fn(async () =>
        Array.from({ length: pageCount }, (_, i) => makePageHit(`/p${i}`, { score: 1 - i / 1000 }))
      ),
      searchChunksByUrl: vi.fn(async (...args: unknown[]) => {
        inFlight.current += 1;
        inFlight.peak = Math.max(inFlight.peak, inFlight.current);
        await new Promise((resolve) => setTimeout(resolve, 1));
        inFlight.current -= 1;
        return searchChunksByUrl(...(args as []));
      }),
      search: vi.fn(async () => []),
      getPage: vi.fn(async () => null),
      health: vi.fn(async () => ({ ok: true }))
    } as unknown as UpstashSearchStore;

    return { store, inFlight };
  }

  it("does not issue one request per page for a large topK", async () => {
    // topK: 100 used to launch 100 simultaneous chunk queries.
    const cwd = await makeTempCwd();
    const config = createDefaultConfig("searchsocket-contract");
    const { store } = createCountingStore(100);

    const engine = await SearchEngine.create({ cwd, config, store });
    await engine.search({ q: "test", topK: 100 });

    expect(vi.mocked(store.searchChunksByUrl).mock.calls.length).toBeLessThanOrEqual(10);
  });

  it("caps how many section lookups run at once", async () => {
    const cwd = await makeTempCwd();
    const config = createDefaultConfig("searchsocket-contract");
    const { store, inFlight } = createCountingStore(100);

    const engine = await SearchEngine.create({ cwd, config, store });
    await engine.search({ q: "test", topK: 100 });

    expect(inFlight.peak).toBeLessThanOrEqual(5);
  });

  it("still returns every requested page, expanded or not", async () => {
    const cwd = await makeTempCwd();
    const config = createDefaultConfig("searchsocket-contract");
    const { store } = createCountingStore(30);

    const engine = await SearchEngine.create({ cwd, config, store });
    const result = await engine.search({ q: "test", topK: 30 });

    // Pages past the expansion limit are results in their own right; they just
    // carry no section sub-results.
    expect(result.results.length).toBe(30);
  });

  it("makes exactly one page query regardless of topK", async () => {
    const cwd = await makeTempCwd();
    const config = createDefaultConfig("searchsocket-contract");
    const { store } = createCountingStore(50);

    const engine = await SearchEngine.create({ cwd, config, store });
    await engine.search({ q: "test", topK: 50 });

    expect(vi.mocked(store.searchPagesByText)).toHaveBeenCalledTimes(1);
  });
});

describe("filter validation", () => {
  it("rejects an unrepresentable filter value as a client error", async () => {
    const cwd = await makeTempCwd();
    const config = createDefaultConfig("searchsocket-contract");
    const store = {
      searchPagesByText: vi.fn(async () => []),
      searchChunksByUrl: vi.fn(async () => []),
      search: vi.fn(async () => []),
      health: vi.fn(async () => ({ ok: true }))
    } as unknown as UpstashSearchStore;

    const engine = await SearchEngine.create({ cwd, config, store });

    await expect(
      engine.search({ q: "test", filters: { category: "O'Reilly" } })
    ).rejects.toMatchObject({ code: "INVALID_REQUEST", status: 400 });
    // It must not reach the backend at all.
    expect(store.searchPagesByText).not.toHaveBeenCalled();
  });
});

describe("removed keys are rejected in requests, not just config files", () => {
  async function engineWithStore() {
    const cwd = await makeTempCwd();
    const config = createDefaultConfig("searchsocket-contract");
    const store = {
      searchPagesByText: vi.fn(async () => []),
      searchChunksByUrl: vi.fn(async () => []),
      search: vi.fn(async () => []),
      health: vi.fn(async () => ({ ok: true }))
    } as unknown as UpstashSearchStore;
    return SearchEngine.create({ cwd, config, store });
  }

  it("rejects a rankingOverrides key that no longer exists", async () => {
    const engine = await engineWithStore();
    await expect(
      engine.search({
        q: "test",
        rankingOverrides: { search: { pageSearchWeight: 0.8 } }
      } as never)
    ).rejects.toBeTruthy();
  });

  it("rejects a removed aggregation override", async () => {
    const engine = await engineWithStore();
    await expect(
      engine.search({
        q: "test",
        rankingOverrides: { ranking: { aggregationCap: 3 } }
      } as never)
    ).rejects.toBeTruthy();
  });

  it("still accepts a live override", async () => {
    const engine = await engineWithStore();
    await expect(
      engine.search({
        q: "test",
        rankingOverrides: { ranking: { weights: { titleMatch: 0.3 } } }
      })
    ).resolves.toBeTruthy();
  });
});
