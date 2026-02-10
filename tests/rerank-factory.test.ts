import { afterEach, describe, expect, it } from "vitest";
import { createDefaultConfig } from "../src/config/defaults";
import { createReranker } from "../src/rerank/factory";

afterEach(() => {
  delete process.env.SEARCHSOCKET_TEST_MISSING_JINA;
  delete process.env.SEARCHSOCKET_TEST_JINA;
});

describe("createReranker", () => {
  it("returns null when provider is none", () => {
    const config = createDefaultConfig("rerank-factory");
    config.rerank.provider = "none";

    expect(createReranker(config)).toBeNull();
  });

  it("returns null when jina is configured but key is missing", () => {
    const config = createDefaultConfig("rerank-factory");
    config.rerank.provider = "jina";
    config.rerank.jina.apiKeyEnv = "SEARCHSOCKET_TEST_MISSING_JINA";
    delete process.env.SEARCHSOCKET_TEST_MISSING_JINA;

    expect(createReranker(config)).toBeNull();
  });

  it("returns a reranker when jina key is present", () => {
    const config = createDefaultConfig("rerank-factory");
    config.rerank.provider = "jina";
    config.rerank.jina.apiKeyEnv = "SEARCHSOCKET_TEST_JINA";
    process.env.SEARCHSOCKET_TEST_JINA = "test-key";

    const reranker = createReranker(config);
    expect(reranker).not.toBeNull();
  });
});
