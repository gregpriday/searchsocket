import { afterEach, describe, expect, it } from "vitest";
import { createDefaultConfig } from "../src/config/defaults";
import { createReranker } from "../src/rerank/factory";

afterEach(() => {
  delete process.env.SEARCHSOCKET_TEST_MISSING_JINA;
  delete process.env.SEARCHSOCKET_TEST_JINA;
});

describe("createReranker", () => {
  it("returns null when rerank is disabled", () => {
    const config = createDefaultConfig("rerank-factory");
    config.rerank.enabled = false;

    expect(createReranker(config)).toBeNull();
  });

  it("returns null when rerank is enabled but key is missing", () => {
    const config = createDefaultConfig("rerank-factory");
    config.rerank.enabled = true;
    config.embeddings.apiKeyEnv = "SEARCHSOCKET_TEST_MISSING_JINA";
    delete process.env.SEARCHSOCKET_TEST_MISSING_JINA;

    expect(createReranker(config)).toBeNull();
  });

  it("returns a reranker when enabled and key is present", () => {
    const config = createDefaultConfig("rerank-factory");
    config.rerank.enabled = true;
    config.embeddings.apiKeyEnv = "SEARCHSOCKET_TEST_JINA";
    process.env.SEARCHSOCKET_TEST_JINA = "test-key";

    const reranker = createReranker(config);
    expect(reranker).not.toBeNull();
  });
});
