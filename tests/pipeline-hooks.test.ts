import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IndexPipeline } from "../src/indexing/pipeline";
import { createDefaultConfig } from "../src/config/defaults";
import type { UpstashSearchStore } from "../src/vector/upstash";
import type { ResolvedSearchSocketConfig, ExtractedPage, Chunk, IndexStats } from "../src/types";

const tempDirs: string[] = [];

function createMockStore(overrides: Partial<Record<keyof UpstashSearchStore, unknown>> = {}): UpstashSearchStore {
  return {
    upsertChunks: vi.fn().mockResolvedValue(undefined),
    search: vi.fn().mockResolvedValue([]),
    deleteByIds: vi.fn().mockResolvedValue(undefined),
    deleteScope: vi.fn().mockResolvedValue(undefined),
    listScopes: vi.fn().mockResolvedValue([]),
    getContentHashes: vi.fn().mockResolvedValue(new Map()),
    upsertPages: vi.fn().mockResolvedValue(undefined),
    getPage: vi.fn().mockResolvedValue(null),
    deletePages: vi.fn().mockResolvedValue(undefined),
    getPageHashes: vi.fn().mockResolvedValue(new Map()),
    deletePagesByIds: vi.fn().mockResolvedValue(undefined),
    health: vi.fn().mockResolvedValue({ ok: true }),
    dropAllIndexes: vi.fn().mockResolvedValue(undefined),
    ...overrides
  } as unknown as UpstashSearchStore;
}

