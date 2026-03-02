import type { ResolvedSearchSocketConfig } from "../types";

export const DEFAULT_DROP_SELECTORS = [
  ".sidebar",
  ".toc",
  ".table-of-contents",
  ".breadcrumbs",
  ".breadcrumb",
  "[role='navigation']"
];

export function createDefaultConfig(projectId: string): ResolvedSearchSocketConfig {
  return {
    project: {
      id: projectId
    },
    scope: {
      mode: "fixed",
      fixed: "main",
      envVar: "SEARCHSOCKET_SCOPE",
      sanitize: true
    },
    exclude: [],
    respectRobotsTxt: true,
    source: {
      mode: "static-output",
      staticOutputDir: "build",
      strictRouteMapping: false
    },
    extract: {
      mainSelector: "main",
      dropTags: ["header", "nav", "footer", "aside"],
      dropSelectors: DEFAULT_DROP_SELECTORS,
      ignoreAttr: "data-search-ignore",
      noindexAttr: "data-search-noindex",
      respectRobotsNoindex: true
    },
    transform: {
      output: "markdown",
      preserveCodeBlocks: true,
      preserveTables: true
    },
    chunking: {
      strategy: "hybrid",
      maxChars: 2200,
      overlapChars: 200,
      minChars: 250,
      headingPathDepth: 3,
      dontSplitInside: ["code", "table", "blockquote"],
      prependTitle: true,
      pageSummaryChunk: true
    },
    upstash: {
      urlEnv: "UPSTASH_SEARCH_REST_URL",
      tokenEnv: "UPSTASH_SEARCH_REST_TOKEN"
    },
    search: {
      semanticWeight: 0.75,
      inputEnrichment: true
    },
    ranking: {
      enableIncomingLinkBoost: true,
      enableDepthBoost: true,
      pageWeights: {},
      aggregationCap: 5,
      aggregationDecay: 0.5,
      minChunkScoreRatio: 0.5,
      minScore: 0,
      weights: {
        incomingLinks: 0.05,
        depth: 0.03,
        aggregation: 0.1
      }
    },
    api: {
      path: "/api/search",
      cors: {
        allowOrigins: []
      }
    },
    mcp: {
      enable: process.env.NODE_ENV !== "production",
      transport: "stdio",
      http: {
        port: 3338,
        path: "/mcp"
      }
    },
    state: {
      dir: ".searchsocket"
    }
  };
}
