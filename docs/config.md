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
- `chunking.weightHeadings` — **removed in 1.0.** It only changed the chunk
  content hash; the weighted heading text never reached the embedding model, so
  it caused re-embedding churn without affecting relevance. Use
  `chunking.prependTitle`.

## Upstash

- `upstash.urlEnv` (default `UPSTASH_VECTOR_REST_URL`) — env var for Upstash REST URL
- `upstash.tokenEnv` (default `UPSTASH_VECTOR_REST_TOKEN`) — env var for Upstash REST token
- `upstash.url` — direct Upstash REST URL (alternative to env var)
- `upstash.token` — direct Upstash REST token (alternative to env var)
- `upstash.namespaces.pages` (default `pages`) — namespace for page vectors
- `upstash.namespaces.chunks` (default `chunks`) — namespace for chunk vectors
- `upstash.batchSize` (default `90`, max `500`) — records per upsert/delete/fetch request
- `upstash.maxRetries` (default `2`, max `10`) — retries for transient backend failures
  (rate limits, timeouts, 5xx). Authorization and filter-syntax errors are never
  retried. The Upstash SDK separately retries network failures on its own, so
  raising this multiplies with those attempts.

## Embedding

Upstash handles embedding server-side via the `data` field. These settings must match the embedding model configured on your Upstash Vector index.

- `embedding.model` (default `bge-large-en-v1.5`) — embedding model name
- `embedding.dimensions` (default `1024`) — vector dimensions
- `embedding.taskType` (default `RETRIEVAL_DOCUMENT`) — embedding task type
- `embedding.batchSize` — **removed in 1.0.** It never affected anything at
  runtime. Use `upstash.batchSize`. Setting it now produces a migration error
  rather than being silently ignored.
- `embedding.images.enable` — **removed in 1.0.** SearchSocket is text-only.
  Images are made searchable via their text descriptions
  (`data-search-description`, `alt`, `figcaption`), never image embeddings.

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

Search is page-first: one query ranks pages, then the best-matching sections
within the top pages are retrieved as sub-results. There is no `search` config
section — `search.dualSearch` and `search.pageSearchWeight` described a parallel
blended retrieval path that the default search stopped using, and setting either
now produces a migration error. Tune ranking through `ranking.weights`.

### API access policy

- `api.allowedScopes` (default `[]`) — scopes a browser request may select with
  `?scope=` or a `scope` field in a POST body. Empty means the caller cannot
  choose and always gets the server's configured scope; anything else is a 403.
- `api.exposeInternalFields` (default `false`) — include `routeFile` (a path in
  your repository) and `chunkText` (the matched section's indexed text) in
  browser search responses, and `routeFile` in page responses. Off by default.

### MCP access

- `mcp.enable` (default `NODE_ENV !== "production"`) — mount the MCP endpoint on
  the SvelteKit handle.
- `mcp.handle.apiKey` / `mcp.handle.apiKeyEnv` — **required** for the endpoint to
  serve anything. MCP returns repository paths, a page's indexed markdown, and any
  scope the caller names, so without a key the route answers 503.
- `mcp.access` (default `private`) — governs the **standalone** MCP server only:
  whether it binds to loopback or all interfaces. It has no effect on the
  SvelteKit handle route, which always requires a key.

## Ranking

- `ranking.enableIncomingLinkBoost` (default `true`) — boost pages with more incoming links
- `ranking.enableDepthBoost` (default `true`) — boost shallower pages
- `ranking.enableFreshnessBoost` (default `false`) — boost recently published pages
- `ranking.freshnessDecayRate` (default `0.001`) — decay rate for freshness boost
- `ranking.enableAnchorTextBoost` (default `false`) — boost pages whose anchor text matches the query
- `ranking.pageWeights` (default `{}`) — per-URL score multipliers (e.g.,
  `{ "/docs": 1.15 }`). A page's own `searchsocket-weight` / frontmatter weight
  takes precedence, except that a `0` from either source excludes the page.
- `ranking.minScoreRatio` (default `0.70`) — drop results scoring below this
  fraction of the best result
- `ranking.scoreGapThreshold` (default `0.4`) — trim results below best score minus this threshold

#### API access policy

- `api.allowedScopes` (default `[]`) — scopes a browser request may select with
  `?scope=` or a `scope` field in a POST body. Empty means the caller cannot
  choose and always gets the server's configured scope; anything else is a 403.
- `api.exposeInternalFields` (default `false`) — include `routeFile` (a path in
  your repository) and `chunkText` (the matched section's indexed text) in
  browser search responses, and `routeFile` in page responses. Off by default.

### MCP access

- `mcp.enable` (default `NODE_ENV !== "production"`) — mount the MCP endpoint on
  the SvelteKit handle.
- `mcp.handle.apiKey` / `mcp.handle.apiKeyEnv` — **required** for the endpoint to
  serve anything. MCP returns repository paths, a page's indexed markdown, and any
  scope the caller names, so without a key the route answers 503.
- `mcp.access` (default `private`) — governs the **standalone** MCP server only:
  whether it binds to loopback or all interfaces. It has no effect on the
  SvelteKit handle route, which always requires a key.

## Ranking weights

- `ranking.weights.incomingLinks` (default `0.05`)
- `ranking.weights.depth` (default `0.03`)
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

Custom records receive the same `transformPage` hook treatment as regular pages,
and are tagged with their URL path segments automatically. `metadata` becomes
filterable page metadata, the same as `searchsocket:` meta tags on a real page.

### Deletion semantics

Each run's `customRecords` is treated as the complete set from its caller, so a
record present last run and absent this run is removed — the same rule the site
source follows.

Omitting the option entirely is different from passing an empty array:

```ts
await pipeline.run({});                     // says nothing; existing custom records are kept
await pipeline.run({ customRecords: [] });  // asserts there are none; existing ones are removed
```

This matters because custom records live in the same index as site pages. A
plain `searchsocket index` — from the CLI or the Vite plugin — passes no
`customRecords`, and previously deleted every one of them as "no longer
present". A provider that merely failed to run once took its content with it.
To remove custom records, call `run()` programmatically with an explicit list
(or an empty one).

## Environment Variables

Required:

- `UPSTASH_VECTOR_REST_URL` — Upstash Vector REST API endpoint
- `UPSTASH_VECTOR_REST_TOKEN` — Upstash Vector REST API token

Optional:

- `SEARCHSOCKET_SCOPE` — override scope (when `scope.mode: "env"`)
- `SEARCHSOCKET_AUTO_INDEX` — enable build-triggered indexing (`1`, `true`, or `yes`)
- `SEARCHSOCKET_DISABLE_AUTO_INDEX` — disable build-triggered indexing
- `SEARCHSOCKET_FORCE_REINDEX` — force full re-index in CI/CD (`1`, `true`, or `yes`)