async function createProjectFixture(): Promise<{ cwd: string; config: ResolvedSearchSocketConfig }> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "searchsocket-hooks-"));
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

  const config = createDefaultConfig("searchsocket-hooks-test");
  config.source.mode = "static-output";
  config.source.staticOutputDir = "build";
  config.state.dir = ".searchsocket";

  return { cwd, config };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("IndexPipeline hooks", () => {
  describe("transformPage", () => {
    it("modifies extracted pages", async () => {
      const { cwd, config } = await createProjectFixture();
      const store = createMockStore();

      const transformPage = vi.fn((page: ExtractedPage) => ({
        ...page,
        title: "Modified Title"
      }));

      const pipeline = await IndexPipeline.create({
        cwd,
        config,
        store,
        hooks: { transformPage }
      });

      const stats = await pipeline.run({ changedOnly: true });

      expect(transformPage).toHaveBeenCalledTimes(1);
      expect(stats.pagesProcessed).toBe(1);

      const upsertCall = (store.upsertChunks as ReturnType<typeof vi.fn>).mock.calls[0]!;
      const docs = upsertCall[0] as Array<{ metadata: { title: string } }>;
      expect(docs[0]!.metadata.title).toBe("Modified Title");
    });

    it("skips pages when returning null", async () => {
      const { cwd, config } = await createProjectFixture();
      const store = createMockStore();

      const pipeline = await IndexPipeline.create({
        cwd,
        config,
        store,
        hooks: { transformPage: () => null }
      });

      const stats = await pipeline.run({ changedOnly: true });

      expect(stats.pagesProcessed).toBe(0);
      expect(stats.chunksTotal).toBe(0);
      expect(stats.documentsUpserted).toBe(0);
    });

    it("works with async hooks", async () => {
      const { cwd, config } = await createProjectFixture();
      const store = createMockStore();

      const pipeline = await IndexPipeline.create({
        cwd,
        config,
        store,
        hooks: {
          transformPage: async (page) => {
            await new Promise((r) => setTimeout(r, 1));
            return { ...page, title: "Async Title" };
          }
        }
      });

      const stats = await pipeline.run({ changedOnly: true });
      expect(stats.pagesProcessed).toBe(1);
    });

    it("propagates errors from the hook", async () => {
      const { cwd, config } = await createProjectFixture();
      const store = createMockStore();

      const pipeline = await IndexPipeline.create({
        cwd,
        config,
        store,
        hooks: {
          transformPage: () => {
            throw new Error("transformPage hook error");
          }
        }
      });

      await expect(pipeline.run({ changedOnly: true })).rejects.toThrow("transformPage hook error");
    });
  });

  describe("transformChunk", () => {
    it("modifies chunks", async () => {
      const { cwd, config } = await createProjectFixture();
      const store = createMockStore();

      const transformChunk = vi.fn((chunk: Chunk) => ({
        ...chunk,
        chunkText: "modified chunk text"
      }));

      const pipeline = await IndexPipeline.create({
        cwd,
        config,
        store,
        hooks: { transformChunk }
      });

      const stats = await pipeline.run({ changedOnly: true });

      expect(transformChunk).toHaveBeenCalled();
      expect(stats.documentsUpserted).toBeGreaterThan(0);
    });

    it("filters out chunks when returning null", async () => {
      const { cwd, config } = await createProjectFixture();
      const store = createMockStore();

      const pipeline = await IndexPipeline.create({
        cwd,
        config,
        store,
        hooks: { transformChunk: () => null }
      });

      const stats = await pipeline.run({ changedOnly: true });

      expect(stats.chunksTotal).toBe(0);
      expect(stats.documentsUpserted).toBe(0);
    });
  });

  describe("beforeIndex", () => {
    it("receives changed chunks and can modify them", async () => {
      const { cwd, config } = await createProjectFixture();
      const store = createMockStore();

      const beforeIndex = vi.fn((chunks: Chunk[]) => chunks);

      const pipeline = await IndexPipeline.create({
        cwd,
        config,
        store,
        hooks: { beforeIndex }
      });

      await pipeline.run({ changedOnly: true });

      expect(beforeIndex).toHaveBeenCalledTimes(1);
      const receivedChunks = beforeIndex.mock.calls[0]![0] as Chunk[];
      expect(receivedChunks.length).toBeGreaterThan(0);
    });

    it("can filter out all chunks by returning empty array", async () => {
      const { cwd, config } = await createProjectFixture();
      const store = createMockStore();

      const pipeline = await IndexPipeline.create({
        cwd,
        config,
        store,
        hooks: { beforeIndex: () => [] }
      });

      const stats = await pipeline.run({ changedOnly: true });

      expect(stats.documentsUpserted).toBe(0);
    });
  });

  describe("afterIndex", () => {
    it("is called with final stats", async () => {
      const { cwd, config } = await createProjectFixture();
      const store = createMockStore();

      const afterIndex = vi.fn();

      const pipeline = await IndexPipeline.create({
        cwd,
        config,
        store,
        hooks: { afterIndex }
      });

      const stats = await pipeline.run({ changedOnly: true });

      expect(afterIndex).toHaveBeenCalledTimes(1);
      const receivedStats = afterIndex.mock.calls[0]![0] as IndexStats;
      expect(receivedStats.pagesProcessed).toBe(stats.pagesProcessed);
      expect(receivedStats.documentsUpserted).toBe(stats.documentsUpserted);
    });

    it("propagates errors", async () => {
      const { cwd, config } = await createProjectFixture();
      const store = createMockStore();

      const pipeline = await IndexPipeline.create({
        cwd,
        config,
        store,
        hooks: {
          afterIndex: async () => {
            throw new Error("afterIndex hook error");
          }
        }
      });

      await expect(pipeline.run({ changedOnly: true })).rejects.toThrow("afterIndex hook error");
    });
  });

  describe("no hooks", () => {
    it("runs identically without hooks", async () => {
      const { cwd, config } = await createProjectFixture();
      const store = createMockStore();

      const pipeline = await IndexPipeline.create({
        cwd,
        config,
        store,
      });

      const stats = await pipeline.run({ changedOnly: true });

      expect(stats.pagesProcessed).toBe(1);
      expect(stats.chunksTotal).toBeGreaterThan(0);
      expect(stats.documentsUpserted).toBeGreaterThan(0);
    });
  });
});
