# SearchSocket Config Reference

Configuration file: `searchsocket.config.ts`

Minimal config:

```ts
export default {};
```

SearchSocket reads `UPSTASH_VECTOR_REST_URL` and `UPSTASH_VECTOR_REST_TOKEN` from your environment by default.

## Project

- `project.id` (default: `package.json` name) — unique identifier for the project
- `project.baseUrl` (optional) — canonical URL for the site

## Scope

- `scope.mode` (`fixed` | `git` | `env`, default `fixed`) — how the active scope is determined
- `scope.fixed` (default `main`) — scope name when mode is `fixed`
- `scope.envVar` (default `SEARCHSOCKET_SCOPE`) — env var to read when mode is `env`
- `scope.sanitize` (default `true`) — sanitize scope names (e.g., strip special characters)

## Source

- `source.mode` (`static-output` | `crawl` | `content-files` | `build`) — auto-detected if not set
- `source.staticOutputDir` (default `build`) — directory for prerendered HTML
- `source.strictRouteMapping` (default `false`) — require exact route file matches

### Build mode

- `source.build.outputDir` (default `.svelte-kit/output`)
- `source.build.previewTimeout` (default `30000`) — ms to wait for preview server
- `source.build.exclude` — glob patterns to skip (e.g., `["/api/*"]`)
- `source.build.paramValues` — values for dynamic routes (e.g., `{ "/blog/[slug]": ["hello-world"] }`)
- `source.build.discover` (default `false`) — crawl internal links to find pages
- `source.build.seedUrls` (default `["/"]`) — starting URLs for discovery
- `source.build.maxPages` (default `200`) — max pages to discover
- `source.build.maxDepth` (default `5`) — max link depth from seed URLs

### Crawl mode

- `source.crawl.baseUrl` (required) — URL of the running server
- `source.crawl.routes` (optional) — explicit route list
- `source.crawl.sitemapUrl` (optional) — sitemap URL for route discovery

### Content files mode

- `source.contentFiles.globs` (required) — glob patterns for source files (e.g., `["src/routes/**/*.md"]`)
- `source.contentFiles.baseDir` (default project root)

## Extraction

- `extract.mainSelector` (default `main`) — CSS selector for content area
- `extract.dropTags` (default `header`, `nav`, `footer`, `aside`) — HTML tags to remove before extraction
- `extract.dropSelectors` (default includes `.sidebar`, `.toc`, `.table-of-contents`, `.breadcrumbs`, `.breadcrumb`, `[role='navigation']`) — CSS selectors to remove
- `extract.ignoreAttr` (default `data-search-ignore`) — attribute that marks elements to skip
- `extract.noindexAttr` (default `data-search-noindex`) — attribute that marks entire pages to skip
- `extract.imageDescAttr` (default `data-search-description`) — attribute for explicit image descriptions. When present on an `<img>` or parent `<figure>`, the value is indexed as the image's text representation. See README "Making Images Searchable" for the full priority chain.
- `extract.respectRobotsNoindex` (default `true`) — honor `<meta name="robots" content="noindex">`

## Transform

- `transform.output` (`markdown`) — output format for extracted content
- `transform.preserveCodeBlocks` (default `true`) — keep code blocks intact
- `transform.preserveTables` (default `true`) — keep tables intact

## Chunking

- `chunking.strategy` (`hybrid`) — chunking strategy
- `chunking.maxChars` (default `1500`) — maximum characters per chunk
- `chunking.overlapChars` (default `200`) — overlap between consecutive chunks
- `chunking.minChars` (default `250`) — minimum characters per chunk (smaller chunks are merged)
- `chunking.headingPathDepth` (default `3`) — max heading depth for section path tracking
- `chunking.dontSplitInside` (default `["code", "table", "blockquote"]`) — block types to keep intact
- `chunking.prependTitle` (default `true`) — prepend page title to chunk text before indexing
- `chunking.pageSummaryChunk` (default `true`) — generate a synthetic identity chunk per page
- `chunking.weightHeadings` (default `true`) — boost heading text in chunks

## Upstash

