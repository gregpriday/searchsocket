import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAIEmbeddingsProvider } from "../src/embeddings/openai";

describe("OpenAIEmbeddingsProvider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects invalid batchSize and concurrency settings", () => {
    expect(
      () =>
        new OpenAIEmbeddingsProvider({
          apiKey: "test-key",
          batchSize: 0,
          concurrency: 1
        })
    ).toThrow(/batchSize/i);

    expect(
      () =>
        new OpenAIEmbeddingsProvider({
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

    const provider = new OpenAIEmbeddingsProvider({
      apiKey: "test-key",
      batchSize: 4,
      concurrency: 1
    });

    const create = vi
      .fn()
      .mockRejectedValueOnce({ status: 429 })
      .mockRejectedValueOnce({ status: 500 })
      .mockResolvedValueOnce({
        data: [{ embedding: [1, 2, 3] }]
      });

    (provider as unknown as { client: { embeddings: { create: typeof create } } }).client = {
      embeddings: { create }
    };

    const vectors = await provider.embedTexts(["hello"], "text-embedding-3-small");
    expect(vectors).toEqual([[1, 2, 3]]);
    expect(create).toHaveBeenCalledTimes(3);
  });

  it("does not retry non-retryable errors", async () => {
    const provider = new OpenAIEmbeddingsProvider({
      apiKey: "test-key",
      batchSize: 4,
      concurrency: 1
    });

    const create = vi.fn().mockRejectedValue({ status: 400, message: "bad request" });
    (provider as unknown as { client: { embeddings: { create: typeof create } } }).client = {
      embeddings: { create }
    };

    await expect(provider.embedTexts(["hello"], "text-embedding-3-small")).rejects.toMatchObject({
      status: 400
    });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("preserves output order across batches", async () => {
    const provider = new OpenAIEmbeddingsProvider({
      apiKey: "test-key",
      batchSize: 2,
      concurrency: 2
    });

    const create = vi.fn().mockImplementation(async ({ input }: { input: string[] }) => ({
      data: input.map((text) => ({ embedding: [text.length] }))
    }));
    (provider as unknown as { client: { embeddings: { create: typeof create } } }).client = {
      embeddings: { create }
    };

    const vectors = await provider.embedTexts(
      ["a", "bb", "ccc", "dddd", "eeeee"],
      "text-embedding-3-small"
    );

    expect(vectors).toEqual([[1], [2], [3], [4], [5]]);
  });
});
