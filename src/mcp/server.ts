import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import type { Request, Response } from "express";
import { z } from "zod";
import { SearchEngine } from "../search/engine";
import type { ResolvedSearchSocketConfig } from "../types";

export interface McpServerOptions {
  cwd?: string;
  configPath?: string;
  transport?: "stdio" | "http";
  httpPort?: number;
  httpPath?: string;
}

function createServer(engine: SearchEngine): McpServer {
  const server = new McpServer({
    name: "searchsocket-mcp",
    version: "0.1.0"
  });

  server.registerTool(
    "search",
    {
      description:
        "Semantic site search. Returns url/title/snippet/score/routeFile for each match. Supports optional scope, pathPrefix, tags, and topK.",
      inputSchema: {
        query: z.string().min(1),
        scope: z.string().optional(),
        topK: z.number().int().positive().max(100).optional(),
        pathPrefix: z.string().optional(),
        tags: z.array(z.string()).optional()
      }
    },
    async (input) => {
      const result = await engine.search({
        q: input.query,
        topK: input.topK,
        scope: input.scope,
        pathPrefix: input.pathPrefix,
        tags: input.tags
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

  return server;
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

  app.post(endpointPath, async (req: Request, res: Response) => {
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
    const instance = app.listen(port, "127.0.0.1", () => {
      process.stdout.write(`SearchSocket MCP HTTP server listening on http://127.0.0.1:${port}${endpointPath}\n`);
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
  const engine = await SearchEngine.create({
    cwd: options.cwd,
    configPath: options.configPath
  });
  const config = engine.getConfig();

  const transport = options.transport ?? config.mcp.transport;

  if (transport === "http") {
    await startHttpServer(() => createServer(engine), config, options);
    return;
  }

  redirectConsoleToStderr();
  const server = createServer(engine);
  const stdioTransport = new StdioServerTransport();
  await server.connect(stdioTransport);
}
