import fs from "node:fs/promises";
import nodePath from "node:path";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { loadConfig, mergeConfig } from "../config/load";
import { isServerless } from "../core/serverless";
import { SearchSocketError, toErrorPayload } from "../errors";
import { createServer as createMcpServer } from "../mcp/server";
import { SearchEngine } from "../search/engine";
import type { ResolvedSearchSocketConfig, SearchRequest, SearchSocketConfig } from "../types";

interface RateBucket {
  count: number;
  resetAt: number;
}

class InMemoryRateLimiter {
  private readonly buckets = new Map<string, RateBucket>();

  constructor(private readonly windowMs: number, private readonly max: number) {}

  check(key: string): boolean {
    const now = Date.now();
    const existing = this.buckets.get(key);

    if (!existing || existing.resetAt <= now) {
      this.buckets.set(key, {
        count: 1,
        resetAt: now + this.windowMs
      });
      return true;
    }

    if (existing.count >= this.max) {
      return false;
    }

    existing.count += 1;
    return true;
  }
}

export interface SearchSocketHandleOptions {
  configPath?: string;
  cwd?: string;
  path?: string;
  maxBodyBytes?: number;
  config?: ResolvedSearchSocketConfig;
  rawConfig?: SearchSocketConfig;
}

export function searchsocketHandle(options: SearchSocketHandleOptions = {}) {
  let enginePromise: Promise<SearchEngine> | null = null;
  let configPromise: Promise<ResolvedSearchSocketConfig> | null = null;
  let apiPath = options.path;
  let llmsServePath: string | null = null;
  let mcpPath: string | undefined;
  let mcpApiKey: string | undefined;
  let mcpEnableJsonResponse = true;
  let rateLimiter: InMemoryRateLimiter | null = null;
  let notConfigured = false;

  const getConfig = async (): Promise<ResolvedSearchSocketConfig> => {
    if (!configPromise) {
      let configP: Promise<ResolvedSearchSocketConfig>;

      if (options.config) {
        configP = Promise.resolve(options.config);
      } else if (options.rawConfig) {
        const cwd = options.cwd ?? process.cwd();
        configP = Promise.resolve(mergeConfig(cwd, options.rawConfig));
      } else {
        configP = loadConfig({
          cwd: options.cwd,
          configPath: options.configPath
        });
      }

      configPromise = configP.then((config) => {
        apiPath = apiPath ?? config.api.path;
        mcpPath = config.mcp.handle.path;
        mcpApiKey = config.mcp.handle.apiKey;
        mcpEnableJsonResponse = config.mcp.handle.enableJsonResponse;

        if (config.llmsTxt.enable) {
          llmsServePath = "/" + config.llmsTxt.outputPath.replace(/^static\//, "");
        }

        if (config.api.rateLimit && !isServerless()) {
          rateLimiter = new InMemoryRateLimiter(config.api.rateLimit.windowMs, config.api.rateLimit.max);
        }

        return config;
      });
    }

    return configPromise;
  };

  const getEngine = async (): Promise<SearchEngine> => {
    if (notConfigured) {
      throw new SearchSocketError(
        "SEARCH_NOT_CONFIGURED",
        "Search is not configured. Set the required Upstash environment variables to enable search.",
        503
      );
    }

    if (!enginePromise) {
      const config = await getConfig();
      enginePromise = SearchEngine.create({
        cwd: options.cwd,
        config
      }).catch((error) => {
        enginePromise = null;
        if (error instanceof SearchSocketError && error.code === "VECTOR_BACKEND_UNAVAILABLE") {
          notConfigured = true;
          throw new SearchSocketError(
            "SEARCH_NOT_CONFIGURED",
            "Search is not configured. Set the required Upstash environment variables to enable search.",
            503
          );
        }
        throw error;
      });
    }

    return enginePromise;
  };

  const bodyLimit = options.maxBodyBytes ?? 64 * 1024;

  return async ({ event, resolve }: { event: any; resolve: (event: any) => Promise<Response> }) => {
    if (apiPath && event.url.pathname !== apiPath && event.url.pathname !== llmsServePath) {
      // If config is loaded, also check MCP path before bailing
      if (mcpPath && event.url.pathname === mcpPath) {
        return handleMcpRequest(event, mcpApiKey, mcpEnableJsonResponse, getEngine);
      }
      if (mcpPath || !configPromise) {
        return resolve(event);
      }
      // Config is pending — need to resolve to learn mcpPath
      await getConfig();
      if (mcpPath && event.url.pathname === mcpPath) {
        return handleMcpRequest(event, mcpApiKey, mcpEnableJsonResponse, getEngine);
      }
      return resolve(event);
    }

    const config = await getConfig();

    // Serve llms.txt if enabled and the file exists
    if (llmsServePath && event.request.method === "GET" && event.url.pathname === llmsServePath) {
      const cwd = options.cwd ?? process.cwd();
      const filePath = nodePath.resolve(cwd, config.llmsTxt.outputPath);
      try {
        const content = await fs.readFile(filePath, "utf8");
        return new Response(content, {
          status: 200,
          headers: { "content-type": "text/plain; charset=utf-8" }
        });
      } catch {
        return resolve(event);
      }
    }

    // MCP endpoint handling
    if (mcpPath && event.url.pathname === mcpPath) {
      return handleMcpRequest(event, mcpApiKey, mcpEnableJsonResponse, getEngine);
    }
    const targetPath = apiPath ?? config.api.path;

    if (event.url.pathname !== targetPath) {
      return resolve(event);
    }

    if (event.request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: buildCorsHeaders(event.request, config)
      });
    }

    if (event.request.method !== "POST") {
      return withCors(
        new Response(JSON.stringify(toErrorPayload(new SearchSocketError("INVALID_REQUEST", "Method not allowed", 405))), {
          status: 405,
          headers: {
            "content-type": "application/json"
          }
        }),
        event.request,
        config
      );
    }

    const contentLength = Number(event.request.headers.get("content-length") ?? 0);
    if (contentLength > bodyLimit) {
      return withCors(
        new Response(
          JSON.stringify(toErrorPayload(new SearchSocketError("INVALID_REQUEST", "Request body too large", 413))),
          {
            status: 413,
            headers: {
              "content-type": "application/json"
            }
          }
        ),
        event.request,
        config
      );
    }

    if (rateLimiter) {
      const ip =
        event.getClientAddress?.() ??
        event.request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
        "unknown";

      if (!rateLimiter.check(ip)) {
        return withCors(
          new Response(
            JSON.stringify(toErrorPayload(new SearchSocketError("RATE_LIMITED", "Rate limit exceeded", 429))),
            {
              status: 429,
              headers: {
                "content-type": "application/json"
              }
            }
          ),
          event.request,
          config
        );
      }
    }

    try {
      let rawBody: string;
      if (typeof event.request.text === "function") {
        rawBody = await event.request.text();
      } else {
        let parsedFallback: unknown;
        try {
          parsedFallback = await event.request.json();
        } catch (error) {
          if (error instanceof SyntaxError) {
            throw new SearchSocketError("INVALID_REQUEST", "Malformed JSON request body", 400);
          }
          throw error;
        }
        rawBody = JSON.stringify(parsedFallback);
      }

      if (Buffer.byteLength(rawBody, "utf8") > bodyLimit) {
        throw new SearchSocketError("INVALID_REQUEST", "Request body too large", 413);
      }

      let body: unknown;
      try {
        body = JSON.parse(rawBody);
      } catch {
        throw new SearchSocketError("INVALID_REQUEST", "Malformed JSON request body", 400);
      }

      const engine = await getEngine();
      const searchRequest = body as SearchRequest;

      const result = await engine.search(searchRequest);

      return withCors(
        new Response(JSON.stringify(result), {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        }),
        event.request,
        config
      );
    } catch (error) {
      const payload = toErrorPayload(error);
      const status = error instanceof SearchSocketError ? error.status : 500;

      return withCors(
        new Response(JSON.stringify(payload), {
          status,
          headers: {
            "content-type": "application/json"
          }
        }),
        event.request,
        config
      );
    }
  };
}

