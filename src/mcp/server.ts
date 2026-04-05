import { createHash, timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import type { Request, Response } from "express";
import { z } from "zod";
import { SearchEngine } from "../search/engine";
import { loadConfig } from "../config/load";
import type { ResolvedSearchSocketConfig } from "../types";

export interface McpServerOptions {
  cwd?: string;
  configPath?: string;
  transport?: "stdio" | "http";
  httpPort?: number;
  httpPath?: string;
  access?: "public" | "private";
  apiKey?: string;
}

export function createServer(engine: SearchEngine): McpServer {
  const server = new McpServer({
    name: "searchsocket-mcp",
    version: "0.2.0"
  });

  // ---------------------------------------------------------------------------
  // Tool 1: search — Core discovery tool for both RAG and local file editing
  // ---------------------------------------------------------------------------
  server.registerTool(
    "search",
    {
      description:
        "Searches indexed site content using semantic similarity. Returns ranked results with url, title, snippet, chunkText (full section markdown), score, and routeFile (source file path for editing). Each result includes the best-matching section; set groupBy to 'page' (default) for additional chunk sub-results per page. Use routeFile to locate the source file when editing content. If snippets lack detail, call get_page with the result URL to retrieve the full page markdown.",
      inputSchema: {
        query: z.string().min(1).describe("Search query. Use keywords or natural language, not full sentences."),
        topK: z.number().int().positive().max(100).optional().describe("Number of results to return (default: 10, max: 100)"),
        pathPrefix: z.string().optional().describe("Filter results to URLs starting with this prefix (e.g. '/docs')"),
        tags: z.array(z.string()).optional().describe("Filter results to pages matching all specified tags"),
        filters: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional().describe("Filter by structured page metadata (e.g. {\"version\": 2})"),
        groupBy: z.enum(["page", "chunk"]).optional().describe("'page' (default) groups chunks by page with sub-results; 'chunk' returns individual chunks"),
        scope: z.string().optional()
      }
    },
    async (input) => {
      const result = await engine.search({
        q: input.query,
        topK: input.topK,
        scope: input.scope,
        pathPrefix: input.pathPrefix,
        tags: input.tags,
        filters: input.filters,
        groupBy: input.groupBy
      });

      if (result.results.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `No results found for "${input.query}". Try broader keywords or remove filters.`
            }
          ]
        };
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2)
          }
        ]
      };
    }
  );

  // ---------------------------------------------------------------------------
  // Tool 2: get_page — Full page retrieval for RAG deep-dives
  // ---------------------------------------------------------------------------
  server.registerTool(
    "get_page",
    {
      description:
        "Retrieves the full markdown content and metadata for a specific page by its URL path. Use this after search when snippets lack the detail needed to answer a question. Returns reconstructed page markdown, frontmatter (title, routeFile, tags, link counts, indexedAt), and the source file path. Do NOT use this for discovery — use search first to find relevant pages.",
      inputSchema: {
        path: z.string().min(1).describe("URL path of the page (e.g. '/docs/auth'). Use a URL from search results."),
        scope: z.string().optional()
      }
    },
    async (input) => {
      try {
        const page = await engine.getPage(input.path, input.scope);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(page, null, 2)
            }
          ]
        };
      } catch {
        const suggestions = await engine.search({ q: input.path, topK: 3, scope: input.scope });
        const similar = suggestions.results.map((r) => r.url);
        return {
          content: [
            {
              type: "text",
              text: similar.length > 0
                ? `Page '${input.path}' not found. Similar pages: ${similar.join(", ")}`
                : `Page '${input.path}' not found. Use search to find the correct URL.`
            }
          ]
        };
      }
    }
  );

  // ---------------------------------------------------------------------------
  // Tool 3: get_related_pages — Link graph + semantic relationship discovery
  // ---------------------------------------------------------------------------
  server.registerTool(
    "get_related_pages",
    {
      description:
        "Finds pages related to a specific page using link graph analysis, semantic similarity, and URL structure. Returns related pages with relationship type (outgoing_link, incoming_link, sibling, semantic) and relevance score. Do NOT use this for general search — use search instead. Use this only when you already have a specific page URL and need to discover connected content.",
      inputSchema: {
        path: z.string().min(1).describe("URL path of the source page (e.g. '/docs/auth'). Use a URL from search results."),
        topK: z.number().int().positive().max(25).optional().describe("Number of related pages to return (default: 10, max: 25)"),
        scope: z.string().optional()
      }
    },
    async (input) => {
      const result = await engine.getRelatedPages(input.path, {
        topK: input.topK,
        scope: input.scope
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2)
          }
        ]
      };
    }
  );

  return server;
}

