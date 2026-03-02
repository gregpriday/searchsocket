import { afterEach, describe, expect, it, vi } from "vitest";
import { searchsocketVitePlugin } from "../src/sveltekit/plugin";
import { IndexPipeline } from "../src/indexing/pipeline";

const originalEnv = { ...process.env };

afterEach(() => {
  vi.restoreAllMocks();
  process.env = { ...originalEnv };
});

describe("searchsocketVitePlugin", () => {
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
    await plugin.closeBundle?.();

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

    await expect(plugin.closeBundle?.()).rejects.toThrow("transient failure");
    await expect(plugin.closeBundle?.()).resolves.toBeUndefined();

    expect(create).toHaveBeenCalledTimes(2);
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
    const p1 = plugin.closeBundle?.();
    const p2 = plugin.closeBundle?.();

    release();
    await Promise.all([p1, p2]);

    expect(create).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
