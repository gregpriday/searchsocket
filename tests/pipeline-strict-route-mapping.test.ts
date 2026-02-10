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

async function createProjectFixture(): Promise<{ cwd: string; config: ResolvedSearchSocketConfig }> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "searchsocket-strict-routes-"));
  tempDirs.push(cwd);

  await fs.mkdir(path.join(cwd, "build", "docs", "orphan"), { recursive: true });
  await fs.mkdir(path.join(cwd, "src", "routes"), { recursive: true });

  await fs.writeFile(
    path.join(cwd, "build", "docs", "orphan", "index.html"),
    `
      <html>
        <head><title>Orphan</title></head>
        <body><main><h1>Orphan Page</h1></main></body>
      </html>
    `,
    "utf8"
  );

  // Intentionally only root route so /docs/orphan falls back to best-effort mapping.
  await fs.writeFile(path.join(cwd, "src", "routes", "+page.svelte"), "<main>Root</main>\n", "utf8");

  const config = createDefaultConfig("searchsocket-strict-routes");
  config.source.mode = "static-output";
  config.source.staticOutputDir = "build";
  config.source.strictRouteMapping = true;
  config.vector.provider = "local";
  config.vector.local.path = ".searchsocket/local-vectors.json";
  config.state.dir = ".searchsocket";

  return { cwd, config };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("IndexPipeline strict route mapping", () => {
  it("fails with a 4xx error when no exact route mapping exists", async () => {
    const { cwd, config } = await createProjectFixture();
    const pipeline = await IndexPipeline.create({
      cwd,
      config,
      embeddingsProvider: new FakeEmbeddingsProvider(),
      vectorStore: await createVectorStore(config, cwd)
    });

    await expect(pipeline.run({ changedOnly: true })).rejects.toMatchObject({
      code: "ROUTE_MAPPING_FAILED",
      status: 400
    });
  });
});
