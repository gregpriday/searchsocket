import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { IndexPipeline } from "../src/indexing/pipeline";
import { SearchEngine } from "../src/search/engine";
import { createDefaultConfig } from "../src/config/defaults";
import { createVectorStore } from "../src/vector";
import type { EmbeddingsProvider, ResolvedSearchSocketConfig } from "../src/types";

const tempDirs: string[] = [];

class FakeEmbeddingsProvider implements EmbeddingsProvider {
  estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  async embedTexts(texts: string[]): Promise<number[][]> {
    return texts.map((text) => this.embed(text));
  }

  private embed(text: string): number[] {
    const dim = 32;
    const vector = new Array<number>(dim).fill(0);

    for (const token of text.toLowerCase().split(/[^a-z0-9]+/g).filter(Boolean)) {
      let hash = 0;
      for (let i = 0; i < token.length; i += 1) {
        hash = (hash * 31 + token.charCodeAt(i)) >>> 0;
      }
      const index = hash % dim;
      vector[index] = (vector[index] ?? 0) + 1;
    }

    return vector;
  }
}

async function createProjectFixture(): Promise<{ cwd: string; config: ResolvedSearchSocketConfig }> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "searchsocket-int-"));
  tempDirs.push(cwd);

  await fs.mkdir(path.join(cwd, "build", "docs", "getting-started"), { recursive: true });
  await fs.mkdir(path.join(cwd, "src", "routes", "docs", "getting-started"), { recursive: true });

  await fs.writeFile(
    path.join(cwd, "build", "index.html"),
    `
      <html><head><title>Home</title></head>
      <body><main><h1>Home</h1><p>Welcome page.</p></main></body></html>
    `,
    "utf8"
  );

  await fs.writeFile(
    path.join(cwd, "build", "docs", "getting-started", "index.html"),
    `
      <html><head><title>Getting Started</title></head>
      <body>
        <main>
          <h1>Getting Started</h1>
          <p>The orbitengine token appears only on this page.</p>
          <h2>Installation</h2>
          <p>Install with pnpm add searchsocket.</p>
        </main>
      </body></html>
    `,
    "utf8"
  );

  await fs.writeFile(path.join(cwd, "src", "routes", "+page.svelte"), "<main>Home</main>\n", "utf8");
  await fs.writeFile(
    path.join(cwd, "src", "routes", "docs", "getting-started", "+page.svelte"),
    "<main>Docs</main>\n",
    "utf8"
  );

  const config = createDefaultConfig("searchsocket-int");
  config.source.mode = "static-output";
  config.source.staticOutputDir = "build";
  config.vector.provider = "local";
  config.vector.local.path = ".searchsocket/local-vectors.json";
  config.state.dir = ".searchsocket";

  return { cwd, config };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("integration: index -> search", () => {
  it("indexes static output and returns routeFile in search results", async () => {
    const { cwd, config } = await createProjectFixture();
    const embeddings = new FakeEmbeddingsProvider();

    const pipeline = await IndexPipeline.create({
      cwd,
      config,
      embeddingsProvider: embeddings,
      vectorStore: await createVectorStore(config, cwd)
    });

    const stats = await pipeline.run({ changedOnly: true });
    expect(stats.pagesProcessed).toBeGreaterThan(0);
    expect(stats.chunksTotal).toBeGreaterThan(0);

    const engine = await SearchEngine.create({
      cwd,
      config,
      embeddingsProvider: embeddings,
      vectorStore: await createVectorStore(config, cwd)
    });

    const result = await engine.search({
      q: "orbitengine",
      topK: 3,
      pathPrefix: "/docs"
    });

    expect(result.results.length).toBeGreaterThan(0);
    expect(result.results[0]?.url).toBe("/docs/getting-started");
    expect(result.results[0]?.routeFile).toBe("src/routes/docs/getting-started/+page.svelte");
  });
});
