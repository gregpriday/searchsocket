import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, mergeConfig, mergeConfigServerless } from "../src/config/load";
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
    expect(config.chunking.maxChars).toBe(1500);
    expect(config.chunking.overlapChars).toBe(200);
    expect(config.chunking.minChars).toBe(250);
    expect(config.api.path).toBe("/api/search");
    expect(config.state.dir).toBe(".searchsocket");
  });

  it("has upstash defaults", () => {
    const config = createDefaultConfig("example");
    expect(config.upstash.urlEnv).toBe("UPSTASH_VECTOR_REST_URL");
    expect(config.upstash.tokenEnv).toBe("UPSTASH_VECTOR_REST_TOKEN");
    expect(config.upstash.namespaces.pages).toBe("pages");
    expect(config.upstash.namespaces.chunks).toBe("chunks");
  });

  it("has embedding defaults", () => {
    const config = createDefaultConfig("example");
    expect(config.embedding.model).toBe("bge-large-en-v1.5");
    expect(config.embedding.dimensions).toBe(1024);
    expect(config.embedding.apiKeyEnv).toBe("GEMINI_API_KEY");
    expect(config.embedding.batchSize).toBe(100);
  });

  it("has llmsTxt defaults with generateFull enabled", () => {
    const config = createDefaultConfig("example");
    expect(config.llmsTxt.generateFull).toBe(true);
    expect(config.llmsTxt.serveMarkdownVariants).toBe(false);
    expect(config.llmsTxt.enable).toBe(false);
  });

  it("has search defaults", () => {
    const config = createDefaultConfig("example");
    expect(config.search.dualSearch).toBe(true);
    expect(config.search.pageSearchWeight).toBe(0.3);
    expect(config.search.hybridChunks).toBe(true);
  });

  it("has ranking weights without rerank", () => {
    const config = createDefaultConfig("example");
    expect(config.ranking.weights.incomingLinks).toBe(0.05);
    expect(config.ranking.weights.depth).toBe(0.03);
    expect(config.ranking.weights.aggregation).toBe(0.1);
    expect(config.ranking.weights).not.toHaveProperty("rerank");
  });
});

