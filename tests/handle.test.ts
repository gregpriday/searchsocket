import { afterEach, describe, expect, it, vi } from "vitest";
import { searchsocketHandle } from "../src/sveltekit/handle";
import { createDefaultConfig } from "../src/config/defaults";
import { SearchEngine } from "../src/search/engine";
import { SearchSocketError } from "../src/errors";
import type { ResolvedSearchSocketConfig } from "../src/types";

function makeConfig(overrides: Partial<ResolvedSearchSocketConfig> = {}): ResolvedSearchSocketConfig {
  const base = createDefaultConfig("test");
  return {
    ...base,
    ...overrides,
    api: {
      ...base.api,
      ...overrides.api,
      cors: {
        ...base.api.cors,
        ...overrides.api?.cors
      }
    }
  } as ResolvedSearchSocketConfig;
}

function makeEvent(options: {
  pathname: string;
  method: string;
  body?: object;
  headers?: Record<string, string>;
  contentLength?: number;
}) {
  const headers = new Headers(options.headers);
  if (options.contentLength !== undefined) {
    headers.set("content-length", String(options.contentLength));
  }

  const bodyStr = options.body ? JSON.stringify(options.body) : "";
  void bodyStr;

  return {
    url: { pathname: options.pathname },
    request: {
      method: options.method,
      headers,
      json: async () => options.body,
      text: async () => bodyStr
    },
    getClientAddress: () => "127.0.0.1"
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.VERCEL;
});

