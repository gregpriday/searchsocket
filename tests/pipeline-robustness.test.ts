import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { IndexPipeline } from "../src/indexing/pipeline";
import { createDefaultConfig } from "../src/config/defaults";
import { createVectorStore } from "../src/vector";
import type { EmbeddingsProvider, ResolvedSearchSocketConfig } from "../src/types";

const tempDirs: string[] = [];

class MismatchedEmbeddingsProvider implements EmbeddingsProvider {
  estimateTokens(text: string): number {
    return text.length;
  }

  async embedTexts(texts: string[]): Promise<number[][]> {
    if (texts.length <= 1) {
      return [];
    }

    // Return fewer vectors than requested to simulate a provider bug.
    return texts.slice(1).map(() => [1, 0, 0]);
  }
}

async function createProjectFixture(): Promise<{ cwd: string; config: ResolvedSearchSocketConfig }> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "searchsocket-pipeline-robust-"));
  tempDirs.push(cwd);

  await fs.mkdir(path.join(cwd, "build", "docs"), { recursive: true });
  await fs.mkdir(path.join(cwd, "src", "routes", "docs"), { recursive: true });

  await fs.writeFile(
    path.join(cwd, "build", "docs", "index.html"),
    `
      <html><head><title>Docs</title></head>
      <body><main><h1>Docs</h1><p>One page for chunking.</p></main></body></html>
    `,
    "utf8"
  );
  await fs.writeFile(path.join(cwd, "src", "routes", "docs", "+page.svelte"), "<main>Docs</main>\n", "utf8");

  const config = createDefaultConfig("searchsocket-pipeline-robust");
  config.source.mode = "static-output";
  config.source.staticOutputDir = "build";
  config.vector.turso.localPath = ".searchsocket/vectors.db";
  config.state.dir = ".searchsocket";

  return { cwd, config };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("IndexPipeline robustness", () => {
  it("throws when embeddings provider returns fewer vectors than requested", async () => {
    const { cwd, config } = await createProjectFixture();

    const pipeline = await IndexPipeline.create({
      cwd,
      config,
      embeddingsProvider: new MismatchedEmbeddingsProvider(),
      vectorStore: await createVectorStore(config, cwd)
    });

    await expect(pipeline.run({ changedOnly: true })).rejects.toThrow(/embedding/i);
  });
});
