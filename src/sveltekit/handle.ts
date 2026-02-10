import { loadConfig } from "../config/load";
import { SearchSocketError, toErrorPayload } from "../errors";
import { SearchEngine } from "../search/engine";
import type { ResolvedSearchSocketConfig } from "../types";

interface RateBucket {
  count: number;
  resetAt: number;
}

/**
 * Simple in-memory rate limiter. Effective for long-lived Node.js processes
 * (e.g. SvelteKit with adapter-node). In serverless environments (Vercel,
 * Netlify, Cloudflare Workers), memory is not shared between invocations and
 * this limiter will reset on each cold start. For serverless deployments, use
 * your platform's built-in WAF or edge rate-limiting instead.
 */
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
  /** Pass a pre-resolved config object to avoid filesystem loading at runtime. */
  config?: ResolvedSearchSocketConfig;
}

export function searchsocketHandle(options: SearchSocketHandleOptions = {}) {
  let enginePromise: Promise<SearchEngine> | null = null;
  let configPromise: Promise<ResolvedSearchSocketConfig> | null = null;
  let apiPath = options.path;
  let rateLimiter: InMemoryRateLimiter | null = null;

  const getConfig = async (): Promise<ResolvedSearchSocketConfig> => {
    if (!configPromise) {
      const configP = options.config
        ? Promise.resolve(options.config)
        : loadConfig({
            cwd: options.cwd,
            configPath: options.configPath
          });

      configPromise = configP.then((config) => {
        apiPath = apiPath ?? config.api.path;

        if (config.api.rateLimit) {
          rateLimiter = new InMemoryRateLimiter(config.api.rateLimit.windowMs, config.api.rateLimit.max);
        }

        return config;
      });
    }

    return configPromise;
  };

  const getEngine = async (): Promise<SearchEngine> => {
    if (!enginePromise) {
      const config = options.config;
      enginePromise = SearchEngine.create({
        cwd: options.cwd,
        configPath: options.configPath,
        config
      });
    }

    return enginePromise;
  };

  const bodyLimit = options.maxBodyBytes ?? 64 * 1024;

  return async ({ event, resolve }: { event: any; resolve: (event: any) => Promise<Response> }) => {
    const config = await getConfig();
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
      const body = await event.request.json();
      const engine = await getEngine();
      const result = await engine.search(body);

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
