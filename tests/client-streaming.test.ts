import { describe, expect, it, vi } from "vitest";
import { createSearchClient } from "../src/client";
import type { SearchResponse, StreamSearchEvent } from "../src/types";

function makeSearchResponse(q: string, usedRerank = false): SearchResponse {
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
      timingsMs: { embed: 10, vector: 20, rerank: usedRerank ? 50 : 0, total: usedRerank ? 80 : 30 },
      usedRerank,
      modelId: "jina-embeddings-v3"
    }
  };
}

function makeNdjsonResponse(events: Array<{ phase: string; data: unknown }>): Response {
  const body = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
  const encoder = new TextEncoder();
  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(body));
      controller.close();
    }
  });

  return new Response(readable, {
    status: 200,
    headers: { "content-type": "application/x-ndjson" }
  });
}

describe("streamSearch", () => {
  it("parses NDJSON stream and calls onPhase for each event", async () => {
    const initial = makeSearchResponse("test", false);
    const reranked = makeSearchResponse("test", true);

    const mockFetch = vi.fn().mockResolvedValue(
      makeNdjsonResponse([
        { phase: "initial", data: initial },
        { phase: "reranked", data: reranked }
      ])
    );

    const client = createSearchClient({ fetchImpl: mockFetch as unknown as typeof fetch });
    const phases: StreamSearchEvent[] = [];

    const result = await client.streamSearch(
      { q: "test", stream: true, rerank: true },
      (event) => phases.push(event)
    );

    expect(phases).toHaveLength(2);
    expect(phases[0]!.phase).toBe("initial");
    expect(phases[1]!.phase).toBe("reranked");
    // Returns the last response
    expect(result.meta.usedRerank).toBe(true);
  });

  it("falls back gracefully when server returns application/json", async () => {
    const response = makeSearchResponse("test", true);

    const mockFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(response), {
      status: 200,
      headers: { "content-type": "application/json" }
    }));

    const client = createSearchClient({ fetchImpl: mockFetch as unknown as typeof fetch });
    const phases: StreamSearchEvent[] = [];

    const result = await client.streamSearch(
      { q: "test", stream: true, rerank: true },
      (event) => phases.push(event)
    );

    expect(phases).toHaveLength(1);
    expect(phases[0]!.phase).toBe("initial");
    expect(result.q).toBe("test");
  });

  it("throws on error events in NDJSON stream", async () => {
    const initial = makeSearchResponse("test", false);

    const mockFetch = vi.fn().mockResolvedValue(
      makeNdjsonResponse([
        { phase: "initial", data: initial },
        { phase: "error", data: { error: { code: "INTERNAL_ERROR", message: "Reranker failed" } } }
      ])
    );

    const client = createSearchClient({ fetchImpl: mockFetch as unknown as typeof fetch });
    const phases: StreamSearchEvent[] = [];

    await expect(
      client.streamSearch(
        { q: "test", stream: true, rerank: true },
        (event) => phases.push(event)
      )
    ).rejects.toThrow("Reranker failed");

    // Initial phase should have been received before the error
    expect(phases).toHaveLength(1);
    expect(phases[0]!.phase).toBe("initial");
  });

  it("throws on non-ok response", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: { code: "INVALID_REQUEST", message: "Bad query" } }),
      { status: 400, headers: { "content-type": "application/json" } }
    ));

    const client = createSearchClient({ fetchImpl: mockFetch as unknown as typeof fetch });

    await expect(
      client.streamSearch(
        { q: "", stream: true, rerank: true },
        () => {}
      )
    ).rejects.toThrow("Bad query");
  });

  it("throws generic error when non-ok response has no parseable body", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("Internal Server Error", {
      status: 500,
      headers: { "content-type": "text/plain" }
    }));

    const client = createSearchClient({ fetchImpl: mockFetch as unknown as typeof fetch });

    await expect(
      client.streamSearch(
        { q: "test", stream: true, rerank: true },
        () => {}
      )
    ).rejects.toThrow("Search failed");
  });

  it("sends the correct request body", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      makeNdjsonResponse([
        { phase: "initial", data: makeSearchResponse("test") }
      ])
    );

    const client = createSearchClient({
      endpoint: "/custom/search",
      fetchImpl: mockFetch as unknown as typeof fetch
    });

    await client.streamSearch(
      { q: "test query", stream: true, rerank: true, topK: 5 },
      () => {}
    );

    expect(mockFetch).toHaveBeenCalledWith(
      "/custom/search",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ q: "test query", stream: true, rerank: true, topK: 5 })
      })
    );
  });
});
