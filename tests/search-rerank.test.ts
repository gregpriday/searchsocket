import os from "node:os";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SearchEngine } from "../src/search/engine";
import { createDefaultConfig } from "../src/config/defaults";
import type { EmbeddingsProvider, Reranker, VectorStore, VectorHit } from "../src/types";

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
      { id: "second", score: 0.95 },
      { id: "first", score: 0.15 }
    ];
  }
}

class NonFiniteScoreReranker implements Reranker {
  async rerank(): Promise<Array<{ id: string; score: number }>> {
    return [
      { id: "first", score: Number.NaN },
      { id: "second", score: 0.5 }
    ];
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
          contentHash: "a",
          modelId: "text-embedding-3-small",
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
          contentHash: "b",
          modelId: "text-embedding-3-small",
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
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("SearchEngine rerank", () => {
  it("applies reranker ordering when rerank=true", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "searchsocket-rerank-"));
    tempDirs.push(cwd);

    const config = createDefaultConfig("searchsocket-rerank");
    config.rerank.provider = "jina";

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
    config.rerank.provider = "jina";

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
});
