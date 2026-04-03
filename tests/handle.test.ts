import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { searchsocketHandle } from "../src/sveltekit/handle";
import { createDefaultConfig } from "../src/config/defaults";
import { SearchEngine } from "../src/search/engine";
import { SearchSocketError } from "../src/errors";
import type { ResolvedSearchSocketConfig } from "../src/types";

let mockTransportHandleRequest = vi.fn().mockResolvedValue(new Response(JSON.stringify({ jsonrpc: "2.0", result: {} }), {
  status: 200,
  headers: { "content-type": "application/json" }
}));
let mockTransportClose = vi.fn().mockResolvedValue(undefined);

vi.mock("@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js", () => {
  return {
    WebStandardStreamableHTTPServerTransport: class {
      handleRequest = (...args: unknown[]) => mockTransportHandleRequest(...args);
      close = (...args: unknown[]) => mockTransportClose(...args);
    }
  };
});

vi.mock("../src/mcp/server", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/mcp/server")>();
  return {
    ...original,
    createServer: vi.fn().mockReturnValue({
      connect: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined)
    })
  };
});

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
  mockTransportHandleRequest = vi.fn().mockResolvedValue(new Response(JSON.stringify({ jsonrpc: "2.0", result: {} }), {
    status: 200,
    headers: { "content-type": "application/json" }
  }));
  mockTransportClose = vi.fn().mockResolvedValue(undefined);
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

  it("returns 503 with SEARCH_NOT_CONFIGURED when engine creation throws VECTOR_BACKEND_UNAVAILABLE", async () => {
    const config = makeConfig();
    vi.spyOn(SearchEngine, "create").mockRejectedValue(
      new SearchSocketError("VECTOR_BACKEND_UNAVAILABLE", "Missing Upstash Search credentials", 500)
    );

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

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "SEARCH_NOT_CONFIGURED"
      }
    });
  });

  it("caches not-configured state and does not retry engine creation", async () => {
    const config = makeConfig();
    const createSpy = vi.spyOn(SearchEngine, "create").mockRejectedValue(
      new SearchSocketError("VECTOR_BACKEND_UNAVAILABLE", "Missing Upstash Search credentials", 500)
    );

    const handle = searchsocketHandle({ config });
    const resolve = vi.fn().mockResolvedValue(new Response("ok"));
    const event = makeEvent({
      pathname: "/api/search",
      method: "POST",
      body: { q: "test" }
    });

    const first = await handle({ event, resolve });
    const second = await handle({ event, resolve });

    expect(first.status).toBe(503);
    expect(second.status).toBe(503);
    expect(createSpy).toHaveBeenCalledTimes(1);

    await expect(second.json()).resolves.toMatchObject({
      error: {
        code: "SEARCH_NOT_CONFIGURED"
      }
    });
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

describe("searchsocketHandle llms.txt serving", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "handle-llms-test-"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("serves llms.txt as text/plain when enabled and file exists", async () => {
    const staticDir = path.join(tmpDir, "static");
    await fs.mkdir(staticDir, { recursive: true });
    await fs.writeFile(path.join(staticDir, "llms.txt"), "# My Site\n\n## Pages\n", "utf8");

    const config = makeConfig({
      llmsTxt: {
        enable: true,
        outputPath: "static/llms.txt",
        generateFull: false
      }
    } as Partial<ResolvedSearchSocketConfig>);

    const handle = searchsocketHandle({ config, cwd: tmpDir });
    const resolve = vi.fn().mockResolvedValue(new Response("fallback"));
    const event = makeEvent({ pathname: "/llms.txt", method: "GET" });

    const response = await handle({ event, resolve });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await response.text()).toContain("# My Site");
    expect(resolve).not.toHaveBeenCalled();
  });

  it("falls through when llms.txt is enabled but file does not exist", async () => {
    const config = makeConfig({
      llmsTxt: {
        enable: true,
        outputPath: "static/llms.txt",
        generateFull: false
      }
    } as Partial<ResolvedSearchSocketConfig>);

    const handle = searchsocketHandle({ config, cwd: tmpDir });
    const resolveResult = new Response("fallback");
    const resolve = vi.fn().mockResolvedValue(resolveResult);
    const event = makeEvent({ pathname: "/llms.txt", method: "GET" });

    const response = await handle({ event, resolve });
    expect(resolve).toHaveBeenCalled();
    expect(await response.text()).toBe("fallback");
  });

  it("falls through when llms.txt is disabled", async () => {
    const config = makeConfig({
      llmsTxt: {
        enable: false,
        outputPath: "static/llms.txt",
        generateFull: false
      }
    } as Partial<ResolvedSearchSocketConfig>);

    const handle = searchsocketHandle({ config, cwd: tmpDir });
    const resolveResult = new Response("fallback");
    const resolve = vi.fn().mockResolvedValue(resolveResult);
    const event = makeEvent({ pathname: "/llms.txt", method: "GET" });

    const response = await handle({ event, resolve });
    expect(resolve).toHaveBeenCalled();
  });

  it("serves llms.txt even after API search requests have been made", async () => {
    const staticDir = path.join(tmpDir, "static");
    await fs.mkdir(staticDir, { recursive: true });
    await fs.writeFile(path.join(staticDir, "llms.txt"), "# My Site\n", "utf8");

    const config = makeConfig({
      llmsTxt: {
        enable: true,
        outputPath: "static/llms.txt",
        generateFull: false
      }
    } as Partial<ResolvedSearchSocketConfig>);

    vi.spyOn(SearchEngine, "create").mockResolvedValue({
      search: vi.fn().mockResolvedValue({
        q: "ok",
        scope: "main",
        results: [],
        meta: { timingsMs: { search: 0, total: 0 } }
      })
    } as unknown as SearchEngine);

    const handle = searchsocketHandle({ config, cwd: tmpDir });
    const resolve = vi.fn().mockResolvedValue(new Response("fallback"));

    // First: a POST to /api/search (triggers config loading and sets apiPath)
    const searchEvent = makeEvent({ pathname: "/api/search", method: "POST", body: { q: "test" } });
    const searchResponse = await handle({ event: searchEvent, resolve });
    expect(searchResponse.status).toBe(200);

    // Second: a GET to /llms.txt should still work
    const llmsEvent = makeEvent({ pathname: "/llms.txt", method: "GET" });
    const llmsResponse = await handle({ event: llmsEvent, resolve });
    expect(llmsResponse.status).toBe(200);
    expect(await llmsResponse.text()).toContain("# My Site");
  });

  it("does not intercept POST requests to /llms.txt", async () => {
    const staticDir = path.join(tmpDir, "static");
    await fs.mkdir(staticDir, { recursive: true });
    await fs.writeFile(path.join(staticDir, "llms.txt"), "# My Site\n", "utf8");

    const config = makeConfig({
      llmsTxt: {
        enable: true,
        outputPath: "static/llms.txt",
        generateFull: false
      }
    } as Partial<ResolvedSearchSocketConfig>);

    const handle = searchsocketHandle({ config, cwd: tmpDir });
    const resolveResult = new Response("fallback");
    const resolve = vi.fn().mockResolvedValue(resolveResult);
    const event = makeEvent({ pathname: "/llms.txt", method: "POST", body: {} });

    const response = await handle({ event, resolve });
    // POST to /llms.txt should not be intercepted - it falls through to the API path check
    // which will also fall through since /llms.txt != /api/search
    expect(resolve).toHaveBeenCalled();
  });
});

