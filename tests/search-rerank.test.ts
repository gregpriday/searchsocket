import os from "node:os";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SearchEngine } from "../src/search/engine";
import { createDefaultConfig } from "../src/config/defaults";
import type { EmbeddingsProvider, Reranker, RerankCandidate, VectorStore, VectorHit } from "../src/types";

const tempDirs: string[] = [];

class FakeEmbeddings implements EmbeddingsProvider {
  estimateTokens(text: string): number {
    return text.length;
  }

  async embedTexts(): Promise<number[][]> {
    return [[1, 0, 0]];
  }
}

class FakeReranker implements Reranker {
  async rerank(): Promise<Array<{ id: string; score: number }>> {
    return [
      { id: "/b", score: 0.95 },
      { id: "/a", score: 0.15 }
    ];
  }
}

class NonFiniteScoreReranker implements Reranker {
  async rerank(): Promise<Array<{ id: string; score: number }>> {
    return [
      { id: "/a", score: Number.NaN },
      { id: "/b", score: 0.5 }
    ];
  }
}

/** Captures the candidates passed to rerank so tests can inspect them */
class SpyReranker implements Reranker {
  lastCandidates: RerankCandidate[] = [];

  async rerank(_query: string, candidates: RerankCandidate[]): Promise<Array<{ id: string; score: number }>> {
    this.lastCandidates = candidates;
    return candidates.map((c, i) => ({ id: c.id, score: 1 - i * 0.1 }));
  }
}

class FakeStore implements VectorStore {
  async upsert(): Promise<void> {
    return;
  }

  async query(): Promise<VectorHit[]> {
    return [
      {
        id: "first",
        score: 0.99,
        metadata: {
          projectId: "searchsocket-rerank",
          scopeName: "main",
          url: "/a",
          path: "/a",
          title: "A",
          sectionTitle: "",
          headingPath: [],
          snippet: "alpha",
          chunkText: "Full text of alpha page",
          ordinal: 0,
          contentHash: "a",
          modelId: "jina-embeddings-v3",
          depth: 1,
          incomingLinks: 1,
          routeFile: "src/routes/a/+page.svelte",
          tags: []
        }
      },
      {
        id: "second",
        score: 0.1,
        metadata: {
          projectId: "searchsocket-rerank",
          scopeName: "main",
          url: "/b",
          path: "/b",
          title: "B",
          sectionTitle: "",
          headingPath: [],
          snippet: "beta",
          chunkText: "Full text of beta page",
          ordinal: 0,
          contentHash: "b",
          modelId: "jina-embeddings-v3",
          depth: 1,
          incomingLinks: 1,
          routeFile: "src/routes/b/+page.svelte",
          tags: []
        }
      }
    ];
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

  async getPage() {
    return null;
  }

  async deletePages(): Promise<void> {
    return;
  }

  async getScopeModelId() {
    return null;
  }

  async dropAllTables(): Promise<void> {
    return;
  }
}

function makeHit(url: string, ordinal: number, score: number, overrides?: Partial<VectorHit["metadata"]>): VectorHit {
  return {
    id: `${url}-${ordinal}`,
    score,
    metadata: {
      projectId: "searchsocket-rerank",
      scopeName: "main",
      url,
      path: url,
      title: overrides?.title ?? `Page ${url}`,
      sectionTitle: "",
      headingPath: [],
      snippet: `snippet ${url} ord${ordinal}`,
      chunkText: `chunk text ${url} ordinal ${ordinal}`,
      ordinal,
      contentHash: `${url}-${ordinal}`,
      modelId: "jina-embeddings-v3",
      depth: 1,
      incomingLinks: 1,
      routeFile: `src/routes${url}/+page.svelte`,
      tags: [],
      ...overrides
    }
  };
}

/** Returns a single page with 8 chunks at varying scores */
class MultiChunkStore extends FakeStore {
  async query(): Promise<VectorHit[]> {
    return [
      makeHit("/page", 0, 0.95),
      makeHit("/page", 1, 0.90),
      makeHit("/page", 2, 0.85),
      makeHit("/page", 3, 0.80),
      makeHit("/page", 4, 0.70),
      makeHit("/page", 5, 0.60),
      makeHit("/page", 6, 0.30),  // below 50% of best (0.475)
      makeHit("/page", 7, 0.10)   // well below ratio
    ];
  }
}

/** Returns a page where all but the first chunk score well below the ratio */
class LowScoreChunksStore extends FakeStore {
  async query(): Promise<VectorHit[]> {
    return [
      makeHit("/page", 0, 0.90),
      makeHit("/page", 1, 0.10),  // below 50% of 0.90
      makeHit("/page", 2, 0.05)   // below 50% of 0.90
    ];
  }
}

/** Returns a page with description and keywords metadata */
class MetadataStore extends FakeStore {
  async query(): Promise<VectorHit[]> {
    return [
      makeHit("/page", 0, 0.90, {
        title: "My Page Title",
        description: "A helpful page description",
        keywords: ["svelte", "search", "mcp"]
      }),
      makeHit("/page", 1, 0.80, {
        title: "My Page Title",
        description: "A helpful page description",
        keywords: ["svelte", "search", "mcp"]
      })
    ];
  }
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("SearchEngine rerank", () => {
  it("applies reranker ordering when rerank=true", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "searchsocket-rerank-"));
    tempDirs.push(cwd);

    const config = createDefaultConfig("searchsocket-rerank");
    config.rerank.enabled = true;

    const engine = await SearchEngine.create({
      cwd,
      config,
      embeddingsProvider: new FakeEmbeddings(),
      vectorStore: new FakeStore(),
      reranker: new FakeReranker()
    });

    const result = await engine.search({ q: "test", topK: 2, rerank: true });

    expect(result.meta.usedRerank).toBe(true);
    expect(result.results[0]?.url).toBe("/b");
  });

