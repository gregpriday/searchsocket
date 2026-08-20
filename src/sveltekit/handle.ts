import fs from "node:fs/promises";
import nodePath from "node:path";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { loadConfig, mergeConfig } from "../config/load";
import { isServerless } from "../core/serverless";
import { SearchSocketError, toErrorPayload } from "../errors";
import { createServer as createMcpServer, verifyApiKey } from "../mcp/server";
import { SearchEngine } from "../search/engine";
import { toPublicPage, toPublicResults } from "../utils/redact";
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
  let mcpAccess: "public" | "private" = "private";
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
        // `mcp.enable` was documented as the switch for this endpoint but was
        // never read, so the MCP route was mounted regardless — including on
        // deployments that had deliberately turned it off.
        mcpPath = config.mcp.enable ? config.mcp.handle.path : undefined;
        mcpApiKey =
          config.mcp.handle.apiKey ??
          (config.mcp.handle.apiKeyEnv ? process.env[config.mcp.handle.apiKeyEnv] : undefined);
        mcpAccess = config.mcp.handle.access;
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
        return handleMcpRequest(event, mcpAccess, mcpApiKey, mcpEnableJsonResponse, getEngine);
      }
      if (mcpPath) {
        // Config loaded and path matches neither endpoint
        if (serveMarkdownVariants && isMarkdownVariant) {
          // fall through to main body for markdown variant handling
        } else {
          return resolve(event);
        }
      } else {
        // Config not yet loaded, so the MCP path is not known yet. Load it —
        // getConfig() memoizes, so only the first request pays.
        //
        // This used to run only when a config object had been supplied inline.
        // A deployment that passed just `{ path }` and let the config load from
        // disk therefore never learned mcpPath, and every MCP request fell
        // through to the app as an unhandled route.
        try {
          await getConfig();
        } catch {
          // No usable config: this request is not ours to handle.
          return resolve(event);
        }

        if (mcpPath && event.url.pathname === mcpPath) {
          return handleMcpRequest(event, mcpAccess, mcpApiKey, mcpEnableJsonResponse, getEngine);
        }
        if (!(serveMarkdownVariants && isMarkdownVariant)) {
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
      let scope: string | undefined;
      try {
        scope = resolveRequestedScope(event.url.searchParams?.get("scope"), config);
      } catch {
        return resolve(event);
      }
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
      return handleMcpRequest(event, mcpAccess, mcpApiKey, mcpEnableJsonResponse, getEngine);
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
          // RFC 9110 requires Allow on a 405.
          headers: { "content-type": "application/json", allow: "GET, POST, OPTIONS" }
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


/**
 * Resolve the scope a browser request is permitted to search.
 *
 * A caller-supplied `?scope=` used to be passed through unchecked, so any
 * visitor could read a preview, staging, or unpublished branch scope simply by
 * naming it. A scope is now only honoured when the deployment explicitly lists
 * it in `api.allowedScopes`; otherwise the request gets the server's own scope.
 */
function resolveRequestedScope(
  requested: string | null | undefined,
  config: ResolvedSearchSocketConfig
): string | undefined {
  if (requested === null || requested === undefined || requested === "") return undefined;
  if (config.api.allowedScopes.includes(requested)) return requested;

  throw new SearchSocketError(
    "INVALID_REQUEST",
    `Scope "${requested}" is not selectable from this endpoint.`,
    403
  );
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

  const scope = resolveRequestedScope(params.get("scope"), config);
  if (scope !== undefined) searchRequest.scope = scope;

  const pathPrefix = params.get("pathPrefix");
  if (pathPrefix !== null) searchRequest.pathPrefix = pathPrefix;

  const groupBy = params.get("groupBy");
  if (groupBy) {
    if (groupBy !== "page" && groupBy !== "chunk") {
      throw new SearchSocketError("INVALID_REQUEST", 'groupBy must be "page" or "chunk"', 400);
    }
    searchRequest.groupBy = groupBy;
  }

  const maxSubResults = params.get("maxSubResults");
  if (maxSubResults !== null) {
    const parsed = Number.parseInt(maxSubResults, 10);
    if (Number.isNaN(parsed) || parsed < 1 || parsed > 20) {
      throw new SearchSocketError("INVALID_REQUEST", "maxSubResults must be a positive integer between 1 and 20", 400);
    }
    searchRequest.maxSubResults = parsed;
  }

  const tags = params.getAll("tags");
  if (tags.length > 0) searchRequest.tags = tags;

  const engine = await getEngine();
  const result = await engine.search(searchRequest);

  return withCors(
    new Response(JSON.stringify({ ...result, results: toPublicResults(result.results, !config.api.exposeInternalFields) }), {
      status: 200,
      headers: { "content-type": "application/json", "cache-control": "no-store" }
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
      headers: { "content-type": "application/json", "cache-control": "no-store" }
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

  const scope = resolveRequestedScope(event.url.searchParams?.get("scope"), config);
  const engine = await getEngine();
  const result = await engine.getPage(pagePath, scope);

  return withCors(
    new Response(JSON.stringify(toPublicPage(result, !config.api.exposeInternalFields)), {
      status: 200,
      headers: { "content-type": "application/json", "cache-control": "no-store" }
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
  // Require a JSON content type. Without this the endpoint accepts a form
  // POST, which browsers send cross-origin without a preflight — so a CORS
  // policy that denies the origin never gets consulted.
  // The header must be present, not merely non-conflicting. Allowing an absent
  // Content-Type let a browser send JSON bytes as an ArrayBuffer body, which is
  // a simple cross-origin POST and never triggers a preflight — so the CORS
  // policy is not consulted at all.
  const contentType = event.request.headers.get("content-type") ?? "";
  const mediaType = contentType.split(";")[0]!.trim().toLowerCase();
  if (mediaType !== "application/json") {
    throw new SearchSocketError(
      "INVALID_REQUEST",
      "Content-Type must be application/json",
      415
    );
  }

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

  // Reject a non-object body before touching its fields. `null` is valid JSON,
  // and reading `.scope` off it threw a TypeError that surfaced as a 500 where
  // the schema would have produced a 400.
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new SearchSocketError("INVALID_REQUEST", "Request body must be a JSON object", 400);
  }

  const engine = await getEngine();
  const searchRequest = body as SearchRequest;
  // Same scope policy as GET: the body is no more trustworthy than the query
  // string, and previously a POST could name any scope it liked.
  const requestedScope = resolveRequestedScope(searchRequest.scope, config);
  if (requestedScope === undefined) delete searchRequest.scope;
  else searchRequest.scope = requestedScope;

  const result = await engine.search(searchRequest);

  return withCors(
    new Response(JSON.stringify({ ...result, results: toPublicResults(result.results, !config.api.exposeInternalFields) }), {
      status: 200,
      headers: { "content-type": "application/json", "cache-control": "no-store" }
    }),
    event.request,
    config
  );
}

async function handleMcpRequest(
  event: any,
  access: "public" | "private",
  apiKey: string | undefined,
  enableJsonResponse: boolean,
  getEngine: () => Promise<SearchEngine>
): Promise<Response> {
  const method = event.request.method;

  // Only POST is supported — reject GET (SSE streams) and DELETE (session teardown)
  // with 405 so MCP clients stop retrying.
  if (method === "GET") {
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "SSE transport is not supported. Use POST with Streamable HTTP."
        },
        id: null
      }),
      { status: 405, headers: { "content-type": "application/json", allow: "POST" } }
    );
  }

  if (method === "DELETE") {
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Session management is not supported. This server is stateless."
        },
        id: null
      }),
      { status: 405, headers: { "content-type": "application/json", allow: "POST" } }
    );
  }

  // MCP is a privileged surface: its tools return repository paths, a page's
  // indexed markdown, and any scope the caller names — none of which the browser API
  // discloses. It therefore fails closed unless the deployment says otherwise.
  // Previously the auth check was wrapped in `if (apiKey)`, so a deployment
  // that never configured a key — or whose `apiKeyEnv` was unset in production
  // — served all of that to anyone.
  //
  // `mcp.handle.access: "public"` is the deliberate opt-out: an anonymous
  // caller is served, but with the same fields stripped that the browser API
  // already withholds, so what it can reach is the site's published content and
  // nothing more.
  if (!apiKey && access === "private") {
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        error: {
          code: -32001,
          message:
            "MCP endpoint is not configured with an API key. Set mcp.handle.apiKey " +
            "(or mcp.handle.apiKeyEnv) to enable it, set mcp.handle.access: 'public' to serve " +
            "anonymous callers a redacted result set, or set mcp.enable: false to disable the route. " +
            "If the key is set and this still fails under `vite dev`: apiKeyEnv reads process.env, " +
            "which a SvelteKit dev server does not populate from .env. Pass it explicitly instead — " +
            "mcp.handle.apiKey: env.YOUR_KEY from $env/dynamic/private."
        },
        id: null
      }),
      { status: 503, headers: { "content-type": "application/json" } }
    );
  }

  const unauthorized = () =>
    new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32001, message: "Unauthorized" },
        id: null
      }),
      { status: 401, headers: { "content-type": "application/json" } }
    );

  // A caller that sent no Authorization header at all is anonymous. One that
  // sent a header is attempting to authenticate, so a wrong or malformed
  // credential is a 401 even under public access — a misconfigured editing
  // agent should be told its key is bad, not quietly downgraded to the public
  // result set and left wondering where `routeFile` went.
  const authHeader: string | null = event.request.headers.get("authorization");
  let isAnonymous = false;

  if (authHeader === null) {
    if (access === "private") return unauthorized();
    isAnonymous = true;
  } else {
    if (!apiKey) return unauthorized();
    if (!authHeader.startsWith("Bearer ")) return unauthorized();

    const token = authHeader.slice(7);
    // `verifyApiKey` hashes both sides to equal-length digests before
    // comparing, so an attacker cannot learn the key's length from how long a
    // rejection takes — the previous inline length check leaked exactly that.
    if (token.length === 0 || !verifyApiKey(token, apiKey)) return unauthorized();
  }

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse
  });

  let server: { close(): Promise<void> } | undefined;

  try {
    const engine = await getEngine();
    server = createMcpServer(engine, { redact: isAnonymous });

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
          // Not the raw exception: transport failures can surface internal
          // paths and configuration detail to the client.
          message: "Internal server error"
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

  const wildcard = allowOrigins.includes("*");
  return {
    "access-control-allow-origin": wildcard ? "*" : origin,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    // Required when the origin is reflected: without it a shared cache can
    // serve one origin's allow-origin header to a different origin.
    ...(wildcard ? {} : { vary: "Origin" })
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
