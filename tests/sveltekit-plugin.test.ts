import { afterEach, describe, expect, it, vi } from "vitest";
import { searchsocketVitePlugin } from "../src/sveltekit/plugin";
import { IndexPipeline } from "../src/indexing/pipeline";

const originalEnv = { ...process.env };

afterEach(() => {
  vi.restoreAllMocks();
  process.env = { ...originalEnv };
});

type Plugin = ReturnType<typeof searchsocketVitePlugin>;
type HookContext = {
  environment?: {
    name?: string;
    config?: { build?: { ssr?: unknown } };
  };
};

const SSR_CONTEXT: HookContext = { environment: { name: "ssr" } };

/**
 * Invoke `closeBundle` the way Rollup does: an object hook whose `handler` is
 * called with a hook context. Defaults to the SSR pass, the only pass the
 * plugin acts on.
 */
function closeBundle(plugin: Plugin, ctx: HookContext = SSR_CONTEXT): Promise<void> {
  return Promise.resolve(plugin.closeBundle?.handler.call(ctx));
}

describe("searchsocketVitePlugin", () => {
  it("declares closeBundle as a sequential post hook", () => {
    // Load-bearing: without these the hook races the SvelteKit adapter and can
    // fire before the adapter has written its build output.
    const plugin = searchsocketVitePlugin({ cwd: process.cwd(), verbose: false });

    expect(plugin.closeBundle?.sequential).toBe(true);
    expect(plugin.closeBundle?.order).toBe("post");
  });

  it("runs indexing when explicitly triggered by env var", async () => {
    process.env.SEARCHSOCKET_AUTO_INDEX = "true";

    const run = vi.fn().mockResolvedValue({
      pagesProcessed: 1,
      chunksTotal: 1,
      chunksChanged: 1,
      documentsUpserted: 1,
      deletes: 0,
      routeExact: 1,
      routeBestEffort: 0,
      stageTimingsMs: {}
    });

    vi.spyOn(IndexPipeline, "create").mockResolvedValue({
      run
    } as unknown as IndexPipeline);

    const plugin = searchsocketVitePlugin({ cwd: process.cwd(), verbose: false });
    await closeBundle(plugin);

    expect(IndexPipeline.create).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("retries on subsequent closeBundle calls if a previous run failed", async () => {
    process.env.SEARCHSOCKET_AUTO_INDEX = "true";

    const create = vi
      .spyOn(IndexPipeline, "create")
      .mockRejectedValueOnce(new Error("transient failure"))
      .mockResolvedValueOnce({
        run: vi.fn().mockResolvedValue({
          pagesProcessed: 1,
          chunksTotal: 1,
          chunksChanged: 1,
          documentsUpserted: 1,
          deletes: 0,
          routeExact: 1,
          routeBestEffort: 0,
          stageTimingsMs: {}
        })
      } as unknown as IndexPipeline);

    const plugin = searchsocketVitePlugin({ cwd: process.cwd(), verbose: false });

    await expect(closeBundle(plugin)).rejects.toThrow("transient failure");
    await expect(closeBundle(plugin)).resolves.toBeUndefined();

    expect(create).toHaveBeenCalledTimes(2);
  });

  it("does not trigger indexing when only CI=true is set", async () => {
    process.env.CI = "true";
    delete process.env.SEARCHSOCKET_AUTO_INDEX;

    vi.spyOn(IndexPipeline, "create").mockResolvedValue({
      run: vi.fn()
    } as unknown as IndexPipeline);

    const plugin = searchsocketVitePlugin({ cwd: process.cwd(), verbose: false });
    await closeBundle(plugin);

    expect(IndexPipeline.create).not.toHaveBeenCalled();
  });

  it("skips the client pass and only indexes on the SSR pass", async () => {
    process.env.SEARCHSOCKET_AUTO_INDEX = "true";

    const create = vi.spyOn(IndexPipeline, "create").mockResolvedValue({
      run: vi.fn().mockResolvedValue({
        pagesProcessed: 1,
        chunksTotal: 1,
        chunksChanged: 1,
        documentsUpserted: 1,
        deletes: 0,
        routeExact: 1,
        routeBestEffort: 0,
        stageTimingsMs: {}
      })
    } as unknown as IndexPipeline);

    const plugin = searchsocketVitePlugin({ cwd: process.cwd(), verbose: false });

    // SvelteKit runs its adapter only on the SSR pass; on the client pass the
    // build output doesn't exist yet.
    await closeBundle(plugin, { environment: { name: "client" } });
    expect(create).not.toHaveBeenCalled();

    await closeBundle(plugin, { environment: { name: "ssr" } });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("falls back to the configResolved ssr flag when environment is unavailable", async () => {
    process.env.SEARCHSOCKET_AUTO_INDEX = "true";

    const create = vi.spyOn(IndexPipeline, "create").mockResolvedValue({
      run: vi.fn().mockResolvedValue({
        pagesProcessed: 1,
        chunksTotal: 1,
        chunksChanged: 1,
        documentsUpserted: 1,
        deletes: 0,
        routeExact: 1,
        routeBestEffort: 0,
        stageTimingsMs: {}
      })
    } as unknown as IndexPipeline);

    // Vite <6 has no `this.environment`, so the plugin relies on the ssr flag
    // captured during configResolved.
    const plugin = searchsocketVitePlugin({ cwd: process.cwd(), verbose: false });
    plugin.configResolved?.({ build: { ssr: true } });

    await closeBundle(plugin, {});

    expect(create).toHaveBeenCalledTimes(1);
  });

  it("does not start duplicate indexing runs when closeBundle is invoked concurrently", async () => {
    process.env.SEARCHSOCKET_AUTO_INDEX = "true";

    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = vi.fn().mockReturnValue(
      gate.then(() => ({
        pagesProcessed: 1,
        chunksTotal: 1,
        chunksChanged: 1,
        documentsUpserted: 1,
        deletes: 0,
        routeExact: 1,
        routeBestEffort: 0,
        stageTimingsMs: {}
      }))
    );

    const create = vi.spyOn(IndexPipeline, "create").mockResolvedValue({
      run
    } as unknown as IndexPipeline);

    const plugin = searchsocketVitePlugin({ cwd: process.cwd(), verbose: false });
    const p1 = closeBundle(plugin);
    const p2 = closeBundle(plugin);

    release();
    await Promise.all([p1, p2]);

    expect(create).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
