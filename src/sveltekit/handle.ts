import { timingSafeEqual } from "node:crypto";
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
  let serveMarkdownVariants = false;
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
          serveMarkdownVariants = config.llmsTxt.serveMarkdownVariants;
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
    if (apiPath && !isApiPath(event.url.pathname, apiPath) && event.url.pathname !== llmsServePath) {
      const isMarkdownVariant = event.request.method === "GET" && event.url.pathname.endsWith(".md");

      if (mcpPath && event.url.pathname === mcpPath) {
        return handleMcpRequest(event, mcpApiKey, mcpEnableJsonResponse, getEngine);
      }
      if (mcpPath) {
        // Config loaded and path matches neither endpoint
        if (serveMarkdownVariants && isMarkdownVariant) {
          // fall through to main body for markdown variant handling
        } else {
          return resolve(event);
        }
      } else {
        // Config not yet loaded — if config is pending or available, resolve to learn mcpPath
        if (configPromise || options.config || options.rawConfig) {
          await getConfig();
          if (mcpPath && event.url.pathname === mcpPath) {
            return handleMcpRequest(event, mcpApiKey, mcpEnableJsonResponse, getEngine);
          }
          if (!(serveMarkdownVariants && isMarkdownVariant)) {
            return resolve(event);
          }
        } else {
          return resolve(event);
        }
      }
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

    // Serve markdown variant of indexed pages (e.g. /docs/api.md → markdown for /docs/api)
    if (serveMarkdownVariants && event.request.method === "GET" && event.url.pathname.endsWith(".md")) {
      let rawPath: string;
      try {
        rawPath = decodeURIComponent(event.url.pathname.slice(0, -3));
      } catch {
        return resolve(event);
      }
      const scope = event.url.searchParams?.get("scope") ?? undefined;
      try {
        const engine = await getEngine();
        const page = await engine.getPage(rawPath, scope);
        return new Response(page.markdown, {
          status: 200,
          headers: { "content-type": "text/markdown; charset=utf-8" }
        });
      } catch (error) {
        if (error instanceof SearchSocketError && error.status === 404) {
          return resolve(event);
        }
        throw error;
      }
    }

    // MCP endpoint handling
    if (mcpPath && event.url.pathname === mcpPath) {
      return handleMcpRequest(event, mcpApiKey, mcpEnableJsonResponse, getEngine);
    }
    const targetPath = apiPath ?? config.api.path;

    if (!isApiPath(event.url.pathname, targetPath)) {
      return resolve(event);
    }

    const subPath = event.url.pathname.slice(targetPath.length); // "" | "/health" | "/pages/..."
    const method = event.request.method;

    if (method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: buildCorsHeaders(event.request, config)
      });
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
      if (method === "GET") {
        if (subPath === "" || subPath === "/") {
          return await handleGetSearch(event, config, getEngine);
        }
        if (subPath === "/health") {
          return await handleGetHealth(event, config, getEngine);
        }
        if (subPath.startsWith("/pages/")) {
          return await handleGetPage(event, config, getEngine, subPath);
        }
        // Unknown GET sub-route
        return withCors(
          new Response(JSON.stringify(toErrorPayload(new SearchSocketError("INVALID_REQUEST", "Not found", 404))), {
            status: 404,
            headers: { "content-type": "application/json" }
          }),
          event.request,
          config
        );
      }

      if (method === "POST" && (subPath === "" || subPath === "/")) {
        return await handlePostSearch(event, config, getEngine, bodyLimit);
      }

      // Unsupported method or sub-route
      return withCors(
        new Response(JSON.stringify(toErrorPayload(new SearchSocketError("INVALID_REQUEST", "Method not allowed", 405))), {
          status: 405,
          headers: { "content-type": "application/json" }
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

function isApiPath(pathname: string, apiPath: string): boolean {
  return pathname === apiPath || pathname.startsWith(apiPath + "/");
}

async function handleGetSearch(
  event: any,
  config: ResolvedSearchSocketConfig,
  getEngine: () => Promise<SearchEngine>
): Promise<Response> {
  const params = event.url.searchParams;
  const q = params.get("q");

  if (!q || q.trim() === "") {
    throw new SearchSocketError("INVALID_REQUEST", "Missing required query parameter: q", 400);
  }

  const searchRequest: SearchRequest = { q };

  const topK = params.get("topK");
  if (topK !== null) {
    const parsed = Number.parseInt(topK, 10);
    if (Number.isNaN(parsed) || parsed < 1) {
      throw new SearchSocketError("INVALID_REQUEST", "topK must be a positive integer", 400);
    }
    searchRequest.topK = parsed;
  }

  const scope = params.get("scope");
  if (scope !== null) searchRequest.scope = scope;

  const pathPrefix = params.get("pathPrefix");
  if (pathPrefix !== null) searchRequest.pathPrefix = pathPrefix;

  const groupBy = params.get("groupBy");
  if (groupBy) {
    if (groupBy !== "page" && groupBy !== "chunk") {
      throw new SearchSocketError("INVALID_REQUEST", 'groupBy must be "page" or "chunk"', 400);
    }
    searchRequest.groupBy = groupBy;
  }

  const tags = params.getAll("tags");
  if (tags.length > 0) searchRequest.tags = tags;

  const engine = await getEngine();
  const result = await engine.search(searchRequest);

  return withCors(
    new Response(JSON.stringify(result), {
      status: 200,
      headers: { "content-type": "application/json" }
    }),
    event.request,
    config
  );
}

async function handleGetHealth(
  event: any,
  config: ResolvedSearchSocketConfig,
  getEngine: () => Promise<SearchEngine>
): Promise<Response> {
  const engine = await getEngine();
  const result = await engine.health();

  return withCors(
    new Response(JSON.stringify(result), {
      status: 200,
      headers: { "content-type": "application/json" }
    }),
    event.request,
    config
  );
}

async function handleGetPage(
  event: any,
  config: ResolvedSearchSocketConfig,
  getEngine: () => Promise<SearchEngine>,
  subPath: string
): Promise<Response> {
  const rawPath = subPath.slice("/pages".length); // includes leading "/"
  let pagePath: string;
  try {
    pagePath = decodeURIComponent(rawPath);
  } catch {
    throw new SearchSocketError("INVALID_REQUEST", "Malformed page path", 400);
  }

  const scope = event.url.searchParams?.get("scope") ?? undefined;
  const engine = await getEngine();
  const result = await engine.getPage(pagePath, scope);

  return withCors(
    new Response(JSON.stringify(result), {
      status: 200,
      headers: { "content-type": "application/json" }
    }),
    event.request,
    config
  );
}

async function handlePostSearch(
  event: any,
  config: ResolvedSearchSocketConfig,
  getEngine: () => Promise<SearchEngine>,
  bodyLimit: number
): Promise<Response> {
  const contentLength = Number(event.request.headers.get("content-length") ?? 0);
  if (contentLength > bodyLimit) {
    throw new SearchSocketError("INVALID_REQUEST", "Request body too large", 413);
  }

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
      headers: { "content-type": "application/json" }
    }),
    event.request,
    config
  );
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
    const tokenBuf = Buffer.from(token);
    const keyBuf = Buffer.from(apiKey);
    if (tokenBuf.length !== keyBuf.length || !timingSafeEqual(tokenBuf, keyBuf)) {
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

  let server: { close(): Promise<void> } | undefined;

  try {
    const engine = await getEngine();
    server = createMcpServer(engine);

    await (server as ReturnType<typeof createMcpServer>).connect(transport);
    const response = await transport.handleRequest(event.request);

    if (enableJsonResponse) {
      // JSON mode: response is complete, clean up immediately
      await transport.close();
      await server.close();
    }
    // SSE mode: response body is a ReadableStream — transport and server
    // will be garbage collected when the stream ends. Closing early would
    // terminate the stream before the client receives data.

    return response;
  } catch (error) {
    try { await transport.close(); } catch {}
    try { await server?.close(); } catch {}

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
    "access-control-allow-methods": "GET, POST, OPTIONS",
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
