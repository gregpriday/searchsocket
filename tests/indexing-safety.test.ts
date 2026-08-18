import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IndexPipeline } from "../src/indexing/pipeline";
import { createDefaultConfig } from "../src/config/defaults";
import type { UpstashSearchStore } from "../src/vector/upstash";
import type { PageRecord, ResolvedSearchSocketConfig } from "../src/types";

/**
 * Release-blocking invariant: an indexing run that did not observe the
 * complete source of truth must delete nothing.
 *
 * Every case here previously deleted live records, because the pipeline
 * diffed "pages this run happened to see" against "pages in the index" and
 * treated the difference as removals.
 */

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

/** A store that remembers what was written, so run 2 sees run 1's records. */
function createStatefulMockStore() {
  const pageHashes = new Map<string, { contentHash: string; custom: boolean }>();
  const chunkIds = new Set<string>();
  const chunkHashes = new Map<string, string>();

  const store = {
    getPageHashes: vi.fn(async () => new Map(pageHashes)),
    upsertPages: vi.fn(async (docs: Array<{ id: string; metadata: { contentHash?: string; custom?: boolean } }>) => {
      for (const doc of docs) {
        pageHashes.set(doc.id, {
          contentHash: doc.metadata.contentHash ?? "",
          custom: doc.metadata.custom === true
        });
      }
    }),
    deletePagesByIds: vi.fn(async (ids: string[]) => {
      for (const id of ids) pageHashes.delete(id);
    }),
    deletePages: vi.fn(async () => pageHashes.clear()),
    scanChunkIds: vi.fn(async () => new Set(chunkIds)),
    fetchContentHashesForKeys: vi.fn(async (keys: string[]) => {
      const out = new Map<string, string>();
      for (const key of keys) {
        const hash = chunkHashes.get(key);
        if (hash !== undefined) out.set(key, hash);
      }
      return out;
    }),
    upsertChunks: vi.fn(async (docs: Array<{ id: string; metadata: { contentHash?: string } }>) => {
      for (const doc of docs) {
        chunkIds.add(doc.id);
        chunkHashes.set(doc.id, doc.metadata.contentHash ?? "");
      }
    }),
    deleteByIds: vi.fn(async (ids: string[]) => {
      for (const id of ids) {
        chunkIds.delete(id);
        chunkHashes.delete(id);
      }
    }),
    listPages: vi.fn(async (): Promise<PageRecord[]> => [])
  } as unknown as UpstashSearchStore;

  return { store, pageHashes, chunkIds };
}

async function createFixture(
  pages: Record<string, string>
): Promise<{ cwd: string; config: ResolvedSearchSocketConfig }> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "searchsocket-safety-"));
  tempDirs.push(cwd);

  for (const [pagePath, body] of Object.entries(pages)) {
    const dir = path.join(cwd, "build", pagePath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "index.html"),
      `<html><head><title>${pagePath}</title></head><body><main><h1>${pagePath}</h1><p>${body}</p></main></body></html>`,
      "utf8"
    );
  }

  const config = createDefaultConfig("searchsocket-safety");
  config.source.mode = "static-output";
  config.source.staticOutputDir = "build";
  config.state.dir = ".searchsocket";
  return { cwd, config };
}

/** Index a full site, then re-run with `options` and report what was deleted. */
async function indexThenRerun(
  fixture: Record<string, string>,
  rerun: Parameters<IndexPipeline["run"]>[0],
  mutate?: (cwd: string) => Promise<void>
) {
  const { cwd, config } = await createFixture(fixture);
  const { store } = createStatefulMockStore();

  const first = await IndexPipeline.create({ cwd, config, store });
  await first.run({ changedOnly: true });

  vi.mocked(store.deletePagesByIds).mockClear();
  vi.mocked(store.deleteByIds).mockClear();
  vi.mocked(store.upsertPages).mockClear();
  vi.mocked(store.upsertChunks).mockClear();

  if (mutate) await mutate(cwd);

  const second = await IndexPipeline.create({ cwd, config, store });
  const stats = await second.run(rerun);
  return { stats, store, cwd };
}

const THREE_PAGES = {
  "docs/alpha": "Alpha content here.",
  "docs/beta": "Beta content here.",
  "docs/gamma": "Gamma content here."
};

