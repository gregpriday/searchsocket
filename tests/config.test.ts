import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, mergeConfig } from "../src/config/load";
import { createDefaultConfig } from "../src/config/defaults";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "searchsocket-cfg-"));
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
    expect(config.state.dir).toBe(".searchsocket");
  });

  it("has turso defaults", () => {
    const config = createDefaultConfig("example");
    expect(config.vector.turso.urlEnv).toBe("TURSO_DATABASE_URL");
    expect(config.vector.turso.authTokenEnv).toBe("TURSO_AUTH_TOKEN");
    expect(config.vector.turso.localPath).toBe(".searchsocket/vectors.db");
  });
});

describe("mergeConfig", () => {
  it("merges user config with defaults", async () => {
    const dir = await makeTempDir();
    await fs.mkdir(path.join(dir, "build"), { recursive: true });

    const merged = mergeConfig(dir, {
      chunking: { maxChars: 3000 }
    });

    expect(merged.vector.turso.urlEnv).toBe("TURSO_DATABASE_URL");
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
      source: { mode: "static-output" }
    });
    expect(merged.project.id).toBe("-org-my-site");
  });

  it("falls back to directory name when no package.json", async () => {
    const dir = await makeTempDir();
    const merged = mergeConfig(dir, {
      source: { mode: "static-output" }
    });
    expect(merged.project.id).toBe(path.basename(dir));
  });

  it("throws when source.mode is omitted and static output is missing", async () => {
    const dir = await makeTempDir();
    expect(() =>
      mergeConfig(dir, {})
    ).toThrow("source.mode");
  });

  it("throws when crawl mode lacks baseUrl", async () => {
    const dir = await makeTempDir();
    expect(() =>
      mergeConfig(dir, {
        source: { mode: "crawl" }
      })
    ).toThrow("baseUrl");
  });

  it("throws when content-files mode lacks globs", async () => {
    const dir = await makeTempDir();
    expect(() =>
      mergeConfig(dir, {
        source: { mode: "content-files" }
      })
    ).toThrow("globs");
  });

  it("defaults crawl.routes to an empty array when omitted", async () => {
    const dir = await makeTempDir();

    const merged = mergeConfig(dir, {
      source: {
        mode: "crawl",
        crawl: {
          baseUrl: "https://example.com"
        }
      }
    });

    expect(merged.source.mode).toBe("crawl");
    expect(merged.source.crawl?.routes).toEqual([]);
  });

  it("merges turso overrides", async () => {
    const dir = await makeTempDir();
    await fs.mkdir(path.join(dir, "build"), { recursive: true });

    const merged = mergeConfig(dir, {
      vector: {
        turso: { localPath: "custom/vectors.db" }
      }
    });

    expect(merged.vector.turso.localPath).toBe("custom/vectors.db");
    expect(merged.vector.turso.urlEnv).toBe("TURSO_DATABASE_URL"); // default preserved
  });
});

describe("loadConfig", () => {
  it("throws when config file is missing", async () => {
    const dir = await makeTempDir();
    await expect(loadConfig({ cwd: dir })).rejects.toThrow("not found");
  });

  it("falls back to turso defaults when allowMissing is true", async () => {
    const dir = await makeTempDir();
    const config = await loadConfig({ cwd: dir, allowMissing: true });
    expect(config.vector.turso.urlEnv).toBe("TURSO_DATABASE_URL");
    expect(config.vector.turso.localPath).toBe(".searchsocket/vectors.db");
  });
});
