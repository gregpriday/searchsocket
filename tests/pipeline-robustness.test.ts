import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IndexPipeline } from "../src/indexing/pipeline";
import { createDefaultConfig } from "../src/config/defaults";
import type { UpstashSearchStore } from "../src/vector/upstash";
import type { ResolvedSearchSocketConfig } from "../src/types";

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
    health: vi.fn().mockResolvedValue({ ok: true }),
    dropAllIndexes: vi.fn().mockResolvedValue(undefined),
    ...overrides
  } as unknown as UpstashSearchStore;
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
  config.state.dir = ".searchsocket";

  return { cwd, config };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("IndexPipeline robustness", () => {
  it("throws when upsertChunks fails", async () => {
    const { cwd, config } = await createProjectFixture();

    const store = createMockStore({
      upsertChunks: vi.fn().mockRejectedValue(new Error("Upstash upsert failed"))
    });

    const pipeline = await IndexPipeline.create({
      cwd,
      config,
      store
    });

    await expect(pipeline.run({ changedOnly: true })).rejects.toThrow(/upsert failed/i);
  });

  it("throws when getContentHashes fails", async () => {
    const { cwd, config } = await createProjectFixture();

    const store = createMockStore({
      getContentHashes: vi.fn().mockRejectedValue(new Error("Upstash connection refused"))
    });

    const pipeline = await IndexPipeline.create({
      cwd,
      config,
      store
    });

    await expect(pipeline.run({ changedOnly: true })).rejects.toThrow(/connection refused/i);
  });

  it("completes successfully with a healthy store", async () => {
    const { cwd, config } = await createProjectFixture();

    const store = createMockStore();
    const pipeline = await IndexPipeline.create({
      cwd,
      config,
      store
    });

    const stats = await pipeline.run({ changedOnly: true });
    expect(stats.pagesProcessed).toBe(1);
    expect(stats.chunksChanged).toBeGreaterThan(0);
    expect(stats.documentsUpserted).toBeGreaterThan(0);
  });
});
