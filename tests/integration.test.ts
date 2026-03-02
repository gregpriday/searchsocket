import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IndexPipeline } from "../src/indexing/pipeline";
import { SearchEngine } from "../src/search/engine";
import { createDefaultConfig } from "../src/config/defaults";
import type { ResolvedSearchSocketConfig, Scope, VectorHit, PageRecord } from "../src/types";
import type { UpstashSearchStore } from "../src/vector/upstash";

const tempDirs: string[] = [];

function createMockStore(): {
  store: UpstashSearchStore;
  upsertedChunks: Array<{ id: string; content: Record<string, unknown>; metadata: Record<string, unknown> }>;
  upsertedPages: PageRecord[];
} {
  const upsertedChunks: Array<{ id: string; content: Record<string, unknown>; metadata: Record<string, unknown> }> = [];
  const upsertedPages: PageRecord[] = [];

  const store = {
    upsertChunks: vi.fn(async (chunks: Array<{ id: string; content: Record<string, unknown>; metadata: Record<string, unknown> }>) => {
      upsertedChunks.push(...chunks);
    }),
    search: vi.fn(async (query: string) => {
      // Simple keyword matching against upserted chunks
      const results: VectorHit[] = [];
      for (const chunk of upsertedChunks) {
        const text = String(chunk.content.text ?? "").toLowerCase();
        const title = String(chunk.content.title ?? "").toLowerCase();
        const q = query.toLowerCase();
        if (text.includes(q) || title.includes(q)) {
          results.push({
            id: chunk.id,
            score: 0.8,
            metadata: {
              projectId: String(chunk.metadata.projectId ?? ""),
              scopeName: String(chunk.metadata.scopeName ?? ""),
              url: String(chunk.content.url ?? ""),
              path: String(chunk.metadata.path ?? ""),
              title: String(chunk.content.title ?? ""),
              sectionTitle: String(chunk.content.sectionTitle ?? ""),
              headingPath: chunk.content.headingPath ? String(chunk.content.headingPath).split(" > ").filter(Boolean) : [],
              snippet: String(chunk.metadata.snippet ?? ""),
              chunkText: String(chunk.content.text ?? ""),
              ordinal: Number(chunk.metadata.ordinal ?? 0),
              contentHash: String(chunk.metadata.contentHash ?? ""),
              depth: Number(chunk.metadata.depth ?? 0),
              incomingLinks: Number(chunk.metadata.incomingLinks ?? 0),
              routeFile: String(chunk.metadata.routeFile ?? ""),
              tags: chunk.content.tags ? String(chunk.content.tags).split(",").filter(Boolean) : []
            }
          });
        }
      }
      return results;
    }),
    searchPages: vi.fn(async () => []),
    deleteByIds: vi.fn(async () => undefined),
    deleteScope: vi.fn(async () => undefined),
    listScopes: vi.fn(async () => []),
    health: vi.fn(async () => ({ ok: true })),
    getContentHashes: vi.fn(async () => new Map<string, string>()),
    upsertPages: vi.fn(async (pages: PageRecord[]) => {
      upsertedPages.push(...pages);
    }),
    getPage: vi.fn(async () => null),
    deletePages: vi.fn(async () => undefined),
    dropAllIndexes: vi.fn(async () => undefined)
  } as unknown as UpstashSearchStore;

  return { store, upsertedChunks, upsertedPages };
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
  config.state.dir = ".searchsocket";

  return { cwd, config };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("integration: index -> search", () => {
  it("indexes static output and returns routeFile in search results", async () => {
    const { cwd, config } = await createProjectFixture();
    const { store } = createMockStore();

    const pipeline = await IndexPipeline.create({
      cwd,
      config,
      store
    });

    const stats = await pipeline.run({ changedOnly: true });
    expect(stats.pagesProcessed).toBeGreaterThan(0);
    expect(stats.chunksTotal).toBeGreaterThan(0);

    const engine = await SearchEngine.create({
      cwd,
      config,
      store
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
