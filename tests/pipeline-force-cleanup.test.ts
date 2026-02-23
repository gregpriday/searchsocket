import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { IndexPipeline } from "../src/indexing/pipeline";
import { createDefaultConfig } from "../src/config/defaults";
import { createVectorStore } from "../src/vector";
import type { EmbeddingsProvider, ResolvedSearchSocketConfig } from "../src/types";

const tempDirs: string[] = [];

class FakeEmbeddingsProvider implements EmbeddingsProvider {
  estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  async embedTexts(texts: string[]): Promise<number[][]> {
    return texts.map(() => [1, 0, 0, 0]);
  }
}

async function createFixture(): Promise<{ cwd: string; config: ResolvedSearchSocketConfig }> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "searchsocket-force-"));
  tempDirs.push(cwd);

  await fs.mkdir(path.join(cwd, "build", "docs", "keep"), { recursive: true });
  await fs.mkdir(path.join(cwd, "build", "docs", "remove"), { recursive: true });
  await fs.mkdir(path.join(cwd, "src", "routes", "docs", "keep"), { recursive: true });
  await fs.mkdir(path.join(cwd, "src", "routes", "docs", "remove"), { recursive: true });

  await fs.writeFile(
    path.join(cwd, "build", "docs", "keep", "index.html"),
    "<html><head><title>Keep</title></head><body><main><h1>Keep</h1><p>Keep me indexed.</p></main></body></html>",
    "utf8"
  );
  await fs.writeFile(
    path.join(cwd, "build", "docs", "remove", "index.html"),
    "<html><head><title>Remove</title></head><body><main><h1>Remove</h1><p>Delete me from index.</p></main></body></html>",
    "utf8"
  );

  await fs.writeFile(path.join(cwd, "src", "routes", "docs", "keep", "+page.svelte"), "<main>Keep</main>\n", "utf8");
  await fs.writeFile(path.join(cwd, "src", "routes", "docs", "remove", "+page.svelte"), "<main>Remove</main>\n", "utf8");

  const config = createDefaultConfig("searchsocket-force");
  config.source.mode = "static-output";
  config.source.staticOutputDir = "build";
  config.vector.turso.localPath = ".searchsocket/vectors.db";
  config.state.dir = ".searchsocket";

  return { cwd, config };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("IndexPipeline force cleanup", () => {
  it("removes stale vectors for deleted pages during a force reindex", async () => {
    const { cwd, config } = await createFixture();
    const embeddings = new FakeEmbeddingsProvider();
    const vectorStore = await createVectorStore(config, cwd);

    const scope = {
      projectId: config.project.id,
      scopeName: "main",
      scopeId: `${config.project.id}:main`
    };

    const firstPipeline = await IndexPipeline.create({
      cwd,
      config,
      embeddingsProvider: embeddings,
      vectorStore
    });

    const firstStats = await firstPipeline.run({ changedOnly: true });
    expect(firstStats.chunksTotal).toBeGreaterThan(1);

    const firstHashes = await vectorStore.getContentHashes(scope);
    expect(firstHashes.size).toBe(firstStats.chunksTotal);

    await fs.rm(path.join(cwd, "build", "docs", "remove"), { recursive: true, force: true });

    const secondPipeline = await IndexPipeline.create({
      cwd,
      config,
      embeddingsProvider: embeddings,
      vectorStore
    });

    const secondStats = await secondPipeline.run({ changedOnly: true, force: true });
    const secondHashes = await vectorStore.getContentHashes(scope);

    expect(secondStats.chunksTotal).toBeLessThan(firstStats.chunksTotal);
    expect(secondHashes.size).toBe(secondStats.chunksTotal);

    const removedChunkIds = [...firstHashes.keys()].filter((id) => !secondHashes.has(id));
    expect(removedChunkIds.length).toBeGreaterThan(0);
  });
});