describe("indexing safety — incomplete runs never delete", () => {
  it("--max-pages deletes nothing", async () => {
    const { stats, store } = await indexThenRerun(THREE_PAGES, {
      changedOnly: true,
      maxPages: 1
    });

    expect(stats.deletionEligible).toBe(false);
    expect(stats.pagesDeleted).toBe(0);
    expect(store.deletePagesByIds).not.toHaveBeenCalled();
    expect(store.deleteByIds).not.toHaveBeenCalled();
    expect(stats.warnings.some((w) => w.kind === "source-limited")).toBe(true);
  });

  it("--max-chunks deletes nothing", async () => {
    const { stats, store } = await indexThenRerun(THREE_PAGES, {
      changedOnly: true,
      maxChunks: 1
    });

    expect(stats.deletionEligible).toBe(false);
    expect(store.deleteByIds).not.toHaveBeenCalled();
    expect(stats.warnings.some((w) => w.kind === "chunks-limited")).toBe(true);
  });

  it("an extraction failure deletes nothing", async () => {
    // Replace one page's body with markup that survives parsing but yields no
    // extractable text — the shape a mainSelector regression produces.
    const { stats, store } = await indexThenRerun(
      THREE_PAGES,
      { changedOnly: true },
      async (cwd) => {
        await fs.writeFile(
          path.join(cwd, "build", "docs", "beta", "index.html"),
          "<html><head><title>Beta</title></head><body><main></main></body></html>",
          "utf8"
        );
      }
    );

    expect(stats.deletionEligible).toBe(false);
    expect(stats.pagesDeleted).toBe(0);
    expect(store.deletePagesByIds).not.toHaveBeenCalled();
    expect(stats.warnings.some((w) => w.kind === "extraction-failure")).toBe(true);
  });

  it("an unexpectedly empty source deletes nothing without --allow-empty", async () => {
    const { stats, store } = await indexThenRerun(
      THREE_PAGES,
      { changedOnly: true },
      async (cwd) => {
        await fs.rm(path.join(cwd, "build"), { recursive: true, force: true });
        await fs.mkdir(path.join(cwd, "build"), { recursive: true });
      }
    );

    expect(stats.deletionEligible).toBe(false);
    expect(stats.pagesDeleted).toBe(0);
    expect(store.deletePagesByIds).not.toHaveBeenCalled();
    expect(stats.dangerousOperations.some((op) => op.startsWith("refused-empty-deletion"))).toBe(true);
  });

  it("a mass deletion is refused without --accept-large-deletion", async () => {
    // Removing 2 of 3 pages is 67%, over the 50% default ratio.
    const { stats, store } = await indexThenRerun(
      THREE_PAGES,
      { changedOnly: true },
      async (cwd) => {
        await fs.rm(path.join(cwd, "build", "docs", "beta"), { recursive: true, force: true });
        await fs.rm(path.join(cwd, "build", "docs", "gamma"), { recursive: true, force: true });
      }
    );

    expect(stats.deletionEligible).toBe(false);
    expect(stats.pagesDeleted).toBe(0);
    expect(store.deletePagesByIds).not.toHaveBeenCalled();
    expect(stats.dangerousOperations.some((op) => op.startsWith("refused-large-deletion"))).toBe(true);
  });

  it("a mass deletion proceeds with --accept-large-deletion", async () => {
    const { stats, store } = await indexThenRerun(
      THREE_PAGES,
      { changedOnly: true, acceptLargeDeletion: true },
      async (cwd) => {
        await fs.rm(path.join(cwd, "build", "docs", "beta"), { recursive: true, force: true });
        await fs.rm(path.join(cwd, "build", "docs", "gamma"), { recursive: true, force: true });
      }
    );

    expect(stats.deletionEligible).toBe(true);
    expect(stats.pagesDeleted).toBe(2);
    expect(store.deletePagesByIds).toHaveBeenCalled();
  });

  it("a complete run still deletes a genuinely removed page", async () => {
    const { stats, store } = await indexThenRerun(
      THREE_PAGES,
      { changedOnly: true },
      async (cwd) => {
        await fs.rm(path.join(cwd, "build", "docs", "beta"), { recursive: true, force: true });
      }
    );

    expect(stats.deletionEligible).toBe(true);
    expect(stats.pagesDeleted).toBe(1);
    expect(store.deletePagesByIds).toHaveBeenCalledWith(["/docs/beta"], expect.anything());
  });

  it("a noindex page is an authoritative removal, not a failure", async () => {
    const { stats, store } = await indexThenRerun(
      THREE_PAGES,
      { changedOnly: true },
      async (cwd) => {
        await fs.writeFile(
          path.join(cwd, "build", "docs", "beta", "index.html"),
          '<html><head><title>Beta</title><meta name="robots" content="noindex"></head>' +
            "<body><main><h1>Beta</h1><p>Beta content here.</p></main></body></html>",
          "utf8"
        );
      }
    );

    expect(stats.warnings).toEqual([]);
    expect(stats.deletionEligible).toBe(true);
    expect(stats.pagesDeleted).toBe(1);
  });

  it("a dry run never writes or deletes", async () => {
    const { stats, store } = await indexThenRerun(
      THREE_PAGES,
      { changedOnly: true, dryRun: true },
      async (cwd) => {
        await fs.rm(path.join(cwd, "build", "docs", "beta"), { recursive: true, force: true });
      }
    );

    expect(store.deletePagesByIds).not.toHaveBeenCalled();
    expect(store.deleteByIds).not.toHaveBeenCalled();
    expect(store.upsertPages).not.toHaveBeenCalled();
    // The plan is still reported so the operator can inspect it.
    expect(stats.pagesDeleted).toBe(1);
  });

  it("re-running an unchanged complete site is a no-op", async () => {
    const { stats, store } = await indexThenRerun(THREE_PAGES, { changedOnly: true });

    expect(stats.deletionEligible).toBe(true);
    expect(stats.pagesDeleted).toBe(0);
    expect(stats.documentsUpserted).toBe(0);
    expect(store.deletePagesByIds).not.toHaveBeenCalled();
    expect(store.deleteByIds).not.toHaveBeenCalled();
  });

  it("a beforeIndex hook that drops every chunk cannot wipe the chunk index", async () => {
    // beforeIndex defines the set of chunks the run intends to exist, so
    // dropping them all reads as "delete everything" — which is exactly what
    // the deletion-ratio guard exists to refuse.
    const { cwd, config } = await createFixture(THREE_PAGES);
    const { store } = createStatefulMockStore();

    const first = await IndexPipeline.create({ cwd, config, store });
    await first.run({ changedOnly: true });

    vi.mocked(store.deleteByIds).mockClear();
    vi.mocked(store.deletePagesByIds).mockClear();

    const second = await IndexPipeline.create({
      cwd,
      config,
      store,
      hooks: { beforeIndex: async () => [] }
    });
    const stats = await second.run({ changedOnly: false });

    expect(stats.deletionEligible).toBe(false);
    expect(store.deleteByIds).not.toHaveBeenCalled();
    expect(store.deletePagesByIds).not.toHaveBeenCalled();
    expect(stats.dangerousOperations.some((op) => op.startsWith("refused-large-deletion"))).toBe(true);
  });

  it("a beforeIndex hook that renames chunks does not delete what it just wrote", async () => {
    // The hook used to run *after* the stale set was computed, so a renamed
    // chunk was upserted and then immediately deleted as stale.
    const { cwd, config } = await createFixture(THREE_PAGES);
    const { store } = createStatefulMockStore();

    const rename = {
      beforeIndex: async (chunks: Array<{ chunkKey: string }>) =>
        chunks.map((c) => ({ ...c, chunkKey: `renamed-${c.chunkKey}` }))
    } as never;

    const first = await IndexPipeline.create({ cwd, config, store, hooks: rename });
    await first.run({ changedOnly: true });

    const written = vi.mocked(store.upsertChunks).mock.calls.flatMap((call) =>
      (call[0] as Array<{ id: string }>).map((doc) => doc.id)
    );
    const deleted = vi.mocked(store.deleteByIds).mock.calls.flatMap((call) => call[0] as string[]);

    expect(written.length).toBeGreaterThan(0);
    expect(deleted.filter((id) => written.includes(id))).toEqual([]);
  });

  it("a hook-driven rename converges on the second run", async () => {
    const { cwd, config } = await createFixture(THREE_PAGES);
    const { store, chunkIds } = createStatefulMockStore();

    const rename = {
      beforeIndex: async (chunks: Array<{ chunkKey: string }>) =>
        chunks.map((c) => ({ ...c, chunkKey: `renamed-${c.chunkKey}` }))
    } as never;

    await (await IndexPipeline.create({ cwd, config, store, hooks: rename })).run({ changedOnly: true });
    const afterFirst = new Set(chunkIds);

    vi.mocked(store.upsertChunks).mockClear();
    vi.mocked(store.deleteByIds).mockClear();

    const stats = await (await IndexPipeline.create({ cwd, config, store, hooks: rename })).run({
      changedOnly: true
    });

    // Nothing further to write or remove: the stored keys already match.
    expect(stats.documentsUpserted).toBe(0);
    expect(stats.deletes).toBe(0);
    expect(new Set(chunkIds)).toEqual(afterFirst);
  });
});

