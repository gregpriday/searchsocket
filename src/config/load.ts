import fs from "node:fs";
import path from "node:path";
import { createJiti } from "jiti";
import { siteScribeConfigSchema } from "./schema";
import { createDefaultConfig } from "./defaults";
import type { ParsedSiteScribeConfig } from "./schema";
import type { ResolvedSiteScribeConfig, SiteScribeConfig, SourceMode } from "../types";
import { SiteScribeError } from "../errors";

export interface LoadConfigOptions {
  cwd?: string;
  configPath?: string;
  allowMissing?: boolean;
}

function inferProjectId(cwd: string): string {
  const packageJsonPath = path.join(cwd, "package.json");
  if (!fs.existsSync(packageJsonPath)) {
    return path.basename(cwd);
  }

  const raw = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as { name?: string };
  return (raw.name ?? path.basename(cwd)).replace(/[^a-zA-Z0-9._-]/g, "-");
}

function detectSourceMode(cwd: string, config: ResolvedSiteScribeConfig, parsedInput: ParsedSiteScribeConfig): SourceMode {
  if (parsedInput.source?.mode) {
    return parsedInput.source.mode;
  }

  if (parsedInput.source?.crawl) {
    return "crawl";
  }

  if (parsedInput.source?.contentFiles) {
    return "content-files";
  }

  const staticOutputPath = path.resolve(cwd, config.source.staticOutputDir);
  if (fs.existsSync(staticOutputPath)) {
    return "static-output";
  }

  throw new SiteScribeError(
    "CONFIG_MISSING",
    `Unable to auto-detect source mode because ${staticOutputPath} does not exist. ` +
      "Set `source.mode` explicitly (static-output, crawl, or content-files)."
  );
}

export function mergeConfig(cwd: string, rawConfig: SiteScribeConfig): ResolvedSiteScribeConfig {
  const projectId = rawConfig.project?.id ?? inferProjectId(cwd);
  const defaults = createDefaultConfig(projectId);
  const parsed = siteScribeConfigSchema.parse(rawConfig);

  const merged: ResolvedSiteScribeConfig = {
    ...defaults,
    project: {
      ...defaults.project,
      ...parsed.project
    },
    scope: {
      ...defaults.scope,
      ...parsed.scope
    },
    source: {
      ...defaults.source,
      ...parsed.source,
      crawl: parsed.source?.crawl
        ? {
            ...defaults.source.crawl,
            ...parsed.source.crawl,
            routes: parsed.source.crawl.routes ?? []
          }
        : defaults.source.crawl,
      contentFiles: parsed.source?.contentFiles
        ? {
            ...defaults.source.contentFiles,
            ...parsed.source.contentFiles,
            baseDir: parsed.source.contentFiles.baseDir ?? defaults.source.contentFiles?.baseDir ?? cwd
          }
        : defaults.source.contentFiles
    },
    extract: {
      ...defaults.extract,
      ...parsed.extract
    },
    transform: {
      ...defaults.transform,
      ...parsed.transform
    },
    chunking: {
      ...defaults.chunking,
      ...parsed.chunking
    },
    embeddings: {
      ...defaults.embeddings,
      ...parsed.embeddings
    },
    vector: {
      ...defaults.vector,
      ...parsed.vector,
      pinecone: {
        ...defaults.vector.pinecone,
        ...parsed.vector?.pinecone
      },
      milvus: {
        ...defaults.vector.milvus,
        ...parsed.vector?.milvus
      },
      local: {
        ...defaults.vector.local,
        ...parsed.vector?.local
      }
    },
    rerank: {
      ...defaults.rerank,
      ...parsed.rerank,
      jina: {
        ...defaults.rerank.jina,
        ...parsed.rerank?.jina
      }
    },
    ranking: {
      ...defaults.ranking,
      ...parsed.ranking,
      weights: {
        ...defaults.ranking.weights,
        ...parsed.ranking?.weights
      }
    },
    api: {
      ...defaults.api,
      ...parsed.api,
      cors: {
        ...defaults.api.cors,
        ...parsed.api?.cors,
        allowOrigins: parsed.api?.cors?.allowOrigins ?? defaults.api.cors.allowOrigins
      },
      rateLimit: parsed.api?.rateLimit
        ? {
            windowMs: parsed.api.rateLimit.windowMs ?? 60_000,
            max: parsed.api.rateLimit.max ?? 60
          }
        : defaults.api.rateLimit
    },
    mcp: {
      ...defaults.mcp,
      ...parsed.mcp,
      http: {
        ...defaults.mcp.http,
        ...parsed.mcp?.http
      }
    },
    state: {
      ...defaults.state,
      ...parsed.state
    }
  };

  if (!rawConfig.vector?.provider) {
    throw new SiteScribeError("CONFIG_MISSING", "`vector.provider` is required in sitescribe.config.ts.");
  }

  merged.project.id = projectId;
  merged.vector.pinecone.index = rawConfig.vector?.pinecone?.index ?? `${projectId}`;
  merged.vector.milvus.collection = rawConfig.vector?.milvus?.collection ?? `${projectId}_chunks`;
  merged.source.mode = detectSourceMode(cwd, merged, parsed);

  if (merged.source.mode === "crawl" && !merged.source.crawl?.baseUrl) {
    throw new SiteScribeError("CONFIG_MISSING", "`source.crawl.baseUrl` is required when source.mode is crawl.");
  }

  if (merged.source.mode === "content-files" && (!merged.source.contentFiles || merged.source.contentFiles.globs.length === 0)) {
    throw new SiteScribeError(
      "CONFIG_MISSING",
      "`source.contentFiles.globs` is required when source.mode is content-files."
    );
  }

  return merged;
}

export async function loadConfig(options: LoadConfigOptions = {}): Promise<ResolvedSiteScribeConfig> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const configPath = path.resolve(cwd, options.configPath ?? "sitescribe.config.ts");

  if (!fs.existsSync(configPath)) {
    if (options.allowMissing) {
      return mergeConfig(cwd, {
        source: {
          mode: "static-output"
        },
        vector: {
          provider: "local"
        }
      });
    }

    throw new SiteScribeError(
      "CONFIG_MISSING",
      `Configuration file not found at ${configPath}. Run \`sitescribe init\` first.`
    );
  }

  const jiti = createJiti(cwd, { interopDefault: true });
  const loaded = (await jiti.import(configPath)) as SiteScribeConfig;
  const raw = (loaded as { default?: SiteScribeConfig }).default ?? loaded;

  return mergeConfig(cwd, raw);
}

export function writeMinimalConfig(cwd: string): string {
  const target = path.join(cwd, "sitescribe.config.ts");
  if (fs.existsSync(target)) {
    return target;
  }

  const content = `export default {
  embeddings: { apiKeyEnv: "OPENAI_API_KEY" },
  vector: { provider: "local" }
};
`;

  fs.writeFileSync(target, content, "utf8");
  return target;
}