- `upstash.urlEnv` (default `UPSTASH_VECTOR_REST_URL`) — env var for Upstash REST URL
- `upstash.tokenEnv` (default `UPSTASH_VECTOR_REST_TOKEN`) — env var for Upstash REST token
- `upstash.url` — direct Upstash REST URL (alternative to env var)
- `upstash.token` — direct Upstash REST token (alternative to env var)
- `upstash.namespaces.pages` (default `pages`) — namespace for page vectors
- `upstash.namespaces.chunks` (default `chunks`) — namespace for chunk vectors

## Embedding

Upstash handles embedding server-side via the `data` field. These settings must match the embedding model configured on your Upstash Vector index.

- `embedding.model` (default `bge-large-en-v1.5`) — embedding model name
- `embedding.dimensions` (default `1024`) — vector dimensions
- `embedding.taskType` (default `RETRIEVAL_DOCUMENT`) — embedding task type
- `embedding.batchSize` (default `100`) — vectors per upsert batch
- `embedding.images.enable` — unused, kept for backwards compatibility. Images are made searchable via text descriptions (`data-search-description`, `alt`, `figcaption`), not image embeddings.

### Non-English / multilingual sites

The default `bge-large-en-v1.5` model is English-specific. For multilingual content, create your Upstash Vector index with a multilingual model and update your config to match:

```ts
export default {
  embedding: {
    model: "bge-m3",          // multilingual model
    dimensions: 1024
  }
};
```

