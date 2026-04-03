import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const app = {
    post: vi.fn(),
    get: vi.fn(),
    delete: vi.fn(),
    listen: vi.fn((_port: number, _host: string, cb: () => void) => {
      cb();
      return {
        once: vi.fn(),
        close: (closeCb: () => void) => closeCb()
      };
    })
  };

  const stdioConnect = vi.fn().mockResolvedValue(undefined);
  const httpConnect = vi.fn().mockResolvedValue(undefined);
  const createEngine = vi.fn();
  const loadConfig = vi.fn();

  return {
    app,
    stdioConnect,
    httpConnect,
    createEngine,
    loadConfig
  };
});

vi.mock("@modelcontextprotocol/sdk/server/mcp.js", () => {
  class McpServer {
    registerTool = vi.fn();
    close = vi.fn();
    connect = mocks.stdioConnect;
  }
  return { McpServer };
});

vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => {
  class StdioServerTransport {}
  return { StdioServerTransport };
});

vi.mock("@modelcontextprotocol/sdk/server/streamableHttp.js", () => {
  class StreamableHTTPServerTransport {
    handleRequest = vi.fn().mockResolvedValue(undefined);
    close = vi.fn();
  }
  return { StreamableHTTPServerTransport };
});

vi.mock("@modelcontextprotocol/sdk/server/express.js", () => {
  return {
    createMcpExpressApp: () => mocks.app
  };
});

vi.mock("../src/search/engine", () => {
  return {
    SearchEngine: {
      create: mocks.createEngine
    }
  };
});

vi.mock("../src/config/load", () => {
  return {
    loadConfig: mocks.loadConfig
  };
});

import { runMcpServer, createServer, resolveApiKey, verifyApiKey } from "../src/mcp/server";

describe("runMcpServer", () => {
  const originalLog = console.log;
  const originalWarn = console.warn;

  beforeEach(() => {
    vi.clearAllMocks();
    console.log = originalLog;
    console.warn = originalWarn;
  });

  afterEach(() => {
    console.log = originalLog;
    console.warn = originalWarn;
  });

  it("uses stdio transport and redirects console output to stderr", async () => {
    const config = {
      mcp: {
        transport: "stdio" as const,
        http: { port: 3338, path: "/mcp" }
      }
    };
    mocks.loadConfig.mockResolvedValue(config);
    mocks.createEngine.mockResolvedValue({
      getConfig: () => config
    });

    await runMcpServer({ transport: "stdio" });

    expect(mocks.loadConfig).toHaveBeenCalledTimes(1);
    expect(mocks.createEngine).toHaveBeenCalledWith(
      expect.objectContaining({
        config
      })
    );
    expect(mocks.stdioConnect).toHaveBeenCalledTimes(1);
    expect(console.log).not.toBe(originalLog);
  });

  it("respects config-driven http transport without forcing stdio redirection", async () => {
    const config = {
      mcp: {
        transport: "http" as const,
        http: { port: 3338, path: "/mcp" }
      }
    };
    mocks.loadConfig.mockResolvedValue(config);
    mocks.createEngine.mockResolvedValue({
      getConfig: () => config
    });

    await runMcpServer({});

    expect(mocks.loadConfig).toHaveBeenCalledTimes(1);
    expect(mocks.createEngine).toHaveBeenCalledWith(
      expect.objectContaining({
        config
      })
    );
    expect(mocks.app.listen).toHaveBeenCalledTimes(1);
    expect(console.log).toBe(originalLog);
  });

  it("honors explicit http transport override even if config defaults to stdio", async () => {
    const config = {
      mcp: {
        transport: "stdio" as const,
        http: { port: 3338, path: "/mcp" }
      }
    };
    mocks.loadConfig.mockResolvedValue(config);
    mocks.createEngine.mockResolvedValue({
      getConfig: () => config
    });

    await runMcpServer({ transport: "http" });

    expect(mocks.app.listen).toHaveBeenCalledTimes(1);
    expect(console.log).toBe(originalLog);
  });

  it("uses config-driven stdio transport when no explicit transport is provided", async () => {
    const config = {
      mcp: {
        transport: "stdio" as const,
        http: { port: 3338, path: "/mcp" }
      }
    };
    mocks.loadConfig.mockResolvedValue(config);
    mocks.createEngine.mockResolvedValue({
      getConfig: () => config
    });

    await runMcpServer({});

    expect(mocks.stdioConnect).toHaveBeenCalledTimes(1);
    expect(console.log).not.toBe(originalLog);
  });
});