describe("MCP endpoint", () => {
  it("routes MCP requests to the MCP handler", async () => {
    const config = makeConfig();
    vi.spyOn(SearchEngine, "create").mockResolvedValue({
      search: vi.fn()
    } as unknown as SearchEngine);

    const handle = searchsocketHandle({ config });
    const resolve = vi.fn().mockResolvedValue(new Response("ok"));

    const event = makeEvent({
      pathname: "/api/mcp",
      method: "POST",
      body: { jsonrpc: "2.0", method: "initialize", id: 1 }
    });

    const response = await handle({ event, resolve });
    expect(response.status).toBe(200);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("passes non-MCP paths through to resolve", async () => {
    const config = makeConfig();
    const handle = searchsocketHandle({ config, path: "/api/search" });
    const resolveResult = new Response("ok");
    const resolve = vi.fn().mockResolvedValue(resolveResult);

    const event = makeEvent({
      pathname: "/other",
      method: "GET"
    });

    const response = await handle({ event, resolve });
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(await response.text()).toBe("ok");
  });

  it("returns 401 when API key is configured and Authorization header is missing", async () => {
    const config = makeConfig();
    config.mcp.handle.apiKey = "test-secret";

    const handle = searchsocketHandle({ config });
    const resolve = vi.fn().mockResolvedValue(new Response("ok"));

    const event = makeEvent({
      pathname: "/api/mcp",
      method: "POST",
      body: { jsonrpc: "2.0", method: "initialize", id: 1 }
    });

    const response = await handle({ event, resolve });
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error.message).toBe("Unauthorized");
  });

  it("returns 401 when API key is wrong", async () => {
    const config = makeConfig();
    config.mcp.handle.apiKey = "test-secret";

    const handle = searchsocketHandle({ config });
    const resolve = vi.fn().mockResolvedValue(new Response("ok"));

    const event = makeEvent({
      pathname: "/api/mcp",
      method: "POST",
      body: { jsonrpc: "2.0", method: "initialize", id: 1 },
      headers: { authorization: "Bearer wrong-key" }
    });

    const response = await handle({ event, resolve });
    expect(response.status).toBe(401);
  });

  it("accepts requests with correct API key", async () => {
    const config = makeConfig();
    config.mcp.handle.apiKey = "test-secret";

    vi.spyOn(SearchEngine, "create").mockResolvedValue({
      search: vi.fn()
    } as unknown as SearchEngine);

    const handle = searchsocketHandle({ config });
    const resolve = vi.fn().mockResolvedValue(new Response("ok"));

    const event = makeEvent({
      pathname: "/api/mcp",
      method: "POST",
      body: { jsonrpc: "2.0", method: "initialize", id: 1 },
      headers: { authorization: "Bearer test-secret" }
    });

    const response = await handle({ event, resolve });
    expect(response.status).toBe(200);
  });

  it("does not require auth when no API key is configured", async () => {
    const config = makeConfig();
    // No apiKey set

    vi.spyOn(SearchEngine, "create").mockResolvedValue({
      search: vi.fn()
    } as unknown as SearchEngine);

    const handle = searchsocketHandle({ config });
    const resolve = vi.fn().mockResolvedValue(new Response("ok"));

    const event = makeEvent({
      pathname: "/api/mcp",
      method: "POST",
      body: { jsonrpc: "2.0", method: "initialize", id: 1 }
    });

    const response = await handle({ event, resolve });
    expect(response.status).toBe(200);
  });

  it("returns 500 when transport throws", async () => {
    mockTransportHandleRequest = vi.fn().mockRejectedValue(new Error("transport boom"));

    const config = makeConfig();
    vi.spyOn(SearchEngine, "create").mockResolvedValue({
      search: vi.fn()
    } as unknown as SearchEngine);

    const handle = searchsocketHandle({ config });
    const resolve = vi.fn().mockResolvedValue(new Response("ok"));

    const event = makeEvent({
      pathname: "/api/mcp",
      method: "POST",
      body: { jsonrpc: "2.0", method: "initialize", id: 1 }
    });

    const response = await handle({ event, resolve });
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error.message).toBe("transport boom");
  });

  it("memoizes engine across MCP requests", async () => {
    const config = makeConfig();
    const createSpy = vi.spyOn(SearchEngine, "create").mockResolvedValue({
      search: vi.fn()
    } as unknown as SearchEngine);

    const handle = searchsocketHandle({ config });
    const resolve = vi.fn().mockResolvedValue(new Response("ok"));

    const event = makeEvent({
      pathname: "/api/mcp",
      method: "POST",
      body: { jsonrpc: "2.0", method: "initialize", id: 1 }
    });

    await handle({ event, resolve });
    await handle({ event, resolve });

    expect(createSpy).toHaveBeenCalledTimes(1);
  });

  it("routes to custom MCP path from config", async () => {
    const config = makeConfig();
    config.mcp.handle.path = "/custom/mcp";

    vi.spyOn(SearchEngine, "create").mockResolvedValue({
      search: vi.fn()
    } as unknown as SearchEngine);

    const handle = searchsocketHandle({ config });
    const resolve = vi.fn().mockResolvedValue(new Response("ok"));

    const event = makeEvent({
      pathname: "/custom/mcp",
      method: "POST",
      body: { jsonrpc: "2.0", method: "initialize", id: 1 }
    });

    const response = await handle({ event, resolve });
    expect(response.status).toBe(200);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("search endpoint still works alongside MCP", async () => {
    const config = makeConfig({
      api: {
        path: "/api/search",
        cors: { allowOrigins: [] }
      }
    });

    vi.spyOn(SearchEngine, "create").mockResolvedValue({
      search: vi.fn().mockResolvedValue({
        q: "test",
        scope: "main",
        results: [],
        meta: { timingsMs: { search: 0, total: 0 } }
      })
    } as unknown as SearchEngine);

    const handle = searchsocketHandle({ config });
    const resolve = vi.fn().mockResolvedValue(new Response("ok"));

    const searchEvent = makeEvent({
      pathname: "/api/search",
      method: "POST",
      body: { q: "test" }
    });

    const searchResponse = await handle({ event: searchEvent, resolve });
    expect(searchResponse.status).toBe(200);

    const mcpEvent = makeEvent({
      pathname: "/api/mcp",
      method: "POST",
      body: { jsonrpc: "2.0", method: "initialize", id: 1 }
    });

    const mcpResponse = await handle({ event: mcpEvent, resolve });
    expect(mcpResponse.status).toBe(200);
  });
});
