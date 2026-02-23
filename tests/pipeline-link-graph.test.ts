import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import matter from "gray-matter";
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
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "searchsocket-links-"));
  tempDirs.push(cwd);

  await fs.mkdir(path.join(cwd, "build", "docs", "getting-started"), { recursive: true });
  await fs.mkdir(path.join(cwd, "build", "docs", "advanced"), { recursive: true });
  await fs.mkdir(path.join(cwd, "src", "routes", "docs", "getting-started"), { recursive: true });
  await fs.mkdir(path.join(cwd, "src", "routes", "docs", "advanced"), { recursive: true });

  await fs.writeFile(
    path.join(cwd, "build", "docs", "getting-started", "index.html"),
    `
      <html>
        <head><title>Getting Started</title></head>
        <body>
          <main>
            <h1>Getting Started</h1>
            <a href="advanced">Advanced</a>
          </main>
        </body>
      </html>
    `,
    "utf8"
  );

  await fs.writeFile(
    path.join(cwd, "build", "docs", "advanced", "index.html"),
    `
      <html>
        <head><title>Advanced</title></head>
        <body>
          <main><h1>Advanced</h1></main>
        </body>
      </html>
    `,
    "utf8"
  );

  await fs.writeFile(
    path.join(cwd, "src", "routes", "docs", "getting-started", "+page.svelte"),
    "<main>Docs</main>\n",
    "utf8"
  );
  await fs.writeFile(
    path.join(cwd, "src", "routes", "docs", "advanced", "+page.svelte"),
    "<main>Advanced</main>\n",
    "utf8"
  );

  const config = createDefaultConfig("searchsocket-links");
  config.source.mode = "static-output";
  config.source.staticOutputDir = "build";
  config.vector.turso.localPath = ".searchsocket/vectors.db";
  config.state.dir = ".searchsocket";

  return { cwd, config };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("IndexPipeline link graph", () => {
  it("counts incoming links from relative href targets", async () => {
    const { cwd, config } = await createProjectFixture();
    const embeddings = new FakeEmbeddingsProvider();

    const pipeline = await IndexPipeline.create({
      cwd,
      config,
      embeddingsProvider: embeddings,
      vectorStore: await createVectorStore(config, cwd)
    });

    await pipeline.run({ changedOnly: true });

    const advancedMirror = path.join(cwd, ".searchsocket", "pages", "main", "docs", "advanced.md");
    const raw = await fs.readFile(advancedMirror, "utf8");
    const parsed = matter(raw);

    expect(parsed.data.incomingLinks).toBe(1);
  });
});
