import { z } from "zod";

export const searchSocketConfigSchema = z.object({
  project: z
    .object({
      id: z.string().min(1).optional(),
      baseUrl: z.string().url().optional()
    })
    .optional(),
  scope: z
    .object({
      mode: z.enum(["fixed", "git", "env"]).optional(),
      fixed: z.string().min(1).optional(),
      envVar: z.string().min(1).optional(),
      sanitize: z.boolean().optional()
    })
    .optional(),
  source: z
    .object({
      mode: z.enum(["static-output", "crawl", "content-files"]).optional(),
      staticOutputDir: z.string().min(1).optional(),
      strictRouteMapping: z.boolean().optional(),
      crawl: z
        .object({
          baseUrl: z.string().url(),
          routes: z.array(z.string()).optional(),
          sitemapUrl: z.string().optional()
        })
        .optional(),
      contentFiles: z
        .object({
          globs: z.array(z.string()).min(1),
          baseDir: z.string().optional()
        })
        .optional()
    })
    .optional(),
  extract: z
    .object({
      mainSelector: z.string().optional(),
      dropTags: z.array(z.string()).optional(),
      dropSelectors: z.array(z.string()).optional(),
      ignoreAttr: z.string().optional(),
      noindexAttr: z.string().optional(),
      respectRobotsNoindex: z.boolean().optional()
    })
    .optional(),
  transform: z
    .object({
      output: z.literal("markdown").optional(),
      preserveCodeBlocks: z.boolean().optional(),
      preserveTables: z.boolean().optional()
    })
    .optional(),
  chunking: z
    .object({
      strategy: z.literal("hybrid").optional(),
      maxChars: z.number().int().positive().optional(),
      overlapChars: z.number().int().nonnegative().optional(),
      minChars: z.number().int().positive().optional(),
      headingPathDepth: z.number().int().positive().optional(),
      dontSplitInside: z.array(z.enum(["code", "table", "blockquote"])).optional()
    })
    .optional(),
  embeddings: z
    .object({
      provider: z.literal("openai").optional(),
      model: z.string().min(1).optional(),
      apiKeyEnv: z.string().min(1).optional(),
      batchSize: z.number().int().positive().optional(),
      concurrency: z.number().int().positive().optional(),
      pricePer1kTokens: z.number().positive().optional()
    })
    .optional(),
  vector: z
    .object({
      dimension: z.number().int().positive().optional(),
      turso: z
        .object({
          urlEnv: z.string().optional(),
          authTokenEnv: z.string().optional(),
          localPath: z.string().optional()
        })
        .optional()
    })
    .optional(),
  rerank: z
    .object({
      provider: z.enum(["none", "jina"]).optional(),
      topN: z.number().int().positive().optional(),
      jina: z
        .object({
          apiKeyEnv: z.string().optional(),
          model: z.string().optional()
        })
        .optional()
    })
    .optional(),
  ranking: z
    .object({
      enableIncomingLinkBoost: z.boolean().optional(),
      enableDepthBoost: z.boolean().optional(),
      pageWeights: z.record(z.string(), z.number().positive()).optional(),
      weights: z
        .object({
          incomingLinks: z.number().optional(),
          depth: z.number().optional(),
          rerank: z.number().optional(),
          aggregation: z.number().optional()
        })
        .optional()
    })
    .optional(),
  api: z
    .object({
      path: z.string().optional(),
      cors: z
        .object({
          allowOrigins: z.array(z.string()).optional()
        })
        .optional(),
      rateLimit: z
        .object({
          windowMs: z.number().int().positive().optional(),
          max: z.number().int().positive().optional()
        })
        .optional()
    })
    .optional(),
  mcp: z
    .object({
      enable: z.boolean().optional(),
      transport: z.enum(["stdio", "http"]).optional(),
      http: z
        .object({
          port: z.number().int().positive().optional(),
          path: z.string().optional()
        })
        .optional()
    })
    .optional(),
  state: z
    .object({
      dir: z.string().optional(),
      writeMirror: z.boolean().optional()
    })
    .optional()
});

export type ParsedSearchSocketConfig = z.infer<typeof searchSocketConfigSchema>;
