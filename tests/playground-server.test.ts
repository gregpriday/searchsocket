import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const serverInstance = {
    once: vi.fn(),
    close: vi.fn((cb: () => void) => cb()),
    address: vi.fn(() => ({ port: 3337 }))
  };

  const app = {
    use: vi.fn(),
    get: vi.fn(),
    post: vi.fn(),
    listen: vi.fn((_port: number, _host: string, cb: () => void) => {
      // Defer callback so the assignment completes first
      queueMicrotask(cb);
      return serverInstance;
    })
  };

  const expressFn = Object.assign(vi.fn(() => app), {
    json: vi.fn(() => vi.fn())
  });

  const searchFn = vi.fn().mockResolvedValue({
    q: "test",
    scope: "main",
    results: [{ url: "/test", title: "Test", snippet: "snippet", score: 0.9, routeFile: "route" }],
    meta: { timingsMs: { search: 10, total: 15 } }
  });

  const createEngine = vi.fn().mockResolvedValue({
    search: searchFn
  });

  const loadConfig = vi.fn().mockResolvedValue({
    project: { id: "test" },
    upstash: { urlEnv: "UPSTASH_URL", tokenEnv: "UPSTASH_TOKEN" }
  });

  return { app, expressFn, serverInstance, searchFn, createEngine, loadConfig };
});

vi.mock("express", () => ({
  default: mocks.expressFn
}));

vi.mock("../src/search/engine", () => ({
  SearchEngine: { create: mocks.createEngine }
}));

vi.mock("../src/config/load", () => ({
  loadConfig: mocks.loadConfig
}));

vi.mock("../src/playground/playground.html", () => ({
  default: "<html>playground</html>"
}));

import { runPlaygroundServer } from "../src/playground/server";

describe("runPlaygroundServer", () => {
  it("starts server and registers routes", async () => {
    const result = await runPlaygroundServer({ cwd: "/tmp", port: 3337 });
    expect(result.port).toBe(3337);
    expect(typeof result.close).toBe("function");

    expect(mocks.app.get).toHaveBeenCalledWith("/_searchsocket", expect.any(Function));
    expect(mocks.app.post).toHaveBeenCalledWith("/_searchsocket/search", expect.any(Function));
  });

  it("GET /_searchsocket serves HTML", async () => {
    await runPlaygroundServer({ cwd: "/tmp", port: 3337 });

    const getHandler = mocks.app.get.mock.calls.find(
      (call: unknown[]) => call[0] === "/_searchsocket"
    )?.[1] as (req: unknown, res: { type: (t: string) => { send: (s: string) => void } }) => void;

    const sendFn = vi.fn();
    const res = { type: vi.fn(() => ({ send: sendFn })) };
    getHandler({}, res);

    expect(res.type).toHaveBeenCalledWith("html");
    expect(sendFn).toHaveBeenCalledWith("<html>playground</html>");
  });

  it("POST /_searchsocket/search calls SearchEngine and returns JSON", async () => {
    await runPlaygroundServer({ cwd: "/tmp", port: 3337 });

    const postHandler = mocks.app.post.mock.calls.find(
      (call: unknown[]) => call[0] === "/_searchsocket/search"
    )?.[1] as (req: { body: Record<string, unknown> }, res: { json: (d: unknown) => void; status: (n: number) => { json: (d: unknown) => void } }) => Promise<void>;

    const jsonFn = vi.fn();
    const res = { json: jsonFn, status: vi.fn(() => ({ json: vi.fn() })) };
    await postHandler({ body: { q: "test", debug: true } }, res);

    expect(mocks.searchFn).toHaveBeenCalledWith(
      expect.objectContaining({ q: "test", debug: true })
    );
    expect(jsonFn).toHaveBeenCalled();
  });

  it("POST /_searchsocket/search returns 400 for missing query", async () => {
    await runPlaygroundServer({ cwd: "/tmp", port: 3337 });

    const postHandler = mocks.app.post.mock.calls.find(
      (call: unknown[]) => call[0] === "/_searchsocket/search"
    )?.[1] as (req: { body: Record<string, unknown> }, res: { json: (d: unknown) => void; status: (n: number) => { json: (d: unknown) => void } }) => Promise<void>;

    const errorJsonFn = vi.fn();
    const res = { json: vi.fn(), status: vi.fn(() => ({ json: errorJsonFn })) };
    await postHandler({ body: {} }, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(errorJsonFn).toHaveBeenCalledWith({ error: "Missing or empty 'q' field" });
  });

  it("close() resolves cleanly", async () => {
    const result = await runPlaygroundServer({ cwd: "/tmp", port: 3337 });
    await expect(result.close()).resolves.toBeUndefined();
  });
});
