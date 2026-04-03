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
    getPageHashes: vi.fn().mockResolvedValue(new Map()),
    deletePagesByIds: vi.fn().mockResolvedValue(undefined),
    health: vi.fn().mockResolvedValue({ ok: true }),
    dropAllIndexes: vi.fn().mockResolvedValue(undefined),
    ...overrides
  } as unknown as UpstashSearchStore;
}

async function createComponentFixture(): Promise<{ cwd: string; config: ResolvedSearchSocketConfig }> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "searchsocket-pipeline-tags-"));
  tempDirs.push(cwd);

  await fs.mkdir(path.join(cwd, "src", "lib", "components"), { recursive: true });
  await fs.mkdir(path.join(cwd, "src", "routes"), { recursive: true });

  await fs.writeFile(
    path.join(cwd, "src", "lib", "components", "Button.svelte"),
    `<!-- @component A reusable button component. -->
<script lang="ts">
  let { label, variant = 'primary' }: { label: string; variant: string } = $props();
</script>
<button class={variant}>{label}</button>`,
    "utf8"
  );

  // Route file for route pattern resolution
  await fs.writeFile(
    path.join(cwd, "src", "routes", "+page.svelte"),
    "<main>Home</main>",
    "utf8"
  );

  const config = createDefaultConfig("searchsocket-pipeline-tags");
  config.source.mode = "content-files";
  config.source.contentFiles = {
    globs: ["src/lib/components/**/*.svelte"],
    baseDir: cwd
  };
  config.state.dir = ".searchsocket";

  return { cwd, config };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("Pipeline tags forwarding", () => {
  it("forwards source-level 'component' tag through to upserted chunks", async () => {
    const { cwd, config } = await createComponentFixture();
    const upsertChunks = vi.fn().mockResolvedValue(undefined);
    const store = createMockStore({ upsertChunks });

    const pipeline = await IndexPipeline.create({ cwd, config, store });
    await pipeline.run({ force: true });

    expect(upsertChunks).toHaveBeenCalled();
    const docs = upsertChunks.mock.calls[0]![0] as Array<{ metadata: { tags: string[] } }>;
    expect(docs.length).toBeGreaterThan(0);

    // Tags are stored as string[] in chunk metadata
    for (const doc of docs) {
      expect(doc.metadata.tags).toContain("component");
    }
  });

  it("forwards source-level 'component' tag through to page records", async () => {
    const { cwd, config } = await createComponentFixture();
    const upsertPages = vi.fn().mockResolvedValue(undefined);
    const store = createMockStore({ upsertPages });

    const pipeline = await IndexPipeline.create({ cwd, config, store });
    await pipeline.run({ force: true });

    expect(upsertPages).toHaveBeenCalled();
    const pages = upsertPages.mock.calls[0]![0] as Array<{ metadata: { tags: string[] } }>;
    expect(pages.length).toBeGreaterThan(0);

    for (const page of pages) {
      expect(page.metadata.tags).toContain("component");
    }
  });
});
