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
    version: "0.1.0"
  });

  server.registerTool(
    "search",
    {
      description:
        "Semantic site search powered by Upstash Search. Returns url/title/snippet/score/routeFile for each match. Supports optional scope, pathPrefix, tags, topK, and groupBy.",
      inputSchema: {
        query: z.string().min(1),
        scope: z.string().optional(),
        topK: z.number().int().positive().max(100).optional(),
        pathPrefix: z.string().optional(),
        tags: z.array(z.string()).optional(),
        groupBy: z.enum(["page", "chunk"]).optional()
      }
    },
    async (input) => {
      const result = await engine.search({
        q: input.query,
        topK: input.topK,
        scope: input.scope,
        pathPrefix: input.pathPrefix,
        tags: input.tags,
        groupBy: input.groupBy
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

  server.registerTool(
    "get_page",
    {
      description:
        "Fetch indexed markdown for a specific path or URL, including frontmatter and routeFile mapping.",
      inputSchema: {
        pathOrUrl: z.string().min(1),
        scope: z.string().optional()
      }
    },
    async (input) => {
      const page = await engine.getPage(input.pathOrUrl, input.scope);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(page, null, 2)
          }
        ]
      };
    }
  );

  server.registerTool(
    "list_pages",
    {
      description:
        "List indexed pages with optional path prefix filtering and cursor-based pagination. Returns url, title, description, and routeFile for each page. Use nextCursor to fetch subsequent pages.",
      inputSchema: {
        pathPrefix: z.string().optional(),
        cursor: z.string().optional(),
        limit: z.number().int().positive().max(200).optional(),
        scope: z.string().optional()
      }
    },
    async (input) => {
      const result = await engine.listPages({
        pathPrefix: input.pathPrefix,
        cursor: input.cursor,
        limit: input.limit,
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

  server.registerTool(
    "find_source_file",
    {
      description:
        "Find the SvelteKit source file for a piece of site content. Use this when you need to locate and edit content on the site. Returns the URL, route file path, section title, and a content snippet.",
      inputSchema: {
        query: z.string().min(1),
        scope: z.string().optional()
      }
    },
    async (input) => {
      const result = await engine.search({
        q: input.query,
        topK: 1,
        scope: input.scope
      });

      if (result.results.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: "No matching content found for the given query."
              })
            }
          ]
        };
      }

      const match = result.results[0]!;
      const { url, routeFile, sectionTitle, snippet } = match;
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ url, routeFile, sectionTitle, snippet })
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