describe("mergeConfig", () => {
  it("merges user config with defaults", async () => {
    const dir = await makeTempDir();
    await fs.mkdir(path.join(dir, "build"), { recursive: true });

    const merged = mergeConfig(dir, {
      chunking: { maxChars: 3000 }
    });

    expect(merged.upstash.urlEnv).toBe("UPSTASH_VECTOR_REST_URL");
    expect(merged.chunking.maxChars).toBe(3000);
    expect(merged.chunking.overlapChars).toBe(200);
    expect(merged.search.dualSearch).toBe(true);
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

  it("detects build mode from source.build config", async () => {
    const dir = await makeTempDir();

    const merged = mergeConfig(dir, {
      source: {
        build: {
          outputDir: ".svelte-kit/output"
        }
      }
    });

    expect(merged.source.mode).toBe("build");
    expect(merged.source.build).toBeDefined();
    expect(merged.source.build?.outputDir).toBe(".svelte-kit/output");
  });

  it("validates build config schema fields", async () => {
    const dir = await makeTempDir();

    const merged = mergeConfig(dir, {
      source: {
        build: {
          outputDir: ".svelte-kit/output",
          paramValues: { "/blog/[slug]": ["post-1", "post-2"] },
          exclude: ["/api/*"],
          previewTimeout: 60000
        }
      }
    });

    expect(merged.source.build?.paramValues).toEqual({ "/blog/[slug]": ["post-1", "post-2"] });
    expect(merged.source.build?.exclude).toEqual(["/api/*"]);
    expect(merged.source.build?.previewTimeout).toBe(60000);
  });

  it("auto-creates build config defaults when mode is explicitly build", async () => {
    const dir = await makeTempDir();

    const merged = mergeConfig(dir, {
      source: { mode: "build" }
    });

    expect(merged.source.mode).toBe("build");
    expect(merged.source.build).toBeDefined();
    expect(merged.source.build?.outputDir).toBe(".svelte-kit/output");
    expect(merged.source.build?.paramValues).toEqual({});
    expect(merged.source.build?.exclude).toEqual([]);
    expect(merged.source.build?.previewTimeout).toBe(30000);
  });

  it("merges build config with defaults for missing fields", async () => {
    const dir = await makeTempDir();

    const merged = mergeConfig(dir, {
      source: {
        build: {
          exclude: ["/admin/*"]
        }
      }
    });

    expect(merged.source.mode).toBe("build");
    expect(merged.source.build?.outputDir).toBe(".svelte-kit/output");
    expect(merged.source.build?.paramValues).toEqual({});
    expect(merged.source.build?.exclude).toEqual(["/admin/*"]);
    expect(merged.source.build?.previewTimeout).toBe(30000);
  });

  it("merges embedding overrides with nested images", async () => {
    const dir = await makeTempDir();
    await fs.mkdir(path.join(dir, "build"), { recursive: true });

    const merged = mergeConfig(dir, {
      embedding: { dimensions: 768, batchSize: 50, images: { enable: true } }
    });

    expect(merged.embedding.dimensions).toBe(768);
    expect(merged.embedding.batchSize).toBe(50);
    expect(merged.embedding.images.enable).toBe(true);
    expect(merged.embedding.model).toBe("bge-large-en-v1.5"); // default preserved
    expect(merged.embedding.apiKeyEnv).toBe("GEMINI_API_KEY"); // default preserved
  });

  it("merges upstash overrides", async () => {
    const dir = await makeTempDir();
    await fs.mkdir(path.join(dir, "build"), { recursive: true });

    const merged = mergeConfig(dir, {
      upstash: { urlEnv: "CUSTOM_UPSTASH_URL" }
    });

    expect(merged.upstash.urlEnv).toBe("CUSTOM_UPSTASH_URL");
    expect(merged.upstash.tokenEnv).toBe("UPSTASH_VECTOR_REST_TOKEN");
    expect(merged.upstash.namespaces.pages).toBe("pages");
    expect(merged.upstash.namespaces.chunks).toBe("chunks");
  });

  it("deep-merges upstash.namespaces preserving defaults for unset fields", async () => {
    const dir = await makeTempDir();
    await fs.mkdir(path.join(dir, "build"), { recursive: true });

    const merged = mergeConfig(dir, {
      upstash: { namespaces: { chunks: "custom-chunks" } }
    });

    expect(merged.upstash.namespaces.chunks).toBe("custom-chunks");
    expect(merged.upstash.namespaces.pages).toBe("pages");
  });

  it("merges search overrides", async () => {
    const dir = await makeTempDir();
    await fs.mkdir(path.join(dir, "build"), { recursive: true });

    const merged = mergeConfig(dir, {
      search: { dualSearch: false }
    });

    expect(merged.search.dualSearch).toBe(false);
    expect(merged.search.pageSearchWeight).toBe(0.3);
  });

  it("allows setting upstash url and token directly", async () => {
    const dir = await makeTempDir();
    await fs.mkdir(path.join(dir, "build"), { recursive: true });

    const merged = mergeConfig(dir, {
      upstash: {
        url: "https://my-index.upstash.io",
        token: "my-token"
      }
    });

    expect(merged.upstash.url).toBe("https://my-index.upstash.io");
    expect(merged.upstash.token).toBe("my-token");
    expect(merged.upstash.urlEnv).toBe("UPSTASH_VECTOR_REST_URL");
    expect(merged.upstash.tokenEnv).toBe("UPSTASH_VECTOR_REST_TOKEN");
  });
});

describe("mergeConfig mcp.access", () => {
  it("defaults mcp.access to private", async () => {
    const dir = await makeTempDir();
    await fs.mkdir(path.join(dir, "build"), { recursive: true });

    const merged = mergeConfig(dir, {});
    expect(merged.mcp.access).toBe("private");
  });

  it("throws when access is public but no API key is configured", async () => {
    const dir = await makeTempDir();
    await fs.mkdir(path.join(dir, "build"), { recursive: true });

    expect(() =>
      mergeConfig(dir, {
        mcp: { access: "public" }
      })
    ).toThrow("mcp.http.apiKey");
  });

  it("allows public access when apiKey is set", async () => {
    const dir = await makeTempDir();
    await fs.mkdir(path.join(dir, "build"), { recursive: true });

    const merged = mergeConfig(dir, {
      mcp: { access: "public", http: { apiKey: "my-secret" } }
    });

    expect(merged.mcp.access).toBe("public");
    expect(merged.mcp.http.apiKey).toBe("my-secret");
  });

  it("allows public access when apiKeyEnv resolves to a value", async () => {
    const envKey = "TEST_MCP_KEY_" + Date.now();
    process.env[envKey] = "env-secret";
    try {
      const dir = await makeTempDir();
      await fs.mkdir(path.join(dir, "build"), { recursive: true });

      const merged = mergeConfig(dir, {
        mcp: { access: "public", http: { apiKeyEnv: envKey } }
      });

      expect(merged.mcp.access).toBe("public");
      expect(merged.mcp.http.apiKeyEnv).toBe(envKey);
    } finally {
      delete process.env[envKey];
    }
  });

  it("throws when apiKeyEnv is set but env var is missing", async () => {
    const dir = await makeTempDir();
    await fs.mkdir(path.join(dir, "build"), { recursive: true });

    expect(() =>
      mergeConfig(dir, {
        mcp: { access: "public", http: { apiKeyEnv: "NONEXISTENT_ENV_VAR_12345" } }
      })
    ).toThrow("mcp.http.apiKey");
  });

  it("does not require API key when access is private", async () => {
    const dir = await makeTempDir();
    await fs.mkdir(path.join(dir, "build"), { recursive: true });

    const merged = mergeConfig(dir, {
      mcp: { access: "private" }
    });

    expect(merged.mcp.access).toBe("private");
  });
});

describe("mergeConfig legacy analytics field", () => {
  it("silently strips removed analytics field from user config", async () => {
    const dir = await makeTempDir();
    await fs.mkdir(path.join(dir, "build"), { recursive: true });

    const merged = mergeConfig(dir, {
      analytics: { enabled: true }
    } as any);

    expect(merged).not.toHaveProperty("analytics");
  });
});

describe("mergeConfigServerless", () => {
  it("throws when project.id is missing", () => {
    expect(() =>
      mergeConfigServerless({
        source: { mode: "static-output" }
      })
    ).toThrow("project.id");
  });

  it("throws when source.mode is missing", () => {
    expect(() =>
      mergeConfigServerless({
        project: { id: "my-site" }
      })
    ).toThrow("source.mode");
  });

  it("resolves correctly when required fields are present", () => {
    const config = mergeConfigServerless({
      project: { id: "my-site" },
      source: { mode: "static-output" },
      upstash: { urlEnv: "CUSTOM_UPSTASH_URL" }
    });

    expect(config.project.id).toBe("my-site");
    expect(config.source.mode).toBe("static-output");
    expect(config.upstash.urlEnv).toBe("CUSTOM_UPSTASH_URL");
    expect(config.upstash.tokenEnv).toBe("UPSTASH_VECTOR_REST_TOKEN");
  });
});

describe("loadConfig", () => {
  it("throws when config file is missing", async () => {
    const dir = await makeTempDir();
    await expect(loadConfig({ cwd: dir })).rejects.toThrow("not found");
  });

  it("falls back to upstash defaults when allowMissing is true", async () => {
    const dir = await makeTempDir();
    const config = await loadConfig({ cwd: dir, allowMissing: true });
    expect(config.upstash.urlEnv).toBe("UPSTASH_VECTOR_REST_URL");
    expect(config.upstash.tokenEnv).toBe("UPSTASH_VECTOR_REST_TOKEN");
    expect(config.search.dualSearch).toBe(true);
  });
});
