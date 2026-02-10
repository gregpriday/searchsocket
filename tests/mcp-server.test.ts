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

import { runMcpServer } from "../src/mcp/server";

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