  it("ignores non-finite rerank scores instead of corrupting result order", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "searchsocket-rerank-"));
    tempDirs.push(cwd);

    const config = createDefaultConfig("searchsocket-rerank");
    config.rerank.enabled = true;

    const engine = await SearchEngine.create({
      cwd,
      config,
      embeddingsProvider: new FakeEmbeddings(),
      vectorStore: new FakeStore(),
      reranker: new NonFiniteScoreReranker()
    });

    const result = await engine.search({ q: "test", topK: 2, rerank: true });

    expect(result.results[0]?.url).toBe("/a");
    expect(result.results[1]?.url).toBe("/b");
    for (const entry of result.results) {
      expect(Number.isFinite(entry.score)).toBe(true);
    }
  });

  it("caps chunks per page at 5 for reranker text", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "searchsocket-rerank-"));
    tempDirs.push(cwd);

    const config = createDefaultConfig("searchsocket-rerank");
    config.rerank.enabled = true;

    const spy = new SpyReranker();
    const engine = await SearchEngine.create({
      cwd,
      config,
      embeddingsProvider: new FakeEmbeddings(),
      vectorStore: new MultiChunkStore(),
      reranker: spy
    });

    await engine.search({ q: "test", topK: 5, rerank: true });

    expect(spy.lastCandidates).toHaveLength(1);
    const text = spy.lastCandidates[0]!.text;

    // Should include ordinals 0-4 (top 5 by score) but not 5, 6, or 7
    expect(text).toContain("ordinal 0");
    expect(text).toContain("ordinal 1");
    expect(text).toContain("ordinal 2");
    expect(text).toContain("ordinal 3");
    expect(text).toContain("ordinal 4");
    expect(text).not.toContain("ordinal 5");
    expect(text).not.toContain("ordinal 6");
    expect(text).not.toContain("ordinal 7");
  });

  it("filters chunks below 50% of best score but keeps at least 1", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "searchsocket-rerank-"));
    tempDirs.push(cwd);

    const config = createDefaultConfig("searchsocket-rerank");
    config.rerank.enabled = true;

    const spy = new SpyReranker();
    const engine = await SearchEngine.create({
      cwd,
      config,
      embeddingsProvider: new FakeEmbeddings(),
      vectorStore: new LowScoreChunksStore(),
      reranker: spy
    });

    await engine.search({ q: "test", topK: 5, rerank: true });

    const text = spy.lastCandidates[0]!.text;

    // Best chunk (ordinal 0, score 0.90) always included
    expect(text).toContain("ordinal 0");
    // Chunks with scores 0.10 and 0.05 are below 50% of 0.90 (0.45)
    expect(text).not.toContain("ordinal 1");
    expect(text).not.toContain("ordinal 2");
  });

  it("preserves ordinal order in reranker text after score selection", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "searchsocket-rerank-"));
    tempDirs.push(cwd);

    const config = createDefaultConfig("searchsocket-rerank");
    config.rerank.enabled = true;

    const spy = new SpyReranker();
    const engine = await SearchEngine.create({
      cwd,
      config,
      embeddingsProvider: new FakeEmbeddings(),
      vectorStore: new MultiChunkStore(),
      reranker: spy
    });

    await engine.search({ q: "test", topK: 5, rerank: true });

    const text = spy.lastCandidates[0]!.text;

    // Chunks should appear in ordinal order (0, 1, 2, 3, 4) not score order
    const pos0 = text.indexOf("ordinal 0");
    const pos1 = text.indexOf("ordinal 1");
    const pos2 = text.indexOf("ordinal 2");
    const pos3 = text.indexOf("ordinal 3");
    const pos4 = text.indexOf("ordinal 4");
    expect(pos0).toBeLessThan(pos1);
    expect(pos1).toBeLessThan(pos2);
    expect(pos2).toBeLessThan(pos3);
    expect(pos3).toBeLessThan(pos4);
  });

  it("includes description and keywords in reranker text", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "searchsocket-rerank-"));
    tempDirs.push(cwd);

    const config = createDefaultConfig("searchsocket-rerank");
    config.rerank.enabled = true;

    const spy = new SpyReranker();
    const engine = await SearchEngine.create({
      cwd,
      config,
      embeddingsProvider: new FakeEmbeddings(),
      vectorStore: new MetadataStore(),
      reranker: spy
    });

    await engine.search({ q: "test", topK: 5, rerank: true });

    const text = spy.lastCandidates[0]!.text;

    expect(text).toContain("My Page Title");
    expect(text).toContain("A helpful page description");
    expect(text).toContain("svelte, search, mcp");

    // Verify order: title comes before description, description before keywords, keywords before body
    const titlePos = text.indexOf("My Page Title");
    const descPos = text.indexOf("A helpful page description");
    const kwPos = text.indexOf("svelte, search, mcp");
    const bodyPos = text.indexOf("chunk text");
    expect(titlePos).toBeLessThan(descPos);
    expect(descPos).toBeLessThan(kwPos);
    expect(kwPos).toBeLessThan(bodyPos);
  });
});
