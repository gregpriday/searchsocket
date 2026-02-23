import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { IndexPipeline } from "../src/indexing/pipeline";
import { createDefaultConfig } from "../src/config/defaults";
import { createVectorStore } from "../src/vector";
import type { EmbeddingsProvider, ResolvedSearchSocketConfig } from "../src/types";

const tempDirs: string[] = [];

class PredictableEmbeddings implements EmbeddingsProvider {
  estimateTokens(_text: string): number {
    return 200;
  }

  async embedTexts(texts: string[]): Promise<number[][]> {
    return texts.map(() => [1, 0, 0]);
  }
}

async function createFixture(): Promise<{ cwd: string; config: ResolvedSearchSocketConfig }> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "searchsocket-cost-"));
  tempDirs.push(cwd);

  await fs.mkdir(path.join(cwd, "build", "docs"), { recursive: true });
  await fs.mkdir(path.join(cwd, "src", "routes", "docs"), { recursive: true });

  await fs.writeFile(
    path.join(cwd, "build", "docs", "index.html"),
    `<html><head><title>Docs</title></head><body><main><h1>Docs</h1><p>Token source.</p></main></body></html>`,
    "utf8"
  );
  await fs.writeFile(path.join(cwd, "src", "routes", "docs", "+page.svelte"), "<main>Docs</main>\n", "utf8");

  const config = createDefaultConfig("searchsocket-cost");
  config.source.mode = "static-output";
  config.source.staticOutputDir = "build";
  config.vector.turso.localPath = ".searchsocket/vectors.db";
  config.embeddings.pricePer1kTokens = 0.5;
  config.state.dir = ".searchsocket";

  return { cwd, config };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("IndexPipeline cost estimation", () => {
  it("uses embeddings.pricePer1kTokens when provided", async () => {
    const { cwd, config } = await createFixture();
    const pipeline = await IndexPipeline.create({
      cwd,
      config,
      embeddingsProvider: new PredictableEmbeddings(),
      vectorStore: await createVectorStore(config, cwd)
    });

    const stats = await pipeline.run({ changedOnly: true, dryRun: true });
    expect(stats.chunksChanged).toBe(1);
    expect(stats.estimatedTokens).toBe(200);
    expect(stats.estimatedCostUSD).toBe(0.1);
  });
});
