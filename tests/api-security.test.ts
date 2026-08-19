import { afterEach, describe, expect, it, vi } from "vitest";
import { searchsocketHandle } from "../src/sveltekit/handle";
import { SearchEngine } from "../src/search/engine";
import { createDefaultConfig } from "../src/config/defaults";
import type { ResolvedSearchSocketConfig, SearchResponse } from "../src/types";

/**
 * Release-blocking invariant: a browser request may not choose which scope it
 * reads, and a public search response does not disclose repository paths or
 * full page content.
 *
 * `?scope=` used to be passed straight through, so any visitor could read a
 * preview or staging scope by naming it, and every result carried `routeFile`
 * (a path inside the author's repo) plus `chunkText` (the section in full).
 */

afterEach(() => {
  vi.restoreAllMocks();
});

function makeConfig(overrides: Partial<ResolvedSearchSocketConfig> = {}): ResolvedSearchSocketConfig {
  const config = createDefaultConfig("api-security-test");
  return { ...config, ...overrides, api: { ...config.api, ...(overrides.api ?? {}) } };
}

function makeEvent(opts: {
  pathname: string;
  method: string;
  searchParams?: Record<string, string>;
  body?: unknown;
  headers?: Record<string, string>;
}) {
  const url = new URL(`https://site.example${opts.pathname}`);
  for (const [key, value] of Object.entries(opts.searchParams ?? {})) {
    url.searchParams.set(key, value);
  }

  const headers = new Headers(opts.headers ?? {});
  if (opts.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  return {
    url,
    request: {
      method: opts.method,
      headers,
      // Preserves an explicit `null` rather than coercing it to `{}` — null is
      // valid JSON and the handler must reject it as a 400, not crash.
      text: async () => JSON.stringify(opts.body === undefined ? {} : opts.body),
      json: async () => (opts.body === undefined ? {} : opts.body)
    } as unknown as Request
  };
}

const SAMPLE_RESPONSE: SearchResponse = {
  q: "test",
  scope: "main",
  results: [
    {
      url: "/docs/auth",
      title: "Auth",
      snippet: "A snippet.",
      score: 0.9,
      routeFile: "src/routes/docs/auth/+page.svelte",
      chunkText: "The complete text of this section, verbatim.",
      chunks: [
        {
          sectionTitle: "Tokens",
          snippet: "A snippet.",
          chunkText: "The complete text of the Tokens section.",
          headingPath: ["Auth", "Tokens"],
          score: 0.8
        }
      ]
    }
  ],
  meta: { timingsMs: { search: 1, total: 2 } }
};

function stubEngine(search = vi.fn().mockResolvedValue(SAMPLE_RESPONSE)) {
  vi.spyOn(SearchEngine, "create").mockResolvedValue({
    search,
    getPage: vi.fn()
  } as unknown as SearchEngine);
  return search;
}

describe("scope access policy", () => {
  it("ignores a caller-supplied scope by default", async () => {
    const search = stubEngine();
    const handle = searchsocketHandle({ config: makeConfig() });
    const resolve = vi.fn().mockResolvedValue(new Response("ok"));

    const response = await handle({
      event: makeEvent({
        pathname: "/api/search",
        method: "GET",
        searchParams: { q: "test", scope: "staging" }
      }),
      resolve
    });

    expect(response.status).toBe(403);
    expect(search).not.toHaveBeenCalled();
  });

  it("rejects a scope in a POST body too", async () => {
    // The body is no more trustworthy than the query string.
    const search = stubEngine();
    const handle = searchsocketHandle({ config: makeConfig() });
    const resolve = vi.fn().mockResolvedValue(new Response("ok"));

    const response = await handle({
      event: makeEvent({
        pathname: "/api/search",
        method: "POST",
        body: { q: "test", scope: "staging" }
      }),
      resolve
    });

    expect(response.status).toBe(403);
    expect(search).not.toHaveBeenCalled();
  });

  it("honours a scope the deployment explicitly allowed", async () => {
    const search = stubEngine();
    const handle = searchsocketHandle({
      config: makeConfig({ api: { allowedScopes: ["staging"] } } as Partial<ResolvedSearchSocketConfig>)
    });
    const resolve = vi.fn().mockResolvedValue(new Response("ok"));

    await handle({
      event: makeEvent({
        pathname: "/api/search",
        method: "GET",
        searchParams: { q: "test", scope: "staging" }
      }),
      resolve
    });

    expect(search).toHaveBeenCalledWith(expect.objectContaining({ scope: "staging" }));
  });

  it("searches the server's own scope when none is requested", async () => {
    const search = stubEngine();
    const handle = searchsocketHandle({ config: makeConfig() });
    const resolve = vi.fn().mockResolvedValue(new Response("ok"));

    await handle({
      event: makeEvent({ pathname: "/api/search", method: "GET", searchParams: { q: "test" } }),
      resolve
    });

    expect(search.mock.calls[0]![0]).not.toHaveProperty("scope");
  });
});

describe("public versus privileged fields", () => {
  async function searchAndParse(config: ResolvedSearchSocketConfig) {
    stubEngine();
    const handle = searchsocketHandle({ config });
    const resolve = vi.fn().mockResolvedValue(new Response("ok"));
    const response = await handle({
      event: makeEvent({ pathname: "/api/search", method: "GET", searchParams: { q: "test" } }),
      resolve
    });
    return (await response.json()) as SearchResponse;
  }

  it("omits repository paths and full section text by default", async () => {
    const body = await searchAndParse(makeConfig());
    const [result] = body.results;

    expect(result!.routeFile).toBeUndefined();
    expect(result!.chunkText).toBeUndefined();
    expect(result!.chunks![0]!.chunkText).toBeUndefined();
    // The snippet is what a search box needs, and it survives.
    expect(result!.snippet).toBe("A snippet.");
    expect(result!.url).toBe("/docs/auth");
  });

  it("includes them when the deployment opts in", async () => {
    const body = await searchAndParse(
      makeConfig({ api: { exposeInternalFields: true } } as Partial<ResolvedSearchSocketConfig>)
    );
    const [result] = body.results;

    expect(result!.routeFile).toBe("src/routes/docs/auth/+page.svelte");
    expect(result!.chunkText).toContain("verbatim");
  });
});

describe("request hardening", () => {
  it("rejects a POST that is not JSON", async () => {
    // A form POST is sent cross-origin without a preflight, so a CORS policy
    // that denies the origin is never consulted.
    stubEngine();
    const handle = searchsocketHandle({ config: makeConfig() });
    const resolve = vi.fn().mockResolvedValue(new Response("ok"));

    const response = await handle({
      event: makeEvent({
        pathname: "/api/search",
        method: "POST",
        body: { q: "test" },
        headers: { "content-type": "application/x-www-form-urlencoded" }
      }),
      resolve
    });

    expect(response.status).toBe(415);
  });

  it("rejects a POST with no content type at all", async () => {
    // `if (mediaType && ...)` let an absent header through, so JSON bytes sent
    // as an ArrayBuffer body were a simple cross-origin POST — no preflight,
    // so the CORS policy was never consulted.
    stubEngine();
    const handle = searchsocketHandle({ config: makeConfig() });
    const resolve = vi.fn().mockResolvedValue(new Response("ok"));

    const url = new URL("https://site.example/api/search");
    const response = await handle({
      event: {
        url,
        request: {
          method: "POST",
          headers: new Headers(),
          text: async () => JSON.stringify({ q: "test" }),
          json: async () => ({ q: "test" })
        } as unknown as Request
      },
      resolve
    });

    expect(response.status).toBe(415);
  });

  it("returns 400, not 500, for a JSON body of null", async () => {
    stubEngine();
    const handle = searchsocketHandle({ config: makeConfig() });
    const resolve = vi.fn().mockResolvedValue(new Response("ok"));

    const response = await handle({
      event: makeEvent({ pathname: "/api/search", method: "POST", body: null }),
      resolve
    });

    expect(response.status).toBe(400);
  });

  it("accepts application/json with a charset parameter", async () => {
    const search = stubEngine();
    const handle = searchsocketHandle({ config: makeConfig() });
    const resolve = vi.fn().mockResolvedValue(new Response("ok"));

    const response = await handle({
      event: makeEvent({
        pathname: "/api/search",
        method: "POST",
        body: { q: "test" },
        headers: { "content-type": "application/json; charset=utf-8" }
      }),
      resolve
    });

    expect(response.status).toBe(200);
    expect(search).toHaveBeenCalled();
  });

  it("marks search responses uncacheable", async () => {
    stubEngine();
    const handle = searchsocketHandle({ config: makeConfig() });
    const resolve = vi.fn().mockResolvedValue(new Response("ok"));

    const response = await handle({
      event: makeEvent({ pathname: "/api/search", method: "GET", searchParams: { q: "test" } }),
      resolve
    });

    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("names the permitted methods on a 405", async () => {
    stubEngine();
    const handle = searchsocketHandle({ config: makeConfig() });
    const resolve = vi.fn().mockResolvedValue(new Response("ok"));

    const response = await handle({
      event: makeEvent({ pathname: "/api/search", method: "DELETE" }),
      resolve
    });

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toContain("GET");
  });

  it("sets Vary: Origin when reflecting an allowed origin", async () => {
    // Without it a shared cache can hand one origin's allow-origin header to
    // a different origin.
    stubEngine();
    const handle = searchsocketHandle({
      config: makeConfig({
        api: { cors: { allowOrigins: ["https://app.example"] } }
      } as Partial<ResolvedSearchSocketConfig>)
    });
    const resolve = vi.fn().mockResolvedValue(new Response("ok"));

    const response = await handle({
      event: makeEvent({
        pathname: "/api/search",
        method: "GET",
        searchParams: { q: "test" },
        headers: { origin: "https://app.example" }
      }),
      resolve
    });

    expect(response.headers.get("access-control-allow-origin")).toBe("https://app.example");
    expect(response.headers.get("vary")).toBe("Origin");
  });
});

describe("page retrieval does not disclose repository paths", () => {
  it("strips routeFile from the page response by default", async () => {
    vi.spyOn(SearchEngine, "create").mockResolvedValue({
      search: vi.fn(),
      getPage: vi.fn().mockResolvedValue({
        url: "/docs/auth",
        markdown: "# Auth",
        frontmatter: { title: "Auth", routeFile: "src/routes/docs/auth/+page.svelte" }
      })
    } as unknown as SearchEngine);

    const handle = searchsocketHandle({ config: makeConfig() });
    const resolve = vi.fn().mockResolvedValue(new Response("ok"));
    const response = await handle({
      event: makeEvent({ pathname: "/api/search/pages/docs/auth", method: "GET" }),
      resolve
    });

    const body = (await response.json()) as { frontmatter: Record<string, unknown> };
    expect(body.frontmatter.routeFile).toBeUndefined();
    expect(body.frontmatter.title).toBe("Auth");
  });
});
