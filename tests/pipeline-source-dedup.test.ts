import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IndexPipeline } from "../src/indexing/pipeline";
import { createDefaultConfig } from "../src/config/defaults";
import type { UpstashSearchStore } from "../src/vector/upstash";
import type { ResolvedSearchSocketConfig } from "../src/types";

const tempDirs: string[] = [];

function createMockStore(): UpstashSearchStore {
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
    dropAllIndexes: vi.fn().mockResolvedValue(undefined)
  } as unknown as UpstashSearchStore;
}

async function createFixture(): Promise<{ cwd: string; config: ResolvedSearchSocketConfig }> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "searchsocket-pipeline-dedup-"));
  tempDirs.push(cwd);

  await fs.mkdir(path.join(cwd, "build", "docs"), { recursive: true });
  await fs.mkdir(path.join(cwd, "src", "routes", "docs"), { recursive: true });

  // Both files resolve to /docs and should be deduplicated by canonical URL.
  await fs.writeFile(
    path.join(cwd, "build", "docs.html"),
    `<html><head><title>Docs A</title></head><body><main><h1>Docs</h1><p>A</p></main></body></html>`,
    "utf8"
  );
  await fs.writeFile(
    path.join(cwd, "build", "docs", "index.html"),
    `<html><head><title>Docs B</title></head><body><main><h1>Docs</h1><p>B</p></main></body></html>`,
    "utf8"
  );
  await fs.writeFile(path.join(cwd, "src", "routes", "docs", "+page.svelte"), "<main>Docs</main>\n", "utf8");

  const config = createDefaultConfig("searchsocket-pipeline-dedup");
  config.source.mode = "static-output";
  config.source.staticOutputDir = "build";
  config.state.dir = ".searchsocket";

  return { cwd, config };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("IndexPipeline source URL deduplication", () => {
  it("deduplicates pages that resolve to the same canonical URL", async () => {
    const { cwd, config } = await createFixture();
    const pipeline = await IndexPipeline.create({
      cwd,
      config,
      store: createMockStore()
    });

    const stats = await pipeline.run({ changedOnly: true, dryRun: true });
    expect(stats.pagesProcessed).toBe(1);
    expect(stats.chunksTotal).toBe(2); // 1 summary + 1 regular
    expect(stats.chunksChanged).toBe(2);
  });
});
