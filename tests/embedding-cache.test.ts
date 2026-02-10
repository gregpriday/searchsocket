import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EmbeddingCache } from "../src/indexing/embedding-cache";

describe("EmbeddingCache", () => {
  it("stores and retrieves embedding vectors by hash + model", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sitescribe-cache-"));
    const cachePath = path.join(dir, "embeddings-cache.sqlite");

    const cache = new EmbeddingCache(cachePath);
    cache.put("abc", "text-embedding-3-small", [0.1, 0.2, 0.3], 42);

    const found = cache.get("abc", "text-embedding-3-small");
    expect(found).not.toBeNull();
    expect(found?.tokenEstimate).toBe(42);
    expect(found?.embedding.length).toBe(3);

    const missing = cache.get("other", "text-embedding-3-small");
    expect(missing).toBeNull();

    cache.close();
  });
});
