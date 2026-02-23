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
  it("creates a local file DB and passes health check", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "searchsocket-vector-factory-"));
    tempDirs.push(cwd);

    const config = createDefaultConfig("factory-test");
    config.vector.turso.localPath = ".searchsocket/vectors.db";

    const store = await createVectorStore(config, cwd);
    expect(await store.health()).toEqual({ ok: true });
  });

  it("uses remote URL from env when set", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "searchsocket-vector-factory-"));
    tempDirs.push(cwd);

    const config = createDefaultConfig("factory-test");
    config.vector.turso.urlEnv = "SEARCHSOCKET_TEST_TURSO_URL";

    // Use a local file URL to simulate a "remote" config path
    const dbPath = path.join(cwd, "remote.db");
    process.env.SEARCHSOCKET_TEST_TURSO_URL = `file:${dbPath}`;

    try {
      const store = await createVectorStore(config, cwd);
      expect(await store.health()).toEqual({ ok: true });
    } finally {
      delete process.env.SEARCHSOCKET_TEST_TURSO_URL;
    }
  });
});