describe("searchsocketHandle", () => {
  it("returns a function", () => {
    const handle = searchsocketHandle();
    expect(typeof handle).toBe("function");
  });

  it("passes through non-matching paths without requiring config when path is explicit", async () => {
    const handle = searchsocketHandle({ path: "/api/search" });
    const resolveResult = new Response("ok");
    const resolve = vi.fn().mockResolvedValue(resolveResult);

    const event = makeEvent({
      pathname: "/not-search",
      method: "GET"
    });

    const response = await handle({ event, resolve });
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(await response.text()).toBe("ok");
  });

  it("accepts custom path option", () => {
    const handle = searchsocketHandle({ path: "/custom/search" });
    expect(typeof handle).toBe("function");
  });

  it("accepts maxBodyBytes option", () => {
    const handle = searchsocketHandle({ maxBodyBytes: 1024 });
    expect(typeof handle).toBe("function");
  });

  it("returns search results for valid POST requests and memoizes engine creation", async () => {
    const config = makeConfig({
      api: {
        path: "/api/search",
        cors: {
          allowOrigins: ["https://app.example"]
        }
      }
    });

    const search = vi.fn().mockResolvedValue({
      q: "install",
      scope: "main",
      results: [
        {
          url: "/docs/install",
          title: "Install",
          sectionTitle: "Install",
          snippet: "Use pnpm add searchsocket",
          score: 0.9,
          routeFile: "src/routes/docs/install/+page.svelte"
        }
      ],
      meta: {
        timingsMs: {
          search: 1,
          total: 2
        }
      }
    });

    const createSpy = vi.spyOn(SearchEngine, "create").mockResolvedValue({
      search
    } as unknown as SearchEngine);

    const handle = searchsocketHandle({ config });
    const resolve = vi.fn().mockResolvedValue(new Response("ok"));
    const event = makeEvent({
      pathname: "/api/search",
      method: "POST",
      body: { q: "install" },
      headers: { origin: "https://app.example" }
    });

    const first = await handle({ event, resolve });
    const second = await handle({ event, resolve });

    expect(first.status).toBe(200);
    expect(first.headers.get("access-control-allow-origin")).toBe("https://app.example");
    expect(await first.json()).toMatchObject({
      q: "install",
      results: [{ url: "/docs/install" }]
    });

    expect(second.status).toBe(200);
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(search).toHaveBeenCalledTimes(2);
  });

  it("returns 405 for unsupported methods", async () => {
    const config = makeConfig();
    const createSpy = vi.spyOn(SearchEngine, "create");
    const handle = searchsocketHandle({ config });
    const resolve = vi.fn().mockResolvedValue(new Response("ok"));

    const response = await handle({
      event: makeEvent({ pathname: "/api/search", method: "GET" }),
      resolve
    });

    expect(response.status).toBe(405);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "INVALID_REQUEST"
      }
    });
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("returns 413 when body exceeds maxBodyBytes", async () => {
    const config = makeConfig();
    const createSpy = vi.spyOn(SearchEngine, "create");
    const handle = searchsocketHandle({ config, maxBodyBytes: 8 });
    const resolve = vi.fn().mockResolvedValue(new Response("ok"));

    const response = await handle({
      event: makeEvent({
        pathname: "/api/search",
        method: "POST",
        body: { q: "too-large" },
        contentLength: 100
      }),
      resolve
    });

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "INVALID_REQUEST"
      }
    });
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("enforces rate limits per client", async () => {
    const config = makeConfig({
      api: {
        path: "/api/search",
        cors: {
          allowOrigins: []
        },
        rateLimit: {
          windowMs: 60_000,
          max: 1
        }
      }
    });

    vi.spyOn(SearchEngine, "create").mockResolvedValue({
      search: vi.fn().mockResolvedValue({
        q: "ok",
        scope: "main",
        results: [],
        meta: {
          timingsMs: { search: 0, total: 0 }
        }
      })
    } as unknown as SearchEngine);

    const handle = searchsocketHandle({ config });
    const resolve = vi.fn().mockResolvedValue(new Response("ok"));
    const event = makeEvent({
      pathname: "/api/search",
      method: "POST",
      body: { q: "test" }
    });

    const first = await handle({ event, resolve });
    const second = await handle({ event, resolve });

    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
    await expect(second.json()).resolves.toMatchObject({
      error: {
        code: "RATE_LIMITED"
      }
    });
  });

  it("returns 204 with CORS headers for allowed preflight requests", async () => {
    const config = makeConfig({
      api: {
        path: "/api/search",
        cors: {
          allowOrigins: ["https://allowed.example"]
        }
      }
    });

    const handle = searchsocketHandle({ config });
    const resolve = vi.fn().mockResolvedValue(new Response("ok"));

    const response = await handle({
      event: makeEvent({
        pathname: "/api/search",
        method: "OPTIONS",
        headers: { origin: "https://allowed.example" }
      }),
      resolve
    });

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("https://allowed.example");
  });

  it("returns a structured 500 error when search throws an unexpected error", async () => {
    const config = makeConfig();
    vi.spyOn(SearchEngine, "create").mockResolvedValue({
      search: vi.fn().mockRejectedValue(new Error("boom"))
    } as unknown as SearchEngine);

    const handle = searchsocketHandle({ config });
    const resolve = vi.fn().mockResolvedValue(new Response("ok"));

    const response = await handle({
      event: makeEvent({
        pathname: "/api/search",
        method: "POST",
        body: { q: "test" }
      }),
      resolve
    });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "INTERNAL_ERROR",
        message: "boom"
      }
    });
  });

  it("returns SearchSocketError status codes from engine failures", async () => {
    const config = makeConfig();
    vi.spyOn(SearchEngine, "create").mockResolvedValue({
      search: vi.fn().mockRejectedValue(new SearchSocketError("INVALID_REQUEST", "bad query", 400))
    } as unknown as SearchEngine);

    const handle = searchsocketHandle({ config });
    const resolve = vi.fn().mockResolvedValue(new Response("ok"));

    const response = await handle({
      event: makeEvent({
        pathname: "/api/search",
        method: "POST",
        body: { q: "test" }
      }),
      resolve
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "INVALID_REQUEST",
        message: "bad query"
      }
    });
  });

  it("returns INVALID_REQUEST when request JSON is malformed", async () => {
    const config = makeConfig();
    const handle = searchsocketHandle({ config });
    const resolve = vi.fn().mockResolvedValue(new Response("ok"));

    const event = makeEvent({
      pathname: "/api/search",
      method: "POST",
      body: { q: "unused" }
    });

    event.request.text = async () => "{ invalid json";

    const response = await handle({ event, resolve });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "INVALID_REQUEST",
        message: "Malformed JSON request body"
      }
    });
  });

  it("rejects oversized bodies even when content-length is missing", async () => {
    const config = makeConfig();
    vi.spyOn(SearchEngine, "create").mockResolvedValue({
      search: vi.fn().mockResolvedValue({
        q: "ok",
        scope: "main",
        results: [],
        meta: {
          timingsMs: { search: 0, total: 0 }
        }
      })
    } as unknown as SearchEngine);

    const handle = searchsocketHandle({ config, maxBodyBytes: 16 });
    const resolve = vi.fn().mockResolvedValue(new Response("ok"));
    const event = makeEvent({
      pathname: "/api/search",
      method: "POST",
      body: { q: "x".repeat(10_000) }
    });

    // Simulate missing content-length from some proxies/clients.
    event.request.headers.delete("content-length");

    const response = await handle({ event, resolve });
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "INVALID_REQUEST"
      }
    });
  });

  it("returns INVALID_REQUEST for malformed JSON when request.text is unavailable", async () => {
    const config = makeConfig();
    const handle = searchsocketHandle({ config });
    const resolve = vi.fn().mockResolvedValue(new Response("ok"));

    const event = makeEvent({
      pathname: "/api/search",
      method: "POST",
      body: { q: "unused" }
    });

    delete (event.request as { text?: () => Promise<string> }).text;
    event.request.json = async () => {
      throw new SyntaxError("Unexpected token");
    };

    const response = await handle({ event, resolve });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "INVALID_REQUEST",
        message: "Malformed JSON request body"
      }
    });
  });

  it("resolves rawConfig and serves search results", async () => {
    const search = vi.fn().mockResolvedValue({
      q: "deploy",
      scope: "main",
      results: [],
      meta: {
        timingsMs: { search: 0, total: 0 }
      }
    });

    vi.spyOn(SearchEngine, "create").mockResolvedValue({
      search
    } as unknown as SearchEngine);

    const handle = searchsocketHandle({
      rawConfig: {
        project: { id: "test-site" },
        source: { mode: "static-output" }
      }
    });

    const resolve = vi.fn().mockResolvedValue(new Response("ok"));
    const event = makeEvent({
      pathname: "/api/search",
      method: "POST",
      body: { q: "deploy" }
    });

    const response = await handle({ event, resolve });
    expect(response.status).toBe(200);
    expect(search).toHaveBeenCalledTimes(1);
  });

  it("auto-disables rate limiter on serverless", async () => {
    process.env.VERCEL = "1";

    vi.spyOn(SearchEngine, "create").mockResolvedValue({
      search: vi.fn().mockResolvedValue({
        q: "ok",
        scope: "main",
        results: [],
        meta: {
          timingsMs: { search: 0, total: 0 }
        }
      })
    } as unknown as SearchEngine);

    const config = makeConfig({
      api: {
        path: "/api/search",
        cors: { allowOrigins: [] },
        rateLimit: { windowMs: 60_000, max: 1 }
      }
    });

    const handle = searchsocketHandle({ config });
    const resolve = vi.fn().mockResolvedValue(new Response("ok"));
    const event = makeEvent({
      pathname: "/api/search",
      method: "POST",
      body: { q: "test" }
    });

    const first = await handle({ event, resolve });
    const second = await handle({ event, resolve });

    // Both succeed because rate limiter is disabled on serverless
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
  });
});
