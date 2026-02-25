import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SearchEngine } from "../src/search/engine";
import { createDefaultConfig } from "../src/config/defaults";
import type { EmbeddingsProvider, Reranker, VectorHit, VectorStore } from "../src/types";

const tempDirs: string[] = [];

class FakeEmbeddings implements EmbeddingsProvider {
  estimateTokens(text: string): number {
    return text.length;
  }
  async embedTexts(): Promise<number[][]> {
    return [[1, 0, 0]];
  }
}

function makeFakeStore(hits: VectorHit[] = []): VectorStore {
  return {
    upsert: async () => undefined,
    query: async () => hits,
    deleteByIds: async () => undefined,
    deleteScope: async () => undefined,
    listScopes: async () => [],
    recordScope: async () => undefined,
    health: async () => ({ ok: true }),
    getContentHashes: async () => new Map(),
    upsertPages: async () => undefined,
    getPage: async () => null,
    deletePages: async () => undefined,
    getScopeModelId: async () => null,
    dropAllTables: async () => undefined
  };
}

function makeHit(id: string, url: string, score = 0.8): VectorHit {
  return {
    id,
    score,
    metadata: {
      projectId: "test",
      scopeName: "main",
      url,
      path: url,
      title: `Title ${id}`,
      sectionTitle: "",
      headingPath: [],
      snippet: `Snippet ${id}`,
      chunkText: `Full text ${id}`,
      ordinal: 0,
      contentHash: `hash-${id}`,
      modelId: "jina-embeddings-v3",
      depth: 1,
      incomingLinks: 0,
      routeFile: "src/routes/+page.svelte",
      tags: []
    }
  };
}

async function makeTempCwd(): Promise<string> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "searchsocket-stream-"));
  tempDirs.push(cwd);
  return cwd;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("SearchEngine.searchStreaming", () => {
  it("yields single initial event when rerank is false", async () => {
    const cwd = await makeTempCwd();
    const config = createDefaultConfig("test");
    const hits = [makeHit("a", "/a", 0.9), makeHit("b", "/b", 0.7)];

    const engine = await SearchEngine.create({
      cwd,
      config,
      embeddingsProvider: new FakeEmbeddings(),
      vectorStore: makeFakeStore(hits)
    });

    const events = [];
    for await (const event of engine.searchStreaming({ q: "test", rerank: false })) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
    expect(events[0]!.phase).toBe("initial");
    expect(events[0]!.data.results.length).toBeGreaterThan(0);
    expect(events[0]!.data.meta.usedRerank).toBe(false);
  });

  it("yields two events (initial + reranked) when rerank is true", async () => {
    const cwd = await makeTempCwd();
    const config = createDefaultConfig("test");
    config.rerank.enabled = true;

    const hits = [makeHit("a", "/a", 0.9), makeHit("b", "/b", 0.7)];

    const fakeReranker: Reranker = {
      rerank: async (_query, candidates) =>
        candidates.map((c, i) => ({ id: c.id, score: 1 - i * 0.1 }))
    };

    const engine = await SearchEngine.create({
      cwd,
      config,
      embeddingsProvider: new FakeEmbeddings(),
      vectorStore: makeFakeStore(hits),
      reranker: fakeReranker
    });

    const events = [];
    for await (const event of engine.searchStreaming({ q: "test", rerank: true })) {
      events.push(event);
    }

    expect(events).toHaveLength(2);
    expect(events[0]!.phase).toBe("initial");
    expect(events[0]!.data.meta.usedRerank).toBe(false);
    expect(events[0]!.data.meta.timingsMs.rerank).toBe(0);

    expect(events[1]!.phase).toBe("reranked");
    expect(events[1]!.data.meta.usedRerank).toBe(true);
    expect(events[1]!.data.meta.timingsMs.rerank).toBeGreaterThanOrEqual(0);
  });

  it("streaming results match non-streaming results", async () => {
    const cwd = await makeTempCwd();
    const config = createDefaultConfig("test");

    const hits = [
      makeHit("a", "/a", 0.9),
      makeHit("b", "/b", 0.7),
      makeHit("c", "/c", 0.5)
    ];

    const engine = await SearchEngine.create({
      cwd,
      config,
      embeddingsProvider: new FakeEmbeddings(),
      vectorStore: makeFakeStore(hits)
    });

    // Non-streaming
    const standard = await engine.search({ q: "test" });

    // Streaming (no rerank — single event should match)
    const events = [];
    for await (const event of engine.searchStreaming({ q: "test" })) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
    expect(events[0]!.data.results.map((r) => r.url)).toEqual(
      standard.results.map((r) => r.url)
    );
  });

  it("yields single initial event when rerank is omitted (defaults to false)", async () => {
    const cwd = await makeTempCwd();
    const config = createDefaultConfig("test");

    const engine = await SearchEngine.create({
      cwd,
      config,
      embeddingsProvider: new FakeEmbeddings(),
      vectorStore: makeFakeStore([makeHit("a", "/a")])
    });

    const events = [];
    for await (const event of engine.searchStreaming({ q: "test" })) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
    expect(events[0]!.phase).toBe("initial");
  });

  it("throws on invalid request", async () => {
    const cwd = await makeTempCwd();
    const config = createDefaultConfig("test");

    const engine = await SearchEngine.create({
      cwd,
      config,
      embeddingsProvider: new FakeEmbeddings(),
      vectorStore: makeFakeStore()
    });

    const gen = engine.searchStreaming({ q: "   " });
    await expect(gen.next()).rejects.toMatchObject({
      code: "INVALID_REQUEST"
    });
  });

  it("both phases share the same query and scope", async () => {
    const cwd = await makeTempCwd();
    const config = createDefaultConfig("test");
    config.rerank.enabled = true;

    const fakeReranker: Reranker = {
      rerank: async (_query, candidates) =>
        candidates.map((c, i) => ({ id: c.id, score: 1 - i * 0.1 }))
    };

    const engine = await SearchEngine.create({
      cwd,
      config,
      embeddingsProvider: new FakeEmbeddings(),
      vectorStore: makeFakeStore([makeHit("a", "/a")]),
      reranker: fakeReranker
    });

    const events = [];
    for await (const event of engine.searchStreaming({ q: "hello", rerank: true })) {
      events.push(event);
    }

    expect(events[0]!.data.q).toBe("hello");
    expect(events[1]!.data.q).toBe("hello");
    expect(events[0]!.data.scope).toBe(events[1]!.data.scope);
  });
});