describe("find_source_file tool", () => {
  function getHandler(mockEngine: Record<string, unknown>) {
    const server = createServer(mockEngine as never);
    const calls = (server.registerTool as ReturnType<typeof vi.fn>).mock.calls;
    const call = calls.find((c: unknown[]) => c[0] === "find_source_file");
    expect(call).toBeDefined();
    return call![2] as (input: Record<string, unknown>) => Promise<{
      content: Array<{ type: string; text: string }>;
    }>;
  }

  it("registers the find_source_file tool", () => {
    const mockEngine = { search: vi.fn() };
    const server = createServer(mockEngine as never);
    const calls = (server.registerTool as ReturnType<typeof vi.fn>).mock.calls;
    const toolNames = calls.map((c: unknown[]) => c[0]);
    expect(toolNames).toContain("find_source_file");
  });

  it("returns url, routeFile, sectionTitle, and snippet for a match", async () => {
    const mockEngine = {
      search: vi.fn().mockResolvedValue({
        results: [
          {
            url: "/about",
            title: "About Us",
            sectionTitle: "Our Mission",
            snippet: "We build great things.",
            score: 0.95,
            routeFile: "src/routes/about/+page.svelte",
            chunks: [{ text: "chunk1" }]
          }
        ]
      })
    };

    const handler = getHandler(mockEngine);
    const result = await handler({ query: "about us" });
    const parsed = JSON.parse(result.content[0]!.text);

    expect(parsed).toEqual({
      url: "/about",
      routeFile: "src/routes/about/+page.svelte",
      sectionTitle: "Our Mission",
      snippet: "We build great things."
    });
    expect(parsed).not.toHaveProperty("score");
    expect(parsed).not.toHaveProperty("title");
    expect(parsed).not.toHaveProperty("chunks");
    expect(mockEngine.search).toHaveBeenCalledWith({
      q: "about us",
      topK: 1,
      scope: undefined
    });
  });

  it("returns error message when no results found", async () => {
    const mockEngine = {
      search: vi.fn().mockResolvedValue({ results: [] })
    };

    const handler = getHandler(mockEngine);
    const result = await handler({ query: "nonexistent" });
    const parsed = JSON.parse(result.content[0]!.text);

    expect(parsed).toEqual({
      error: "No matching content found for the given query."
    });
  });

  it("omits sectionTitle when undefined", async () => {
    const mockEngine = {
      search: vi.fn().mockResolvedValue({
        results: [
          {
            url: "/home",
            title: "Home",
            sectionTitle: undefined,
            snippet: "Welcome.",
            score: 0.8,
            routeFile: "src/routes/+page.svelte"
          }
        ]
      })
    };

    const handler = getHandler(mockEngine);
    const result = await handler({ query: "home" });
    const parsed = JSON.parse(result.content[0]!.text);

    expect(parsed).toEqual({
      url: "/home",
      routeFile: "src/routes/+page.svelte",
      snippet: "Welcome."
    });
    expect(parsed).not.toHaveProperty("sectionTitle");
  });

  it("passes scope to engine.search when provided", async () => {
    const mockEngine = {
      search: vi.fn().mockResolvedValue({
        results: [
          {
            url: "/docs",
            title: "Docs",
            sectionTitle: "Intro",
            snippet: "Documentation.",
            score: 0.9,
            routeFile: "src/routes/docs/+page.svelte"
          }
        ]
      })
    };

    const handler = getHandler(mockEngine);
    await handler({ query: "docs", scope: "my-scope" });

    expect(mockEngine.search).toHaveBeenCalledWith({
      q: "docs",
      topK: 1,
      scope: "my-scope"
    });
  });

  it("propagates engine.search errors", async () => {
    const mockEngine = {
      search: vi.fn().mockRejectedValue(new Error("Upstash unreachable"))
    };

    const handler = getHandler(mockEngine);
    await expect(handler({ query: "fail" })).rejects.toThrow(
      "Upstash unreachable"
    );
  });
});

describe("verifyApiKey", () => {
  it("returns true for matching keys", () => {
    expect(verifyApiKey("test-key-123", "test-key-123")).toBe(true);
  });

  it("returns false for mismatched keys", () => {
    expect(verifyApiKey("wrong-key", "test-key-123")).toBe(false);
  });

  it("returns false for keys with different lengths", () => {
    expect(verifyApiKey("short", "a-much-longer-key-value")).toBe(false);
  });

  it("returns false for empty provided key", () => {
    expect(verifyApiKey("", "test-key-123")).toBe(false);
  });
});