describe("mutation ordering and custom-record authority", () => {
  it("performs every upsert before any delete", async () => {
    // Page deletion used to run before chunks were written, so a chunk-write
    // failure left fresh pages, deleted old pages, and stale chunks — a state
    // no run produced deliberately.
    const { cwd, config } = await createFixture(THREE_PAGES);
    const { store } = createStatefulMockStore();

    await (await IndexPipeline.create({ cwd, config, store })).run({ changedOnly: true });
    await fs.rm(path.join(cwd, "build", "docs", "beta"), { recursive: true, force: true });

    const order: string[] = [];
    for (const name of ["upsertPages", "upsertChunks", "deletePagesByIds", "deleteByIds"] as const) {
      vi.mocked(store[name]).mockClear();
      vi.mocked(store[name]).mockImplementation(async () => {
        order.push(name);
      });
    }

    await (await IndexPipeline.create({ cwd, config, store })).run({ changedOnly: true });

    const firstDelete = order.findIndex((op) => op.startsWith("delete"));
    const lastUpsert = order.map((op) => op.startsWith("upsert")).lastIndexOf(true);

    expect(firstDelete).toBeGreaterThan(-1);
    expect(lastUpsert).toBeLessThan(firstDelete);
  });

  it("does not delete custom records when the run supplies none", async () => {
    // Custom records share the page namespace, so a site-only run saw them as
    // absent and deleted them — taking a provider's content with it whenever
    // that provider merely failed to run.
    const { cwd, config } = await createFixture(THREE_PAGES);
    const { store, pageHashes } = createStatefulMockStore();

    await (await IndexPipeline.create({ cwd, config, store })).run({
      changedOnly: true,
      customRecords: [
        { url: "/from-cms/post", title: "CMS post", content: "Body text from the CMS." }
      ]
    });
    expect(pageHashes.has("/from-cms/post")).toBe(true);

    vi.mocked(store.deletePagesByIds).mockClear();

    // A later run that says nothing about custom records.
    const stats = await (await IndexPipeline.create({ cwd, config, store })).run({
      changedOnly: true
    });

    expect(stats.pagesDeleted).toBe(0);
    expect(store.deletePagesByIds).not.toHaveBeenCalled();
    expect(pageHashes.has("/from-cms/post")).toBe(true);
  });

  it("deletes a custom record when the run explicitly supplies an empty set", async () => {
    const { cwd, config } = await createFixture(THREE_PAGES);
    const { store, pageHashes } = createStatefulMockStore();

    await (await IndexPipeline.create({ cwd, config, store })).run({
      changedOnly: true,
      customRecords: [
        { url: "/from-cms/post", title: "CMS post", content: "Body text from the CMS." }
      ]
    });

    // `customRecords: []` is an explicit assertion that there are none.
    const stats = await (await IndexPipeline.create({ cwd, config, store })).run({
      changedOnly: true,
      customRecords: []
    });

    expect(stats.pagesDeleted).toBe(1);
    expect(pageHashes.has("/from-cms/post")).toBe(false);
  });

  it("carries a custom record's metadata into the index", async () => {
    // CustomRecord.metadata was documented and demonstrated but discarded, so
    // a caller could set it and never filter on it.
    const { cwd, config } = await createFixture(THREE_PAGES);
    const { store } = createStatefulMockStore();

    await (await IndexPipeline.create({ cwd, config, store })).run({
      changedOnly: true,
      customRecords: [
        {
          url: "/from-cms/post",
          title: "CMS post",
          content: "Body text from the CMS.",
          metadata: { source: "cms" }
        }
      ]
    });

    const written = vi.mocked(store.upsertPages).mock.calls
      .flatMap((call) => call[0] as Array<{ id: string; metadata: Record<string, unknown> }>)
      .find((doc) => doc.id === "/from-cms/post");

    expect(written?.metadata.meta).toEqual({ source: "cms" });
    expect(written?.metadata.custom).toBe(true);
  });
});
