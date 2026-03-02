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
  exclude: z.array(z.string()).optional(),
  respectRobotsTxt: z.boolean().optional(),
  source: z
    .object({
      mode: z.enum(["static-output", "crawl", "content-files", "build"]).optional(),
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
        .optional(),
      build: z
        .object({
          outputDir: z.string().min(1).optional(),
          paramValues: z.record(z.string(), z.array(z.string())).optional(),
          exclude: z.array(z.string()).optional(),
          previewTimeout: z.number().int().positive().optional(),
          discover: z.boolean().optional(),
          seedUrls: z.array(z.string()).optional(),
          maxPages: z.number().int().positive().optional(),
          maxDepth: z.number().int().nonnegative().optional()
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
      dontSplitInside: z.array(z.enum(["code", "table", "blockquote"])).optional(),
      prependTitle: z.boolean().optional(),
      pageSummaryChunk: z.boolean().optional()
    })
    .optional(),
  upstash: z
    .object({
      url: z.string().url().optional(),
      token: z.string().min(1).optional(),
      urlEnv: z.string().min(1).optional(),
      tokenEnv: z.string().min(1).optional()
    })
    .optional(),
  search: z
    .object({
      semanticWeight: z.number().min(0).max(1).optional(),
      inputEnrichment: z.boolean().optional()
    })
    .optional(),
  ranking: z
    .object({
      enableIncomingLinkBoost: z.boolean().optional(),
      enableDepthBoost: z.boolean().optional(),
      pageWeights: z.record(z.string(), z.number().min(0)).optional(),
      aggregationCap: z.number().int().positive().optional(),
      aggregationDecay: z.number().min(0).max(1).optional(),
      minChunkScoreRatio: z.number().min(0).max(1).optional(),
      minScore: z.number().min(0).max(1).optional(),
      weights: z
        .object({
          incomingLinks: z.number().optional(),
          depth: z.number().optional(),
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
      dir: z.string().optional()
    })
    .optional()
});

export type ParsedSearchSocketConfig = z.infer<typeof searchSocketConfigSchema>;