describe("resolveApiKey", () => {
  it("returns apiKey from config when set", () => {
    const config = {
      mcp: { http: { apiKey: "direct-key", port: 3338, path: "/mcp" } }
    } as never;
    expect(resolveApiKey(config)).toBe("direct-key");
  });

  it("returns env var value when apiKeyEnv is set", () => {
    const envKey = "TEST_SEARCHSOCKET_MCP_KEY_" + Date.now();
    process.env[envKey] = "env-key-value";
    try {
      const config = {
        mcp: { http: { apiKeyEnv: envKey, port: 3338, path: "/mcp" } }
      } as never;
      expect(resolveApiKey(config)).toBe("env-key-value");
    } finally {
      delete process.env[envKey];
    }
  });

  it("prefers apiKey over apiKeyEnv", () => {
    const envKey = "TEST_SEARCHSOCKET_MCP_KEY2_" + Date.now();
    process.env[envKey] = "env-value";
    try {
      const config = {
        mcp: { http: { apiKey: "direct-value", apiKeyEnv: envKey, port: 3338, path: "/mcp" } }
      } as never;
      expect(resolveApiKey(config)).toBe("direct-value");
    } finally {
      delete process.env[envKey];
    }
  });

  it("returns undefined when neither is set", () => {
    const config = {
      mcp: { http: { port: 3338, path: "/mcp" } }
    } as never;
    expect(resolveApiKey(config)).toBeUndefined();
  });
});

