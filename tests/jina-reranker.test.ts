import { afterEach, describe, expect, it, vi } from "vitest";
import { JinaReranker } from "../src/rerank/jina";

describe("JinaReranker", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("maps response indices to candidate ids, sorts by score, and ignores invalid indices", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [
          { index: 1, score: 0.2 },
          { index: 999, score: 1.0 },
          { index: 0, relevance_score: 0.9 },
          { index: -1, score: 0.7 }
        ]
      })
    } as Response);

    const reranker = new JinaReranker({
      apiKey: "test-key",
      model: "test-model"
    });

    const result = await reranker.rerank(
      "hello",
      [
        { id: "a", text: "Alpha" },
        { id: "b", text: "Beta" }
      ],
      1
    );

    expect(result).toEqual([
      { id: "a", score: 0.9 },
      { id: "b", score: 0.2 }
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.jina.ai/v1/rerank");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: "POST"
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.top_n).toBe(1);
    expect(body.documents).toEqual(["Alpha", "Beta"]);
  });

  it("retries on 429/5xx and succeeds", async () => {
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: TimerHandler) => {
      if (typeof fn === "function") {
        fn();
      }
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout);

    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        text: async () => "rate limit"
      } as Response)
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => "server error"
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [{ index: 0, relevance_score: 0.88 }]
        })
      } as Response);

    const reranker = new JinaReranker({
      apiKey: "test-key",
      model: "test-model",
      maxRetries: 3
    });

    const result = await reranker.rerank("hello", [{ id: "a", text: "Alpha" }]);
    expect(result).toEqual([{ id: "a", score: 0.88 }]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not retry non-retryable HTTP errors", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => "bad request"
    } as Response);

    const reranker = new JinaReranker({
      apiKey: "test-key",
      model: "test-model",
      maxRetries: 5
    });

    await expect(reranker.rerank("hello", [{ id: "a", text: "Alpha" }])).rejects.toThrow(
      "Jina rerank failed (400): bad request"
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stops after max retries on persistent retryable errors", async () => {
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: TimerHandler) => {
      if (typeof fn === "function") {
        fn();
      }
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout);

    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => "service unavailable"
    } as Response);

    const reranker = new JinaReranker({
      apiKey: "test-key",
      model: "test-model",
      maxRetries: 2
    });

    await expect(reranker.rerank("hello", [{ id: "a", text: "Alpha" }])).rejects.toThrow(
      "Jina rerank failed (503): service unavailable"
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("retries transient fetch failures before succeeding", async () => {
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: TimerHandler) => {
      if (typeof fn === "function") {
        fn();
      }
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout);

    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new Error("network reset"))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          results: [{ index: 0, score: 0.5 }]
        })
      } as Response);

    const reranker = new JinaReranker({
      apiKey: "test-key",
      model: "test-model",
      maxRetries: 2
    });

    const result = await reranker.rerank("hello", [{ id: "a", text: "Alpha" }]);
    expect(result).toEqual([{ id: "a", score: 0.5 }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws a clear error for malformed successful payloads", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        results: { index: 0, score: 0.9 }
      })
    } as unknown as Response);

    const reranker = new JinaReranker({
      apiKey: "test-key",
      model: "test-model"
    });

    await expect(reranker.rerank("hello", [{ id: "a", text: "Alpha" }])).rejects.toThrow(
      "Invalid Jina rerank response format"
    );
  });
});
