import { afterEach, describe, expect, it, vi } from "vitest";
import { searchsocketHandle } from "../src/sveltekit/handle";
import { createDefaultConfig } from "../src/config/defaults";
import { SearchEngine } from "../src/search/engine";
import { SearchSocketError } from "../src/errors";
import type { ResolvedSearchSocketConfig, SearchResponse, StreamSearchEvent } from "../src/types";

function makeConfig(overrides: Partial<ResolvedSearchSocketConfig> = {}): ResolvedSearchSocketConfig {
  const base = createDefaultConfig("test");
  return {
    ...base,
    ...overrides,
    api: {
      ...base.api,
      ...overrides.api,
      cors: {
        ...base.api.cors,
        ...overrides.api?.cors
      }
    }
  } as ResolvedSearchSocketConfig;
}

function makeEvent(options: {
  pathname: string;
  method: string;
  body?: object;
  headers?: Record<string, string>;
}) {
  const headers = new Headers(options.headers);
  const bodyStr = options.body ? JSON.stringify(options.body) : "";

  return {
    url: { pathname: options.pathname },
    request: {
      method: options.method,
      headers,
      json: async () => options.body,
      text: async () => bodyStr
    },
    getClientAddress: () => "127.0.0.1"
  };
}

function makeSearchResponse(q: string): SearchResponse {
  return {
    q,
    scope: "main",
    results: [
      {
        url: "/docs/intro",
        title: "Intro",
        snippet: "Welcome",
        score: 0.9,
        routeFile: "src/routes/docs/intro/+page.svelte"
      }
    ],
    meta: {
      timingsMs: { embed: 10, vector: 20, rerank: 0, total: 30 },
      usedRerank: false,
      modelId: "jina-embeddings-v3"
    }
  };
}

async function readNdjsonStream(response: Response): Promise<unknown[]> {
  const text = await response.text();
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("handle streaming (NDJSON)", () => {
  it("returns application/x-ndjson content-type when stream + rerank", async () => {
    const config = makeConfig();

    const initialResponse = makeSearchResponse("test");
    const rerankedResponse = { ...makeSearchResponse("test"), meta: { ...makeSearchResponse("test").meta, usedRerank: true, timingsMs: { embed: 10, vector: 20, rerank: 50, total: 80 } } };

    async function* fakeStreaming() {
      yield { phase: "initial" as const, data: initialResponse };
      yield { phase: "reranked" as const, data: rerankedResponse };
    }

    vi.spyOn(SearchEngine, "create").mockResolvedValue({
      search: vi.fn(),
      searchStreaming: vi.fn().mockReturnValue(fakeStreaming())
    } as unknown as SearchEngine);

    const handle = searchsocketHandle({ config });
    const resolve = vi.fn().mockResolvedValue(new Response("ok"));

    const response = await handle({
      event: makeEvent({
        pathname: "/api/search",
        method: "POST",
        body: { q: "test", stream: true, rerank: true }
      }),
      resolve
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/x-ndjson");

    const events = await readNdjsonStream(response);
    expect(events).toHaveLength(2);
    expect((events[0] as { phase: string }).phase).toBe("initial");
    expect((events[1] as { phase: string }).phase).toBe("reranked");
  });

  it("returns standard JSON when stream is true but rerank is false", async () => {
    const config = makeConfig();

    vi.spyOn(SearchEngine, "create").mockResolvedValue({
      search: vi.fn().mockResolvedValue(makeSearchResponse("test"))
    } as unknown as SearchEngine);

    const handle = searchsocketHandle({ config });
    const resolve = vi.fn().mockResolvedValue(new Response("ok"));

    const response = await handle({
      event: makeEvent({
        pathname: "/api/search",
        method: "POST",
        body: { q: "test", stream: true, rerank: false }
      }),
      resolve
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
  });

  it("returns standard JSON when stream is absent", async () => {
    const config = makeConfig();

    vi.spyOn(SearchEngine, "create").mockResolvedValue({
      search: vi.fn().mockResolvedValue(makeSearchResponse("test"))
    } as unknown as SearchEngine);

    const handle = searchsocketHandle({ config });
    const resolve = vi.fn().mockResolvedValue(new Response("ok"));

    const response = await handle({
      event: makeEvent({
        pathname: "/api/search",
        method: "POST",
        body: { q: "test", rerank: true }
      }),
      resolve
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
  });

  it("emits error event when streaming generator throws after phase 1", async () => {
    const config = makeConfig();

    const initialResponse = makeSearchResponse("test");

    async function* fakeStreamingWithError() {
      yield { phase: "initial" as const, data: initialResponse };
      throw new SearchSocketError("INTERNAL_ERROR", "Reranker blew up", 500);
    }

    vi.spyOn(SearchEngine, "create").mockResolvedValue({
      search: vi.fn(),
      searchStreaming: vi.fn().mockReturnValue(fakeStreamingWithError())
    } as unknown as SearchEngine);

    const handle = searchsocketHandle({ config });
    const resolve = vi.fn().mockResolvedValue(new Response("ok"));

    const response = await handle({
      event: makeEvent({
        pathname: "/api/search",
        method: "POST",
        body: { q: "test", stream: true, rerank: true }
      }),
      resolve
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/x-ndjson");

    const events = await readNdjsonStream(response);
    expect(events).toHaveLength(2);
    expect((events[0] as { phase: string }).phase).toBe("initial");
    expect((events[1] as { phase: string }).phase).toBe("error");
    expect((events[1] as { data: { error: { code: string } } }).data.error.code).toBe("INTERNAL_ERROR");
    expect((events[1] as { data: { error: { message: string } } }).data.error.message).toBe("Reranker blew up");
  });

  it("includes CORS headers on NDJSON streaming response", async () => {
    const config = makeConfig({
      api: {
        path: "/api/search",
        cors: { allowOrigins: ["https://app.example"] }
      }
    });

    async function* fakeStreaming() {
      yield { phase: "initial" as const, data: makeSearchResponse("test") };
    }

    vi.spyOn(SearchEngine, "create").mockResolvedValue({
      search: vi.fn(),
      searchStreaming: vi.fn().mockReturnValue(fakeStreaming())
    } as unknown as SearchEngine);

    const handle = searchsocketHandle({ config });
    const resolve = vi.fn().mockResolvedValue(new Response("ok"));

    const response = await handle({
      event: makeEvent({
        pathname: "/api/search",
        method: "POST",
        body: { q: "test", stream: true, rerank: true },
        headers: { origin: "https://app.example" }
      }),
      resolve
    });

    expect(response.headers.get("access-control-allow-origin")).toBe("https://app.example");
  });
});
