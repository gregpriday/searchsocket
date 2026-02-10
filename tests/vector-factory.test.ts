import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDefaultConfig } from "../src/config/defaults";
import { createVectorStore } from "../src/vector/factory";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("createVectorStore", () => {
  it("creates a local vector store with a resolved path", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "searchsocket-vector-factory-"));
    tempDirs.push(cwd);

    const config = createDefaultConfig("factory-test");
    config.vector.provider = "local";
    config.vector.local.path = ".searchsocket/custom-local.json";

    const store = await createVectorStore(config, cwd);
    expect(await store.health()).toEqual({ ok: true });
  });

  it("throws when pinecone key is missing", async () => {
    const config = createDefaultConfig("factory-test");
    config.vector.provider = "pinecone";
    config.vector.pinecone.apiKeyEnv = "SEARCHSOCKET_TEST_MISSING_PINECONE_KEY";
    delete process.env.SEARCHSOCKET_TEST_MISSING_PINECONE_KEY;

    await expect(createVectorStore(config, process.cwd())).rejects.toMatchObject({
      code: "CONFIG_MISSING"
    });
  });

  it("throws when milvus uri is missing", async () => {
    const config = createDefaultConfig("factory-test");
    config.vector.provider = "milvus";
    config.vector.milvus.uriEnv = "SEARCHSOCKET_TEST_MISSING_MILVUS_URI";
    delete process.env.SEARCHSOCKET_TEST_MISSING_MILVUS_URI;

    await expect(createVectorStore(config, process.cwd())).rejects.toMatchObject({
      code: "CONFIG_MISSING"
    });
  });
});