The model and dimensions must match what you selected when creating the Upstash Vector index. See [Upstash's embedding model list](https://upstash.com/docs/vector/features/embeddingmodels) for available options.

## Search

- `search.dualSearch` (default `true`) — run parallel page-level and chunk-level search
- `search.pageSearchWeight` (default `0.3`) — weight of page-level results vs chunks (0-1)

## Ranking

- `ranking.enableIncomingLinkBoost` (default `true`) — boost pages with more incoming links
- `ranking.enableDepthBoost` (default `true`) — boost shallower pages
- `ranking.enableFreshnessBoost` (default `false`) — boost recently published pages
- `ranking.freshnessDecayRate` (default `0.001`) — decay rate for freshness boost
- `ranking.enableAnchorTextBoost` (default `false`) — boost pages whose anchor text matches the query
- `ranking.pageWeights` (default `{}`) — per-URL score multipliers (e.g., `{ "/docs": 1.15 }`)
- `ranking.aggregationCap` (default `5`) — max chunks contributing to a page score
- `ranking.aggregationDecay` (default `0.5`) — decay factor for additional matching chunks
- `ranking.minChunkScoreRatio` (default `0.5`) — minimum chunk score relative to best chunk
- `ranking.minScore` (default `0.3`) — minimum absolute score to include in results
- `ranking.scoreGapThreshold` (default `0.4`) — trim results below best score minus this threshold

### Ranking weights

- `ranking.weights.incomingLinks` (default `0.05`)
- `ranking.weights.depth` (default `0.03`)
- `ranking.weights.aggregation` (default `0.1`)
- `ranking.weights.titleMatch` (default `0.15`)
- `ranking.weights.freshness` (default `0.1`)
- `ranking.weights.anchorText` (default `0.10`)

## API

- `api.path` (default `/api/search`) — search endpoint path
- `api.cors.allowOrigins` (default `[]`) — allowed CORS origins
- `api.rateLimit.windowMs` (optional) — rate limit window in milliseconds
- `api.rateLimit.max` (optional) — max requests per window

## MCP

- `mcp.enable` (default `true` in dev, `false` in prod) — enable MCP server
- `mcp.access` (`public` | `private`, default `private`) — access level
- `mcp.transport` (`stdio` | `http`, default `stdio`) — transport protocol
- `mcp.http.port` (default `3338`) — HTTP server port
- `mcp.http.path` (default `/mcp`) — HTTP endpoint path
- `mcp.http.apiKey` (optional) — API key for HTTP transport
- `mcp.http.apiKeyEnv` (optional) — env var for HTTP API key
- `mcp.handle.path` (default `/api/mcp`) — SvelteKit handle endpoint path
- `mcp.handle.apiKey` (optional) — API key for handle endpoint
- `mcp.handle.enableJsonResponse` (default `true`) — enable JSON response format

## llms.txt

- `llmsTxt.enable` (default `false`) — generate llms.txt output
- `llmsTxt.outputPath` (default `static/llms.txt`) — output file path
- `llmsTxt.title` (optional) — custom title
- `llmsTxt.description` (optional) — custom description
- `llmsTxt.generateFull` (default `true`) — generate full content version
- `llmsTxt.serveMarkdownVariants` (default `false`) — serve markdown variants

## State

- `state.dir` (default `.searchsocket`) — state directory for indexing metadata

## Filtering

- `exclude` (default `[]`) — glob patterns for URLs to exclude from indexing
- `respectRobotsTxt` (default `true`) — honor robots.txt rules

## Indexing Hooks

Hooks let you transform pages and chunks during indexing. They're passed programmatically to the Vite plugin or the `IndexPipeline` — not via `searchsocket.config.ts`.

### Via the Vite plugin

```ts
// vite.config.ts
import { searchsocketVitePlugin } from "searchsocket/sveltekit";

export default {
  plugins: [
    sveltekit(),
    searchsocketVitePlugin({
      hooks: {
        // Modify or skip pages before chunking
        transformPage: async (page) => {
          // Skip draft pages
          if (page.frontmatter?.draft) return null;

          // Inject custom tags from frontmatter
          if (page.frontmatter?.tags) {
            page.tags = [...(page.tags ?? []), ...page.frontmatter.tags];
          }

          return page;
        },

        // Modify or skip individual chunks
        transformChunk: async (chunk) => {
          // Skip very short chunks
          if (chunk.chunkText.length < 100) return null;
          return chunk;
        },

        // Transform the full chunk array before indexing
        beforeIndex: async (chunks) => {
          console.log(`Indexing ${chunks.length} chunks`);
          return chunks;
        },

        // Run after indexing completes
        afterIndex: async (stats) => {
          console.log(`Indexed ${stats.chunks.total} chunks across ${stats.pages.total} pages`);
        }
      }
    })
  ]
};
```

### Hook reference

| Hook | Signature | Description |
|------|-----------|-------------|
| `transformPage` | `(page: ExtractedPage) => ExtractedPage \| null` | Modify or skip a page before chunking. Return `null` to exclude. |
| `transformChunk` | `(chunk: Chunk) => Chunk \| null` | Modify or skip a chunk. Return `null` to exclude. |
| `beforeIndex` | `(chunks: Chunk[]) => Chunk[]` | Transform the full chunk array before upserting to Upstash. |
| `afterIndex` | `(stats: IndexStats) => void` | Run after indexing completes. Receives indexing statistics. |

All hooks are async-compatible.

## Custom Records

Inject data from external sources (databases, APIs, CMS) into the search index alongside your site content. Custom records bypass HTML extraction and are processed directly as pages.

```ts
import { IndexPipeline } from "searchsocket";

const pipeline = await IndexPipeline.create({ cwd: process.cwd() });

await pipeline.run({
  customRecords: [
    {
      url: "/products/widget-pro",
      title: "Widget Pro",
      content: "The Widget Pro is our flagship product with 50GB storage and real-time sync.",
      tags: ["product", "featured"],
      metadata: { category: "widgets", price: "49.99" },
      weight: 1.2
    },
    {
      url: "/products/widget-lite",
      title: "Widget Lite",
      content: "Widget Lite is the free tier with 5GB storage.",
      tags: ["product", "free-tier"]
    }
  ]
});
```

Custom records receive the same `transformPage` hook treatment as regular pages, and are tagged with their URL path segments automatically.

## Environment Variables

Required:

- `UPSTASH_VECTOR_REST_URL` — Upstash Vector REST API endpoint
- `UPSTASH_VECTOR_REST_TOKEN` — Upstash Vector REST API token

Optional:

- `SEARCHSOCKET_SCOPE` — override scope (when `scope.mode: "env"`)
- `SEARCHSOCKET_AUTO_INDEX` — enable build-triggered indexing (`1`, `true`, or `yes`)
- `SEARCHSOCKET_DISABLE_AUTO_INDEX` — disable build-triggered indexing
- `SEARCHSOCKET_FORCE_REINDEX` — force full re-index in CI/CD (`1`, `true`, or `yes`)
