import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDefaultConfig } from "../src/config/defaults";
import { createVectorStore } from "../src/vector/factory";

const tempDirs: string[] = [];

afterEach(async () => {
  delete process.env.VERCEL;
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("createVectorStore", () => {
  it("creates a local file DB and passes health check", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "searchsocket-vector-factory-"));
    tempDirs.push(cwd);

    const config = createDefaultConfig("factory-test");
    config.vector.turso.localPath = ".searchsocket/vectors.db";

    const store = await createVectorStore(config, cwd);
    expect(await store.health()).toEqual({ ok: true });
  });

  it("falls back to local file when remote env var is not set", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "searchsocket-vector-factory-"));
    tempDirs.push(cwd);

    const config = createDefaultConfig("factory-test");
    config.vector.turso.urlEnv = "SEARCHSOCKET_TEST_UNSET_URL";
    delete process.env.SEARCHSOCKET_TEST_UNSET_URL;

    const store = await createVectorStore(config, cwd);
    expect(await store.health()).toEqual({ ok: true });
  });

  it("throws clear error on serverless when no remote URL is set", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "searchsocket-vector-factory-"));
    tempDirs.push(cwd);

    const config = createDefaultConfig("factory-test");
    config.vector.turso.urlEnv = "SEARCHSOCKET_TEST_UNSET_URL";
    delete process.env.SEARCHSOCKET_TEST_UNSET_URL;

    process.env.VERCEL = "1";

    await expect(createVectorStore(config, cwd)).rejects.toThrow(
      "Local SQLite storage is not available in serverless environments"
    );
  });

  it("uses HTTP client for remote URL", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "searchsocket-vector-factory-"));
    tempDirs.push(cwd);

    const config = createDefaultConfig("factory-test");
    config.vector.turso.urlEnv = "SEARCHSOCKET_TEST_TURSO_URL";

    // Point to a URL that won't connect but verifies the HTTP path is used
    process.env.SEARCHSOCKET_TEST_TURSO_URL = "http://localhost:0";

    try {
      const store = await createVectorStore(config, cwd);
      // Health check will fail since there's no server, but the store was created
      // using the HTTP client (no native SQLite dependency)
      const health = await store.health();
      expect(health.ok).toBe(false);
    } finally {
      delete process.env.SEARCHSOCKET_TEST_TURSO_URL;
    }
  });
});