export function resolveApiKey(config: ResolvedSearchSocketConfig): string | undefined {
  return config.mcp.http.apiKey
    ?? (config.mcp.http.apiKeyEnv ? process.env[config.mcp.http.apiKeyEnv] : undefined);
}

export function verifyApiKey(provided: string, expected: string): boolean {
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

function redirectConsoleToStderr(): void {
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    process.stderr.write(`[LOG] ${args.map(String).join(" ")}\n`);
  };

  console.warn = (...args: unknown[]) => {
    process.stderr.write(`[WARN] ${args.map(String).join(" ")}\n`);
  };

  void originalLog;
}

async function startHttpServer(serverFactory: () => McpServer, config: ResolvedSearchSocketConfig, opts: McpServerOptions): Promise<void> {
  const app = createMcpExpressApp();
  const port = opts.httpPort ?? config.mcp.http.port;
  const endpointPath = opts.httpPath ?? config.mcp.http.path;
  const isPublic = config.mcp.access === "public";
  const host = isPublic ? "0.0.0.0" : "127.0.0.1";
  const apiKey = isPublic ? resolveApiKey(config) : undefined;

  app.post(endpointPath, async (req: Request, res: Response) => {
    if (isPublic && apiKey) {
      const authHeader = req.headers["authorization"];
      const provided = (authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : undefined)
        ?? (req.headers["x-api-key"] as string | undefined)
        ?? "";
      if (!provided || !verifyApiKey(provided, apiKey)) {
        res.status(401).json({
          jsonrpc: "2.0",
          error: { code: -32001, message: "Unauthorized" },
          id: null
        });
        return;
      }
    }

    const server = serverFactory();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      res.on("close", () => {
        transport.close();
        server.close();
      });
    } catch (error) {
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: {
            code: -32603,
            message: error instanceof Error ? error.message : "Internal server error"
          },
          id: null
        });
      }
    }
  });

  app.get(endpointPath, (_req: Request, res: Response) => {
    res.writeHead(405).end(
      JSON.stringify({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Method not allowed"
        },
        id: null
      })
    );
  });

  app.delete(endpointPath, (_req: Request, res: Response) => {
    res.writeHead(405).end(
      JSON.stringify({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Method not allowed"
        },
        id: null
      })
    );
  });

  await new Promise<void>((resolve, reject) => {
    const instance = app.listen(port, host, () => {
      process.stderr.write(`SearchSocket MCP HTTP server listening on http://${host}:${port}${endpointPath}\n`);
      if (isPublic) {
        process.stderr.write("WARNING: Server is in public mode. Ensure HTTPS is configured via a reverse proxy for production use.\n");
      }
      resolve();
    });
    instance.once("error", reject);

    process.on("SIGINT", async () => {
      await new Promise<void>((shutdownResolve) => instance.close(() => shutdownResolve()));
      process.exit(0);
    });
  });
}

export async function runMcpServer(options: McpServerOptions = {}): Promise<void> {
  const config = await loadConfig({
    cwd: options.cwd,
    configPath: options.configPath
  });

  if (options.access) config.mcp.access = options.access;
  if (options.apiKey) config.mcp.http.apiKey = options.apiKey;

  if (config.mcp.access === "public" && !resolveApiKey(config)) {
    throw new Error(
      'MCP access is "public" but no API key is configured. Pass --api-key or set mcp.http.apiKey / mcp.http.apiKeyEnv in config.'
    );
  }

  const resolvedTransport = options.transport ?? config.mcp.transport;

  // For stdio transport, redirect ALL output to stderr before server initialization
  // to prevent corrupting the JSON-RPC stream on stdout.
  if (resolvedTransport === "stdio") {
    redirectConsoleToStderr();
  }

  const engine = await SearchEngine.create({
    cwd: options.cwd,
    configPath: options.configPath,
    config
  });

  if (resolvedTransport === "http") {
    await startHttpServer(() => createServer(engine), config, options);
    return;
  }

  const server = createServer(engine);
  const stdioTransport = new StdioServerTransport();
  await server.connect(stdioTransport);
}