describe("startHttpServer access modes", () => {
  const originalLog = console.log;
  const originalWarn = console.warn;

  beforeEach(() => {
    vi.clearAllMocks();
    console.log = originalLog;
    console.warn = originalWarn;
  });

  afterEach(() => {
    console.log = originalLog;
    console.warn = originalWarn;
  });

  it("binds to 127.0.0.1 in private mode (default)", async () => {
    const config = {
      mcp: {
        access: "private" as const,
        transport: "http" as const,
        http: { port: 3338, path: "/mcp" }
      }
    };
    mocks.loadConfig.mockResolvedValue(config);
    mocks.createEngine.mockResolvedValue({ getConfig: () => config });

    await runMcpServer({ transport: "http" });

    expect(mocks.app.listen).toHaveBeenCalledWith(
      3338,
      "127.0.0.1",
      expect.any(Function)
    );
  });

  it("binds to 0.0.0.0 in public mode", async () => {
    const config = {
      mcp: {
        access: "public" as const,
        transport: "http" as const,
        http: { port: 3338, path: "/mcp", apiKey: "test-key" }
      }
    };
    mocks.loadConfig.mockResolvedValue(config);
    mocks.createEngine.mockResolvedValue({ getConfig: () => config });

    await runMcpServer({ transport: "http" });

    expect(mocks.app.listen).toHaveBeenCalledWith(
      3338,
      "0.0.0.0",
      expect.any(Function)
    );
  });

  it("rejects requests without auth in public mode", async () => {
    const config = {
      mcp: {
        access: "public" as const,
        transport: "http" as const,
        http: { port: 3338, path: "/mcp", apiKey: "secret-key" }
      }
    };
    mocks.loadConfig.mockResolvedValue(config);
    mocks.createEngine.mockResolvedValue({ getConfig: () => config });

    await runMcpServer({ transport: "http" });

    const postHandler = mocks.app.post.mock.calls[0]![1] as (req: unknown, res: unknown) => Promise<void>;
    const mockRes = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn()
    };

    await postHandler(
      { headers: {}, body: {} },
      mockRes
    );

    expect(mockRes.status).toHaveBeenCalledWith(401);
    expect(mockRes.json).toHaveBeenCalledWith(
      expect.objectContaining({
        jsonrpc: "2.0",
        error: expect.objectContaining({ code: -32001, message: "Unauthorized" })
      })
    );
  });

  it("accepts requests with valid Bearer token in public mode", async () => {
    const config = {
      mcp: {
        access: "public" as const,
        transport: "http" as const,
        http: { port: 3338, path: "/mcp", apiKey: "secret-key" }
      }
    };
    mocks.loadConfig.mockResolvedValue(config);
    mocks.createEngine.mockResolvedValue({ getConfig: () => config });

    await runMcpServer({ transport: "http" });

    const postHandler = mocks.app.post.mock.calls[0]![1] as (req: unknown, res: unknown) => Promise<void>;
    const mockRes = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
      on: vi.fn(),
      headersSent: false
    };

    await postHandler(
      { headers: { authorization: "Bearer secret-key" }, body: {} },
      mockRes
    );

    // Should NOT have returned 401
    expect(mockRes.status).not.toHaveBeenCalledWith(401);
  });

  it("accepts requests with valid x-api-key header in public mode", async () => {
    const config = {
      mcp: {
        access: "public" as const,
        transport: "http" as const,
        http: { port: 3338, path: "/mcp", apiKey: "secret-key" }
      }
    };
    mocks.loadConfig.mockResolvedValue(config);
    mocks.createEngine.mockResolvedValue({ getConfig: () => config });

    await runMcpServer({ transport: "http" });

    const postHandler = mocks.app.post.mock.calls[0]![1] as (req: unknown, res: unknown) => Promise<void>;
    const mockRes = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
      on: vi.fn(),
      headersSent: false
    };

    await postHandler(
      { headers: { "x-api-key": "secret-key" }, body: {} },
      mockRes
    );

    expect(mockRes.status).not.toHaveBeenCalledWith(401);
  });

  it("rejects requests with wrong Bearer token in public mode", async () => {
    const config = {
      mcp: {
        access: "public" as const,
        transport: "http" as const,
        http: { port: 3338, path: "/mcp", apiKey: "secret-key" }
      }
    };
    mocks.loadConfig.mockResolvedValue(config);
    mocks.createEngine.mockResolvedValue({ getConfig: () => config });

    await runMcpServer({ transport: "http" });

    const postHandler = mocks.app.post.mock.calls[0]![1] as (req: unknown, res: unknown) => Promise<void>;
    const mockRes = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn()
    };

    await postHandler(
      { headers: { authorization: "Bearer wrong-key" }, body: {} },
      mockRes
    );

    expect(mockRes.status).toHaveBeenCalledWith(401);
  });

  it("does not require auth in private mode", async () => {
    const config = {
      mcp: {
        access: "private" as const,
        transport: "http" as const,
        http: { port: 3338, path: "/mcp" }
      }
    };
    mocks.loadConfig.mockResolvedValue(config);
    mocks.createEngine.mockResolvedValue({ getConfig: () => config });

    await runMcpServer({ transport: "http" });

    const postHandler = mocks.app.post.mock.calls[0]![1] as (req: unknown, res: unknown) => Promise<void>;
    const mockRes = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
      on: vi.fn(),
      headersSent: false
    };

    await postHandler(
      { headers: {}, body: {} },
      mockRes
    );

    // Should NOT have returned 401
    expect(mockRes.status).not.toHaveBeenCalledWith(401);
  });

  it("applies CLI access and apiKey overrides", async () => {
    const config = {
      mcp: {
        access: "private" as const,
        transport: "http" as const,
        http: { port: 3338, path: "/mcp" }
      }
    };
    mocks.loadConfig.mockResolvedValue(config);
    mocks.createEngine.mockResolvedValue({ getConfig: () => config });

    await runMcpServer({ transport: "http", access: "public", apiKey: "cli-key" });

    // Should bind to 0.0.0.0 because CLI overrode access to public
    expect(mocks.app.listen).toHaveBeenCalledWith(
      3338,
      "0.0.0.0",
      expect.any(Function)
    );

    // Auth should be enforced with the CLI key
    const postHandler = mocks.app.post.mock.calls[0]![1] as (req: unknown, res: unknown) => Promise<void>;
    const mockRes = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn()
    };

    await postHandler(
      { headers: {}, body: {} },
      mockRes
    );
    expect(mockRes.status).toHaveBeenCalledWith(401);
  });

  it("throws when CLI sets access to public without apiKey", async () => {
    const config = {
      mcp: {
        access: "private" as const,
        transport: "http" as const,
        http: { port: 3338, path: "/mcp" }
      }
    };
    mocks.loadConfig.mockResolvedValue(config);
    mocks.createEngine.mockResolvedValue({ getConfig: () => config });

    await expect(
      runMcpServer({ transport: "http", access: "public" })
    ).rejects.toThrow("no API key");
  });
});
