import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SearchEngine } from "../src/search/engine";
import { createDefaultConfig } from "../src/config/defaults";
import type { EmbeddingsProvider, VectorHit, VectorStore } from "../src/types";

const tempDirs: string[] = [];

class FakeEmbeddings implements EmbeddingsProvider {
  estimateTokens(text: string): number {
    return text.length;
  }

  async embedTexts(): Promise<number[][]> {
    return [[1, 0, 0]];
  }
}

class FakeStore implements VectorStore {
  constructor(private readonly hits: VectorHit[] = []) {}

  async upsert(): Promise<void> {
    return;
  }

  async query(): Promise<VectorHit[]> {
    return this.hits;
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
}

function makeHit(id: string, url: string): VectorHit {
  return {
    id,
    score: 0.8,
    metadata: {
      projectId: "searchsocket-engine-test",
      scopeName: "main",
      url,
      path: url,
      title: "Title",
      sectionTitle: "",
      headingPath: [],
      snippet: "Snippet",
      contentHash: `hash-${id}`,
      modelId: "text-embedding-3-small",
      depth: 1,
      incomingLinks: 0,
      routeFile: "src/routes/+page.svelte",
      tags: []
    }
  };
}

async function makeTempCwd(): Promise<string> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "searchsocket-engine-"));
  tempDirs.push(cwd);
  return cwd;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("SearchEngine - adversarial cases", () => {
  it("rejects invalid requests with empty query", async () => {
    const cwd = await makeTempCwd();
    const config = createDefaultConfig("searchsocket-engine-test");

    const engine = await SearchEngine.create({
      cwd,
      config,
      embeddingsProvider: new FakeEmbeddings(),
      vectorStore: new FakeStore()
    });

    await expect(engine.search({ q: "   " })).rejects.toMatchObject({
      code: "INVALID_REQUEST",
      status: 400
    });
  });

  it("rejects invalid topK values outside schema bounds", async () => {
    const cwd = await makeTempCwd();
    const config = createDefaultConfig("searchsocket-engine-test");

    const engine = await SearchEngine.create({
      cwd,
      config,
      embeddingsProvider: new FakeEmbeddings(),
      vectorStore: new FakeStore()
    });

    await expect(engine.search({ q: "test", topK: 0 })).rejects.toMatchObject({
      code: "INVALID_REQUEST",
      status: 400
    });
    await expect(engine.search({ q: "test", topK: 101 })).rejects.toMatchObject({
      code: "INVALID_REQUEST",
      status: 400
    });
  });

  it("rejects rerank=true when rerank provider is disabled", async () => {
    const cwd = await makeTempCwd();
    const config = createDefaultConfig("searchsocket-engine-test");
    config.rerank.provider = "none";

    const engine = await SearchEngine.create({
      cwd,
      config,
      embeddingsProvider: new FakeEmbeddings(),
      vectorStore: new FakeStore([makeHit("a", "/a")])
    });

    await expect(engine.search({ q: "test", rerank: true })).rejects.toMatchObject({
      code: "INVALID_REQUEST",
      status: 400
    });
  });

  it("rejects rerank=true when jina is configured but API key is missing", async () => {
    const cwd = await makeTempCwd();
    const config = createDefaultConfig("searchsocket-engine-test");
    config.rerank.provider = "jina";
    config.rerank.jina.apiKeyEnv = "SEARCHSOCKET_TEST_MISSING_JINA_KEY";
    delete process.env.SEARCHSOCKET_TEST_MISSING_JINA_KEY;

    const engine = await SearchEngine.create({
      cwd,
      config,
      embeddingsProvider: new FakeEmbeddings(),
      vectorStore: new FakeStore([makeHit("a", "/a")])
    });

    await expect(engine.search({ q: "test", rerank: true })).rejects.toMatchObject({
      code: "CONFIG_MISSING",
      status: 400
    });
  });

  it("normalizes full URLs when loading indexed pages", async () => {
    const cwd = await makeTempCwd();
    const config = createDefaultConfig("searchsocket-engine-test");
    const pagePath = path.join(cwd, ".searchsocket", "pages", "main", "docs", "getting-started.md");

    await fs.mkdir(path.dirname(pagePath), { recursive: true });
    await fs.writeFile(
      pagePath,
      `---
url: "/docs/getting-started"
title: "Getting Started"
routeFile: "src/routes/docs/getting-started/+page.svelte"
---

## Install

Run pnpm add searchsocket.
`,
      "utf8"
    );

    const engine = await SearchEngine.create({
      cwd,
      config,
      embeddingsProvider: new FakeEmbeddings(),
      vectorStore: new FakeStore()
    });

    const page = await engine.getPage("https://example.com/docs/getting-started?ref=nav#install");

    expect(page.url).toBe("/docs/getting-started");
    expect(page.frontmatter.title).toBe("Getting Started");
    expect(page.markdown).toContain("Run pnpm add searchsocket.");
  });

  it("normalizes query/hash suffixes for path-style getPage inputs", async () => {
    const cwd = await makeTempCwd();
    const config = createDefaultConfig("searchsocket-engine-test");
    const pagePath = path.join(cwd, ".searchsocket", "pages", "main", "docs", "faq.md");

    await fs.mkdir(path.dirname(pagePath), { recursive: true });
    await fs.writeFile(
      pagePath,
      `---
url: "/docs/faq"
title: "FAQ"
routeFile: "src/routes/docs/faq/+page.svelte"
---

Frequently asked questions.
`,
      "utf8"
    );

    const engine = await SearchEngine.create({
      cwd,
      config,
      embeddingsProvider: new FakeEmbeddings(),
      vectorStore: new FakeStore()
    });

    const page = await engine.getPage("/docs/faq?ref=nav#pricing");
    expect(page.url).toBe("/docs/faq");
    expect(page.frontmatter.title).toBe("FAQ");
  });

  it("returns 404 when requested indexed page does not exist", async () => {
    const cwd = await makeTempCwd();
    const config = createDefaultConfig("searchsocket-engine-test");

    const engine = await SearchEngine.create({
      cwd,
      config,
      embeddingsProvider: new FakeEmbeddings(),
      vectorStore: new FakeStore()
    });

    await expect(engine.getPage("/missing")).rejects.toMatchObject({
      code: "INVALID_REQUEST",
      status: 404
    });
  });

  it("fails fast when manifest model does not match active embedding model", async () => {
    const cwd = await makeTempCwd();
    const config = createDefaultConfig("searchsocket-engine-test");
    const stateDir = path.join(cwd, config.state.dir);
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(
      path.join(stateDir, "manifest.json"),
      JSON.stringify(
        {
          version: 1,
          scopes: {
            main: {
              projectId: config.project.id,
              scopeName: "main",
              embeddingModel: "text-embedding-3-large",
              chunks: {}
            }
          }
        },
        null,
        2
      ),
      "utf8"
    );

    const engine = await SearchEngine.create({
      cwd,
      config,
      embeddingsProvider: new FakeEmbeddings(),
      vectorStore: new FakeStore()
    });

    await expect(engine.search({ q: "test" })).rejects.toMatchObject({
      code: "EMBEDDING_MODEL_MISMATCH"
    });
  });

  it("rejects empty embedding vectors instead of querying the backend with invalid data", async () => {
    const cwd = await makeTempCwd();
    const config = createDefaultConfig("searchsocket-engine-test");

    const query = vi.fn().mockResolvedValue([]);
    const store: VectorStore = {
      upsert: async () => undefined,
      query,
      deleteByIds: async () => undefined,
      deleteScope: async () => undefined,
      listScopes: async () => [],
      recordScope: async () => undefined,
      health: async () => ({ ok: true })
    };

    const embeddings: EmbeddingsProvider = {
      estimateTokens: (text) => text.length,
      embedTexts: async () => [[]]
    };

    const engine = await SearchEngine.create({
      cwd,
      config,
      embeddingsProvider: embeddings,
      vectorStore: store
    });

    await expect(engine.search({ q: "test" })).rejects.toMatchObject({
      code: "VECTOR_BACKEND_UNAVAILABLE"
    });
    expect(query).not.toHaveBeenCalled();
  });
});