async function handleMcpRequest(
  event: any,
  apiKey: string | undefined,
  enableJsonResponse: boolean,
  getEngine: () => Promise<SearchEngine>
): Promise<Response> {
  // Auth check
  if (apiKey) {
    const authHeader = event.request.headers.get("authorization") ?? "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (token !== apiKey) {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32001, message: "Unauthorized" },
          id: null
        }),
        { status: 401, headers: { "content-type": "application/json" } }
      );
    }
  }

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse
  });

  try {
    const engine = await getEngine();
    const server = createMcpServer(engine);

    await server.connect(transport);
    const response = await transport.handleRequest(event.request);

    // Clean up after response is created
    await transport.close();
    await server.close();

    return response;
  } catch (error) {
    try { await transport.close(); } catch {}

    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        error: {
          code: -32603,
          message: error instanceof Error ? error.message : "Internal server error"
        },
        id: null
      }),
      { status: 500, headers: { "content-type": "application/json" } }
    );
  }
}

function buildCorsHeaders(request: Request, config: ResolvedSearchSocketConfig): Record<string, string> {
  const allowOrigins = config.api.cors.allowOrigins;
  if (!allowOrigins || allowOrigins.length === 0) {
    return {};
  }

  const origin = request.headers.get("origin") ?? "";
  const allowed = allowOrigins.includes("*") || allowOrigins.includes(origin);

  if (!allowed) {
    return {};
  }

  return {
    "access-control-allow-origin": allowOrigins.includes("*") ? "*" : origin,
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type"
  };
}

function withCors(response: Response, request: Request, config: ResolvedSearchSocketConfig): Response {
  const corsHeaders = buildCorsHeaders(request, config);

  if (Object.keys(corsHeaders).length === 0) {
    return response;
  }

  const merged = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders)) {
    merged.set(key, value);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: merged
  });
}
