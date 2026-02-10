import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, mergeConfig } from "../src/config/load";
import { createDefaultConfig } from "../src/config/defaults";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sitescribe-cfg-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

describe("createDefaultConfig", () => {
  it("creates defaults with correct project id", () => {
    const config = createDefaultConfig("my-project");
    expect(config.project.id).toBe("my-project");
    expect(config.scope.mode).toBe("fixed");
    expect(config.scope.fixed).toBe("main");
    expect(config.embeddings.model).toBe("text-embedding-3-small");
    expect(config.chunking.maxChars).toBe(2200);
    expect(config.chunking.overlapChars).toBe(200);
    expect(config.chunking.minChars).toBe(250);
    expect(config.api.path).toBe("/api/search");
    expect(config.state.dir).toBe(".sitescribe");
  });

  it("uses project id for vector index names", () => {
    const config = createDefaultConfig("example");
    expect(config.vector.pinecone.index).toBe("example");
    expect(config.vector.milvus.collection).toBe("example_chunks");
  });
});

describe("mergeConfig", () => {
  it("merges user config with defaults", async () => {
    const dir = await makeTempDir();
    await fs.mkdir(path.join(dir, "build"), { recursive: true });

    const merged = mergeConfig(dir, {
      vector: { provider: "local" },
      chunking: { maxChars: 3000 }
    });

    expect(merged.vector.provider).toBe("local");
    expect(merged.chunking.maxChars).toBe(3000);
    expect(merged.chunking.overlapChars).toBe(200); // default preserved
    expect(merged.embeddings.model).toBe("text-embedding-3-small");
  });

  it("infers project id from package.json name", async () => {
    const dir = await makeTempDir();
    await fs.writeFile(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "@org/my-site" }),
      "utf8"
    );

    const merged = mergeConfig(dir, {
      source: { mode: "static-output" },
      vector: { provider: "local" }
    });
    expect(merged.project.id).toBe("-org-my-site");
  });

  it("falls back to directory name when no package.json", async () => {
    const dir = await makeTempDir();
    const merged = mergeConfig(dir, {
      source: { mode: "static-output" },
      vector: { provider: "local" }
    });
    expect(merged.project.id).toBe(path.basename(dir));
  });

  it("throws when source.mode is omitted and static output is missing", async () => {
    const dir = await makeTempDir();
    expect(() =>
      mergeConfig(dir, {
        vector: { provider: "local" }
      })
    ).toThrow("source.mode");
  });

  it("throws when vector.provider is missing", () => {
    expect(() => mergeConfig("/tmp", {} as any)).toThrow("vector.provider");
  });

  it("throws when crawl mode lacks baseUrl", async () => {
    const dir = await makeTempDir();
    expect(() =>
      mergeConfig(dir, {
        source: { mode: "crawl" },
        vector: { provider: "local" }
      })
    ).toThrow("baseUrl");
  });

  it("throws when content-files mode lacks globs", async () => {
    const dir = await makeTempDir();
    expect(() =>
      mergeConfig(dir, {
        source: { mode: "content-files" },
        vector: { provider: "local" }
      })
    ).toThrow("globs");
  });
});

describe("loadConfig", () => {
  it("throws when config file is missing", async () => {
    const dir = await makeTempDir();
    await expect(loadConfig({ cwd: dir })).rejects.toThrow("not found");
  });

  it("falls back to local vector when allowMissing is true", async () => {
    const dir = await makeTempDir();
    const config = await loadConfig({ cwd: dir, allowMissing: true });
    expect(config.vector.provider).toBe("local");
  });
});
