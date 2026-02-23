import { afterEach, describe, expect, it, vi } from "vitest";
import { JinaEmbeddingsProvider } from "../src/embeddings/jina";

describe("JinaEmbeddingsProvider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects invalid batchSize and concurrency settings", () => {
    expect(
      () =>
        new JinaEmbeddingsProvider({
          apiKey: "test-key",
          batchSize: 0,
          concurrency: 1
        })
    ).toThrow(/batchSize/i);

    expect(
      () =>
        new JinaEmbeddingsProvider({
          apiKey: "test-key",
          batchSize: 1,
          concurrency: 0
        })
    ).toThrow(/concurrency/i);
  });

  it("retries on 429 and eventually succeeds", async () => {
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: TimerHandler) => {
      if (typeof fn === "function") {
        fn();
      }
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout);

    const provider = new JinaEmbeddingsProvider({
      apiKey: "test-key",
      batchSize: 4,
      concurrency: 1
    });

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        text: async () => "rate limited"
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => "server error"
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [{ embedding: [1, 2, 3] }]
        })
      });

    vi.stubGlobal("fetch", fetchMock);

    const vectors = await provider.embedTexts(["hello"], "jina-embeddings-v3");
    expect(vectors).toEqual([[1, 2, 3]]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not retry non-retryable errors", async () => {
    const provider = new JinaEmbeddingsProvider({
      apiKey: "test-key",
      batchSize: 4,
      concurrency: 1
    });

    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => "bad request"
    });

    vi.stubGlobal("fetch", fetchMock);

    await expect(provider.embedTexts(["hello"], "jina-embeddings-v3")).rejects.toThrow(
      "Jina embeddings failed (400)"
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("preserves output order across batches", async () => {
    const provider = new JinaEmbeddingsProvider({
      apiKey: "test-key",
      batchSize: 2,
      concurrency: 2
    });

    const fetchMock = vi.fn().mockImplementation(async (_url: string, opts: { body: string }) => {
      const body = JSON.parse(opts.body) as { input: string[] };
      return {
        ok: true,
        json: async () => ({
          data: body.input.map((text: string) => ({ embedding: [text.length] }))
        })
      };
    });

    vi.stubGlobal("fetch", fetchMock);

    const vectors = await provider.embedTexts(
      ["a", "bb", "ccc", "dddd", "eeeee"],
      "jina-embeddings-v3"
    );

    expect(vectors).toEqual([[1], [2], [3], [4], [5]]);
  });

  it("passes task parameter to the API", async () => {
    const provider = new JinaEmbeddingsProvider({
      apiKey: "test-key",
      batchSize: 4,
      concurrency: 1
    });

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{ embedding: [1, 0, 0] }]
      })
    });

    vi.stubGlobal("fetch", fetchMock);

    await provider.embedTexts(["hello"], "jina-embeddings-v3", "retrieval.query");

    const callBody = JSON.parse((fetchMock.mock.calls[0]![1] as { body: string }).body) as { task: string };
    expect(callBody.task).toBe("retrieval.query");
  });

  it("uses default task when none is specified", async () => {
    const provider = new JinaEmbeddingsProvider({
      apiKey: "test-key",
      batchSize: 4,
      concurrency: 1
    });

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{ embedding: [1, 0, 0] }]
      })
    });

    vi.stubGlobal("fetch", fetchMock);

    await provider.embedTexts(["hello"], "jina-embeddings-v3");

    const callBody = JSON.parse((fetchMock.mock.calls[0]![1] as { body: string }).body) as { task: string };
    expect(callBody.task).toBe("retrieval.passage");
  });
});
