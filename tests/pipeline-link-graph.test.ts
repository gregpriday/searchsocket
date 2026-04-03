import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IndexPipeline } from "../src/indexing/pipeline";
import { createDefaultConfig } from "../src/config/defaults";
import type { UpstashSearchStore } from "../src/vector/upstash";
import type { PageRecord, ResolvedSearchSocketConfig } from "../src/types";

const tempDirs: string[] = [];

interface PageVectorDoc {
  id: string;
  vector: number[];
  metadata: Record<string, unknown>;
}

interface ChunkVectorDoc {
  id: string;
  vector: number[];
  metadata: Record<string, unknown>;
}

function createMockStoreWithPages(): {
  store: UpstashSearchStore;
  getPages: () => Array<{ url: string; incomingLinks: number }>;
  getChunks: () => ChunkVectorDoc[];
} {
  const pages: PageVectorDoc[] = [];
  const chunks: ChunkVectorDoc[] = [];

  const store = {
    upsertChunks: vi.fn().mockImplementation(async (records: ChunkVectorDoc[]) => {
      chunks.length = 0;
      chunks.push(...records);
    }),
    search: vi.fn().mockResolvedValue([]),
    deleteByIds: vi.fn().mockResolvedValue(undefined),
    deleteScope: vi.fn().mockResolvedValue(undefined),
    listScopes: vi.fn().mockResolvedValue([]),
    getContentHashes: vi.fn().mockResolvedValue(new Map()),
    upsertPages: vi.fn().mockImplementation(async (records: PageVectorDoc[]) => {
      pages.length = 0;
      pages.push(...records);
    }),
    getPage: vi.fn().mockResolvedValue(null),
    deletePages: vi.fn().mockResolvedValue(undefined),
    getPageHashes: vi.fn().mockResolvedValue(new Map()),
    deletePagesByIds: vi.fn().mockResolvedValue(undefined),
    health: vi.fn().mockResolvedValue({ ok: true }),
    dropAllIndexes: vi.fn().mockResolvedValue(undefined)
  } as unknown as UpstashSearchStore;

  return {
    store,
    getPages: () =>
      pages.map((p) => ({
        url: p.metadata.url as string,
        incomingLinks: p.metadata.incomingLinks as number
      })),
    getChunks: () => chunks
  };
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
  config.state.dir = ".searchsocket";

  return { cwd, config };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("IndexPipeline link graph", () => {
  it("counts incoming links from relative href targets", async () => {
    const { cwd, config } = await createProjectFixture();
    const { store, getPages } = createMockStoreWithPages();

    const pipeline = await IndexPipeline.create({
      cwd,
      config,
      store,
    });

    await pipeline.run({ changedOnly: true });

    const advancedPage = getPages().find((p) => p.url === "/docs/advanced");
    expect(advancedPage).not.toBeNull();
    expect(advancedPage!.incomingLinks).toBe(1);
  });

  it("aggregates incoming anchor text on target page chunks", async () => {
    const { cwd, config } = await createProjectFixture();
    const { store, getChunks } = createMockStoreWithPages();

    const pipeline = await IndexPipeline.create({
      cwd,
      config,
      store,
    });

    await pipeline.run({ changedOnly: true });

    // The "getting-started" page links to "advanced" with anchor text "Advanced"
    const advancedChunks = getChunks().filter(
      (c) => (c.metadata.url as string) === "/docs/advanced"
    );
    expect(advancedChunks.length).toBeGreaterThan(0);
    // The anchor text "advanced" should appear on the chunk metadata
    expect(advancedChunks[0]!.metadata.incomingAnchorText).toBe("advanced");
  });
});
