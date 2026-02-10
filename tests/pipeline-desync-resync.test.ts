import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IndexPipeline } from "../src/indexing/pipeline";
import { createDefaultConfig } from "../src/config/defaults";
import type { EmbeddingsProvider, ScopeInfo, VectorStore } from "../src/types";

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
  remoteVectorCount: number,
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
        modelId: "text-embedding-3-small",
        lastIndexedAt: "2026-01-01T00:00:00.000Z",
        vectorCount: remoteVectorCount
      } satisfies ScopeInfo
    ],
    recordScope: async () => undefined,
    health: async () => ({ ok: true })
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

describe("IndexPipeline desync recovery", () => {
  it("re-syncs unchanged chunks when remote scope reports zero vectors", async () => {
    const cwd = await createFixture();
    const config = createDefaultConfig("searchsocket-resync");
    config.source.mode = "static-output";
    config.source.staticOutputDir = "build";
    config.state.dir = ".searchsocket";

    const embeddings = new FakeEmbeddingsProvider();

    const first = await IndexPipeline.create({
      cwd,
      config,
      embeddingsProvider: embeddings,
      vectorStore: makeStore(1)
    });
    const firstStats = await first.run({ changedOnly: true });
    expect(firstStats.chunksChanged).toBeGreaterThan(0);

    const upsertSpy = vi.fn().mockResolvedValue(undefined);
    const second = await IndexPipeline.create({
      cwd,
      config,
      embeddingsProvider: embeddings,
      vectorStore: makeStore(0, upsertSpy)
    });
    const secondStats = await second.run({ changedOnly: true });

    expect(secondStats.chunksChanged).toBeGreaterThan(0);
    expect(upsertSpy).toHaveBeenCalled();
  });
});
