import { describe, expect, it, vi } from "vitest";
import { createSearchClient } from "../src/client";

describe("createSearchClient", () => {
  it("creates a client with default endpoint", () => {
    const client = createSearchClient();
    expect(typeof client.search).toBe("function");
  });

  it("uses custom endpoint", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        q: "test",
        scope: "main",
        results: [],
        meta: { timingsMs: { embed: 0, vector: 0, rerank: 0, total: 0 }, usedRerank: false, modelId: "test" }
      })
    });

    const client = createSearchClient({
      endpoint: "/custom/search",
      fetchImpl: mockFetch as unknown as typeof fetch
    });

    await client.search({ q: "test" });

    expect(mockFetch).toHaveBeenCalledWith(
      "/custom/search",
      expect.objectContaining({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ q: "test" })
      })
    );
  });

  it("returns search results on success", async () => {
    const expected = {
      q: "hello",
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
        modelId: "text-embedding-3-small"
      }
    };

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => expected
    });

    const client = createSearchClient({ fetchImpl: mockFetch as unknown as typeof fetch });
    const result = await client.search({ q: "hello", topK: 5 });

    expect(result.q).toBe("hello");
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.url).toBe("/docs/intro");
  });

  it("throws on non-ok response", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({
        error: { code: "INVALID_REQUEST", message: "Bad query" }
      })
    });

    const client = createSearchClient({ fetchImpl: mockFetch as unknown as typeof fetch });

    await expect(client.search({ q: "" })).rejects.toThrow("Bad query");
  });

  it("throws generic message when error message is missing", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({})
    });

    const client = createSearchClient({ fetchImpl: mockFetch as unknown as typeof fetch });

    await expect(client.search({ q: "test" })).rejects.toThrow("Search failed");
  });

  it("throws generic message when error response is not valid JSON", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      json: async () => {
        throw new SyntaxError("Unexpected token");
      }
    });

    const client = createSearchClient({ fetchImpl: mockFetch as unknown as typeof fetch });

    await expect(client.search({ q: "test" })).rejects.toThrow("Search failed");
  });

  it("throws explicit error when success response is not valid JSON", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => {
        throw new SyntaxError("Unexpected token");
      }
    });

    const client = createSearchClient({ fetchImpl: mockFetch as unknown as typeof fetch });

    await expect(client.search({ q: "test" })).rejects.toThrow("Invalid search response");
  });

  it("sends all request fields", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        q: "test",
        scope: "main",
        results: [],
        meta: { timingsMs: { embed: 0, vector: 0, rerank: 0, total: 0 }, usedRerank: false, modelId: "test" }
      })
    });

    const client = createSearchClient({ fetchImpl: mockFetch as unknown as typeof fetch });

    await client.search({
      q: "test query",
      topK: 20,
      scope: "feature",
      pathPrefix: "/docs",
      tags: ["guides"],
      rerank: true
    });

    const body = JSON.parse(mockFetch.mock.calls[0]?.[1]?.body as string) as Record<string, unknown>;
    expect(body.q).toBe("test query");
    expect(body.topK).toBe(20);
    expect(body.scope).toBe("feature");
    expect(body.pathPrefix).toBe("/docs");
    expect(body.tags).toEqual(["guides"]);
    expect(body.rerank).toBe(true);
  });
});
