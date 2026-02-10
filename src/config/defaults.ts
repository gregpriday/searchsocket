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
      dontSplitInside: ["code", "table", "blockquote"]
    },
    embeddings: {
      provider: "openai",
      model: "text-embedding-3-small",
      apiKeyEnv: "OPENAI_API_KEY",
      batchSize: 64,
      concurrency: 8
    },
    vector: {
      provider: "milvus",
      pinecone: {
        apiKeyEnv: "PINECONE_API_KEY",
        index: projectId,
        namespaceMode: "scope"
      },
      milvus: {
        uriEnv: "MILVUS_URI",
        tokenEnv: "MILVUS_TOKEN",
        collection: `${projectId}_chunks`
      },
      local: {
        path: ".searchsocket/local-vectors.sqlite"
      }
    },
    rerank: {
      provider: "none",
      topN: 20,
      jina: {
        apiKeyEnv: "JINA_API_KEY",
        model: "jina-reranker-v2-base-multilingual"
      }
    },
    ranking: {
      enableIncomingLinkBoost: true,
      enableDepthBoost: true,
      weights: {
        incomingLinks: 0.05,
        depth: 0.03,
        rerank: 1.0
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
