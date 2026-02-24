import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IndexPipeline } from "../src/indexing/pipeline";
import { createDefaultConfig } from "../src/config/defaults";
import type { EmbeddingsProvider, PageRecord, ScopeInfo, VectorStore } from "../src/types";

const tempDirs: string[] = [];

class FakeEmbeddingsProvider implements EmbeddingsProvider {
  estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  async embedTexts(texts: string[]): Promise<number[][]> {
    return texts.map(() => [1, 0, 0, 0]);
  }
}

function makeStore(
  existingHashes: Map<string, string>,
  upsertSpy?: (...args: Parameters<VectorStore["upsert"]>) => Promise<void>
): VectorStore {
  const upsert = async (...args: Parameters<VectorStore["upsert"]>) => {
    if (upsertSpy) {
      await upsertSpy(...args);
    }
  };

  return {
    upsert,
    query: async () => [],
    deleteByIds: async () => undefined,
    deleteScope: async () => undefined,
    listScopes: async () => [
      {
        projectId: "searchsocket-resync",
        scopeName: "main",
        modelId: "jina-embeddings-v3",
        lastIndexedAt: "2026-01-01T00:00:00.000Z",
        vectorCount: existingHashes.size
      } satisfies ScopeInfo
    ],
    recordScope: async () => undefined,
    health: async () => ({ ok: true }),
    getContentHashes: async () => existingHashes,
    upsertPages: async () => undefined,
    getPage: async () => null,
    deletePages: async () => undefined,
    getScopeModelId: async () => "jina-embeddings-v3",
    dropAllTables: async () => undefined
  };
}

async function createFixture(): Promise<string> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "searchsocket-resync-"));
  tempDirs.push(cwd);

  await fs.mkdir(path.join(cwd, "build", "docs"), { recursive: true });
  await fs.mkdir(path.join(cwd, "src", "routes", "docs"), { recursive: true });

  await fs.writeFile(
    path.join(cwd, "build", "docs", "index.html"),
    `
      <html>
        <head><title>Docs</title></head>
        <body><main><h1>Docs</h1><p>Stable content.</p></main></body>
      </html>
    `,
    "utf8"
  );
  await fs.writeFile(path.join(cwd, "src", "routes", "docs", "+page.svelte"), "<main>Docs</main>\n", "utf8");

  return cwd;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("IndexPipeline single-source-of-truth resync", () => {
  it("performs full index when Turso has no existing hashes (fresh state)", async () => {
    const cwd = await createFixture();
    const config = createDefaultConfig("searchsocket-resync");
    config.source.mode = "static-output";
    config.source.staticOutputDir = "build";
    config.state.dir = ".searchsocket";

    const embeddings = new FakeEmbeddingsProvider();
    const upsertSpy = vi.fn().mockResolvedValue(undefined);

    const pipeline = await IndexPipeline.create({
      cwd,
      config,
      embeddingsProvider: embeddings,
      vectorStore: makeStore(new Map(), upsertSpy)
    });

    const stats = await pipeline.run({ changedOnly: true });
    expect(stats.chunksChanged).toBeGreaterThan(0);
    expect(upsertSpy).toHaveBeenCalled();
  });

  it("skips unchanged chunks when Turso has matching hashes", async () => {
    const cwd = await createFixture();
    const config = createDefaultConfig("searchsocket-resync");
    config.source.mode = "static-output";
    config.source.staticOutputDir = "build";
    config.state.dir = ".searchsocket";

    const embeddings = new FakeEmbeddingsProvider();

    // First run to get the hashes
    const firstUpsertSpy = vi.fn().mockResolvedValue(undefined);
    const firstPipeline = await IndexPipeline.create({
      cwd,
      config,
      embeddingsProvider: embeddings,
      vectorStore: makeStore(new Map(), firstUpsertSpy)
    });
    const firstStats = await firstPipeline.run({ changedOnly: true });
    expect(firstStats.chunksChanged).toBeGreaterThan(0);

    // Collect the hashes from the upserted records
    const existingHashes = new Map<string, string>();
    for (const call of firstUpsertSpy.mock.calls) {
      const records = call[0];
      for (const record of records) {
        existingHashes.set(record.id, record.metadata.contentHash);
      }
    }

    // Second run with existing hashes should skip all chunks
    const secondUpsertSpy = vi.fn().mockResolvedValue(undefined);
    const secondPipeline = await IndexPipeline.create({
      cwd,
      config,
      embeddingsProvider: embeddings,
      vectorStore: makeStore(existingHashes, secondUpsertSpy)
    });
    const secondStats = await secondPipeline.run({ changedOnly: true });

    expect(secondStats.chunksChanged).toBe(0);
    expect(secondUpsertSpy).not.toHaveBeenCalled();
  });
});
