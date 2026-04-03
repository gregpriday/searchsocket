# SearchSocket

Semantic site search and MCP retrieval for SvelteKit content projects.

**Requirements**: Node.js >= 20

## Features

- **Unified Search Backend**: Upstash Search handles both semantic and keyword search with intelligent result blending
- **Dual Search**: Parallel page-level and chunk-level semantic search with configurable score weighting
- **Reranking**: Upstash Search native reranking for improved relevance
- **Input Enrichment**: Query understanding via Upstash Search input enrichment
- **Scroll-to-Text Navigation**: Auto-scroll to matching sections on search result navigation using TreeWalker text mapping and CSS Highlight API
- **SvelteKit Integrations**:
  - `searchsocketHandle()` for `POST /api/search` endpoint
  - `searchsocketVitePlugin()` for build-triggered indexing
- **Client Library**: `createSearchClient()` for browser-side search, `buildResultUrl()` for scroll-to-section links
- **MCP Server**: Model Context Protocol tools for search and page retrieval

## Install

```bash
# pnpm
pnpm add -D searchsocket

# npm
npm install -D searchsocket
```

SearchSocket is typically a dev dependency for CLI indexing. If you use `searchsocketHandle()` at runtime (e.g., in a Node server adapter), add it as a regular dependency instead.

## Quickstart

### 1. Initialize

```bash
pnpm searchsocket init
```

This creates:
- `searchsocket.config.ts` — minimal config file
- `.searchsocket/` — state directory (added to `.gitignore`)

### 2. Configure

Minimal config (`searchsocket.config.ts`):

```ts
export default {
  upstash: {
    urlEnv: "UPSTASH_SEARCH_REST_URL",
    tokenEnv: "UPSTASH_SEARCH_REST_TOKEN"
  }
};
```

That's it! Defaults handle the rest.

### 3. Add SvelteKit API Hook

Create or update `src/hooks.server.ts`:

```ts
import { searchsocketHandle } from "searchsocket/sveltekit";

export const handle = searchsocketHandle();
```

This exposes `POST /api/search` with automatic scope resolution.

### 4. Set Environment Variables

```bash
# .env (development or CI)
UPSTASH_SEARCH_REST_URL=https://...
UPSTASH_SEARCH_REST_TOKEN=...
```

### 5. Index Your Content

```bash
pnpm searchsocket index --changed-only
```

SearchSocket auto-detects the source mode based on your config:
- **`static-output`** (default): Reads prerendered HTML from `build/`
- **`build`**: Discovers routes from SvelteKit build manifest and renders via preview server
- **`crawl`**: Fetches pages from a running HTTP server
- **`content-files`**: Reads markdown/svelte source files directly

The indexing pipeline:
- Extracts content from `<main>` (configurable), including `<meta>` description and keywords
- Chunks text with semantic heading boundaries
- Stores chunks in Upstash Search with content (searchable) and metadata (non-searchable)
- Generates full-page documents for page-level search

### 6. Query

**Via API:**
```bash
curl -X POST http://localhost:5173/api/search \
  -H "content-type: application/json" \
  -d '{"q":"getting started","topK":5,"groupBy":"page"}'
```

**Via client library:**
```ts
import { createSearchClient } from "searchsocket/client";

const client = createSearchClient(); // defaults to /api/search
const response = await client.search({
  q: "getting started",
  topK: 5,
  groupBy: "page",
  pathPrefix: "/docs"
});
```

**Via CLI:**
```bash
pnpm searchsocket search --q "getting started" --top-k 5 --path-prefix /docs
```

**Response** (with `groupBy: "page"`, the default):
```json
{
  "q": "getting started",
  "scope": "main",
  "results": [
    {
      "url": "/docs/intro",
      "title": "Getting Started",
      "sectionTitle": "Installation",
      "snippet": "Install SearchSocket with pnpm add searchsocket...",
      "score": 0.89,
      "routeFile": "src/routes/docs/intro/+page.svelte",
      "chunks": [
        {
          "sectionTitle": "Installation",
          "snippet": "Install SearchSocket with pnpm add searchsocket...",
          "headingPath": ["Getting Started", "Installation"],
          "score": 0.89
        },
        {
          "sectionTitle": "Configuration",
          "snippet": "Create searchsocket.config.ts with your API key...",
          "headingPath": ["Getting Started", "Configuration"],
          "score": 0.74
        }
      ]
    }
  ],
  "meta": {
    "timingsMs": { "total": 135 }
  }
}
```

The `chunks` array appears when a page has multiple matching chunks above the `minChunkScoreRatio` threshold. Use `groupBy: "chunk"` for flat per-chunk results without page aggregation.

## Source Modes

SearchSocket supports four source modes for loading pages to index.

### `static-output` (default)

Reads prerendered HTML files from SvelteKit's build output directory.

```ts
export default {
  source: {
    mode: "static-output",
    staticOutputDir: "build"
  }
};
```

Best for: Sites with fully prerendered pages. Run `vite build` first, then index.

### `build`

Discovers routes automatically from SvelteKit's build manifest and renders them via an ephemeral `vite preview` server. No manual route configuration needed.

```ts
export default {
  source: {
    build: {
      outputDir: ".svelte-kit/output",   // default
      previewTimeout: 30000,             // ms to wait for server (default)
      exclude: ["/api/*", "/admin/*"],   // glob patterns to skip
      paramValues: {                     // values for dynamic routes
        "/blog/[slug]": ["hello-world", "getting-started"],
        "/docs/[category]/[page]": ["guides/quickstart", "api/search"]
      },
      discover: true,                    // crawl internal links to find pages (default: false)
      seedUrls: ["/"],                   // starting URLs for discovery
      maxPages: 200,                     // max pages to discover (default: 200)
      maxDepth: 5                        // max link depth from seed URLs (default: 5)
    }
  }
};
```

Best for: CI/CD pipelines. Enables `vite build && searchsocket index` with zero route configuration.

### `crawl`

Fetches pages from a running HTTP server.

```ts
export default {
  source: {
    crawl: {
      baseUrl: "http://localhost:4173",
      routes: ["/", "/docs", "/blog"],  // explicit routes
      sitemapUrl: "https://example.com/sitemap.xml"  // or discover via sitemap
    }
  }
};
```

If `routes` is omitted and no `sitemapUrl` is set, defaults to crawling `["/"]` only.

### `content-files`

Reads markdown and svelte source files directly, without building or serving.

```ts
export default {
  source: {
    contentFiles: {
      globs: ["src/routes/**/*.md", "content/**/*.md"],
      baseDir: "."
    }
  }
};
```

## Client Library

SearchSocket exports a lightweight client for browser-side search:

```ts
import { createSearchClient } from "searchsocket/client";

const client = createSearchClient({
  endpoint: "/api/search",  // default
  fetchImpl: fetch           // default; override for SSR or testing
});

const response = await client.search({
  q: "deployment guide",
  topK: 8,
  groupBy: "page",
  pathPrefix: "/docs",
  tags: ["guide"]
});

for (const result of response.results) {
  console.log(result.url, result.title, result.score);
  if (result.chunks) {
    for (const chunk of result.chunks) {
      console.log("  ", chunk.sectionTitle, chunk.score);
    }
  }
}
```

## Scroll-to-Text Navigation

When a visitor clicks a search result, SearchSocket can automatically scroll them to the relevant section on the destination page. This uses two utilities:

### `buildResultUrl(result)`

Builds a URL from a search result that includes:
- A `_ssk` query parameter for SvelteKit client-side navigation (read by `searchsocketScrollToText`)
- A [Text Fragment](https://developer.mozilla.org/en-US/docs/Web/URI/Fragment/Text_fragments) (`#:~:text=`) for native browser scroll-to-text on full page loads (Chrome 80+, Safari 16.1+, Firefox 131+)

Import from `searchsocket/client`:

```ts
import { createSearchClient, buildResultUrl } from "searchsocket/client";

const client = createSearchClient();
const { results } = await client.search({ q: "installation" });

// Use in your search UI
for (const result of results) {
  const href = buildResultUrl(result);
  // "/docs/getting-started?_ssk=Installation#:~:text=Installation"
}
```

If the result has no `sectionTitle`, the original URL is returned unchanged.

### `searchsocketScrollToText`

A SvelteKit `afterNavigate` hook that reads the `_ssk` parameter and scrolls the matching heading into view. Add it to your root layout:

```svelte
<!-- src/routes/+layout.svelte -->
<script>
  import { afterNavigate } from '$app/navigation';
  import { searchsocketScrollToText } from 'searchsocket/sveltekit';

  afterNavigate(searchsocketScrollToText);
</script>
```

The hook:
- Matches headings (h1–h6) case-insensitively with whitespace normalization
- Falls back to a broader text node search if no heading matches
- Scrolls smoothly to the first match using TreeWalker-based text mapping
- Applies CSS custom highlights (or DOM fallback) to matching text
- Is a silent no-op when `_ssk` is absent or no match is found

## Making Images Searchable

By default, SearchSocket converts images to text during extraction so they participate in search. The extractor resolves image text using this priority chain:

1. **`data-search-description` on the `<img>`** — highest priority, your explicit description
2. **`data-search-description` on the parent `<figure>`** — useful when you can't modify the `<img>` directly
3. **`alt` text + `<figcaption>`** — combined with a dash separator
4. **`alt` text alone** — if meaningful (filters out generic words like "image", "icon", "photo")
5. **`<figcaption>` alone** — if no meaningful alt text exists
6. **Removed** — images with no useful text are dropped from the index

### Using `data-search-description`

Add a `data-search-description` attribute to your images for the best search results. This gives you full control over how an image appears in search — describe what matters for findability, not just what's visible.

```html
<img
  src="/screenshots/settings.png"
  alt="Settings page"
  data-search-description="The settings page showing API key configuration, theme selection, and notification preferences"
/>
```

On a `<figure>`:

```html
<figure data-search-description="Architecture diagram showing the indexing pipeline from HTML extraction through chunking to Upstash vector storage">
  <img src="/diagrams/pipeline.svg" alt="Indexing pipeline" />
  <figcaption>Figure 1: Indexing pipeline overview</figcaption>
</figure>
```

When `data-search-description` is present, the figcaption is not included in the indexed text (the explicit description takes precedence).

### Works with SvelteKit Enhanced Images

SvelteKit's `enhanced:img` passes through all `data-*` attributes to the rendered HTML, so this works out of the box:

```svelte
<enhanced:img
  src="./screenshots/dashboard.png"
  alt="Dashboard"
  data-search-description="The main dashboard showing active projects, recent search queries, and indexing status indicators"
/>
```

### Tips

- **Describe what matters for search**, not visual details. "RBAC permissions configuration panel" is more useful than "a page with a blue sidebar and 14 menu items."
- **Include key terms** users might search for. If the screenshot shows a "worktree selector", say so.
- **Skip decorative images.** Images without alt text or descriptions are automatically excluded.
- The attribute name is configurable via `extract.imageDescAttr` (default: `data-search-description`).

## Vector Backend: Upstash Search

SearchSocket uses **Upstash Search** as its vector backend, a managed search service with built-in semantic and keyword search.

### Setup

1. **Create an Upstash Search index**:
   ```bash
   # Via Upstash console or CLI
   # https://console.upstash.com/search
   ```

2. **Get credentials**:
   ```
   UPSTASH_SEARCH_REST_URL=https://...
   UPSTASH_SEARCH_REST_TOKEN=...
   ```

3. **Set environment variables** in your `.env`:
   ```bash
   UPSTASH_SEARCH_REST_URL=https://...
   UPSTASH_SEARCH_REST_TOKEN=...
   ```

### How It Works

- **Content Storage**: Each indexed page is split into chunks; chunks are stored as documents with searchable content and metadata
- **Page Index**: Full-page summaries stored in a separate index for page-level search
- **Dual Search**: Parallel queries to both indexes with score blending
- **Semantic Search**: Upstash Search provides semantic search natively
- **Keyword Search**: Combined with semantic for hybrid results
- **Reranking**: Native Upstash Search reranking option
- **Input Enrichment**: Automatic query understanding

### Why Upstash Search?

- **Managed service** — no infrastructure to maintain
- **Semantic + keyword unified** — single index for both search types
- **Cost-effective** — pay per query, not per embedding
- **Native reranking & enrichment** — no additional APIs needed
- **Scope isolation** — separate indexes per scope (multi-branch support)

## Search & Ranking

### Page Aggregation

By default (`groupBy: "page"`), SearchSocket groups chunk results by page URL and computes a page-level score:

1. The top chunk score becomes the base page score
2. Additional matching chunks contribute a decaying bonus: `chunk_score * decay^i`
3. Optional per-URL page weights are applied multiplicatively

Configure aggregation behavior:

```ts
export default {
  search: {
    dualSearch: true,         // parallel page + chunk search (default: true)
    pageSearchWeight: 0.3     // weight of page-level results vs chunks (0-1)
  },
  ranking: {
    minScore: 0.3,            // minimum absolute score to include (default: 0.3)
    aggregationCap: 5,        // max chunks contributing to page score (default: 5)
    aggregationDecay: 0.5,    // decay factor for additional chunks (default: 0.5)
    minChunkScoreRatio: 0.5,  // threshold for sub-chunks in results (default: 0.5)
    scoreGapThreshold: 0.4,   // trim low-scoring results (default: 0.4)
    pageWeights: {            // per-URL score multipliers
      "/": 1.1,
      "/docs": 1.15,
      "/download": 1.2
    },
    weights: {
      incomingLinks: 0.05,    // incoming link boost weight
      depth: 0.03,            // URL depth boost weight
      aggregation: 0.1,       // aggregation bonus weight
      titleMatch: 0.15        // title match boost weight
    }
  }
};
```

`pageWeights` supports exact URL matches and prefix matching. A weight of `1.15` on `"/docs"` boosts all pages under `/docs/` by 15%. Use gentle values (1.05-1.2x) since they compound with aggregation.

`minScore` filters out low-relevance results before they reach the client. Set to a value like `0.3` (default) to remove noise. In page mode, pages below the threshold are dropped; in chunk mode, individual chunks are filtered.

### Chunk Mode

Use `groupBy: "chunk"` for flat per-chunk results without page aggregation:

```bash
curl -X POST http://localhost:5173/api/search \
  -H "content-type: application/json" \
  -d '{"q":"vector search","topK":10,"groupBy":"chunk"}'
```

## Build-Triggered Indexing

Automatically index after each SvelteKit build.

**`vite.config.ts` or `svelte.config.js`:**
```ts
import { searchsocketVitePlugin } from "searchsocket/sveltekit";

export default {
  plugins: [
    svelteKitPlugin(),
    searchsocketVitePlugin({
      enabled: true,        // or check process.env.SEARCHSOCKET_AUTO_INDEX
      changedOnly: true,    // incremental indexing (faster)
      verbose: false
    })
  ]
};
```

**Environment control:**
```bash
# Enable via env var
SEARCHSOCKET_AUTO_INDEX=1 pnpm build

# Disable via env var
SEARCHSOCKET_DISABLE_AUTO_INDEX=1 pnpm build
```

## Commands

### `searchsocket init`

Initialize config and state directory.

```bash
pnpm searchsocket init
```

### `searchsocket index`

Index content into Upstash Search.

```bash
# Incremental (only changed chunks)
pnpm searchsocket index --changed-only

# Full re-index
pnpm searchsocket index --force

# Override source mode
pnpm searchsocket index --source build

# Limit for testing
pnpm searchsocket index --max-pages 10 --max-chunks 50

# Override scope
pnpm searchsocket index --scope staging

# Verbose output
pnpm searchsocket index --verbose
```

### `searchsocket status`

Show indexing status and index health.

```bash
pnpm searchsocket status

# Output:
# project: my-site
# resolved scope: main
# vector backend: upstash-search
# vector health: ok
# indexed chunks: 156
```

### `searchsocket dev`

Watch for file changes and auto-reindex.

```bash
pnpm searchsocket dev

# With MCP server
pnpm searchsocket dev --mcp --mcp-port 3338
```

Watches:
- `src/routes/**` (route files)
- `build/` (if static-output mode)
- Build output dir (if build mode)
- Content files (if content-files mode)
- `searchsocket.config.ts` (if crawl or build mode)

### `searchsocket clean`

Delete all indexed content for a scope.

```bash
# Clean current scope
pnpm searchsocket clean

# Clean specific scope
pnpm searchsocket clean --scope staging
```

### `searchsocket doctor`

Validate config, env vars, and connectivity.

```bash
pnpm searchsocket doctor

# Output:
# PASS config parse
# PASS env UPSTASH_SEARCH_REST_URL
# PASS env UPSTASH_SEARCH_REST_TOKEN
# PASS upstash-search connectivity
# PASS upstash-search write permission
# PASS state directory writable
```

### `searchsocket mcp`

Run MCP server for Claude Desktop / other MCP clients.

```bash
# stdio transport (default)
pnpm searchsocket mcp

# HTTP transport
pnpm searchsocket mcp --transport http --port 3338
```

### `searchsocket search`

CLI search for testing.

```bash
pnpm searchsocket search --q "upstash search integration" --top-k 5
```

## MCP (Model Context Protocol)

SearchSocket provides an **MCP server** for integration with Claude Code, Claude Desktop, and other MCP-compatible AI tools. This gives AI assistants direct access to your indexed site content for semantic search and page retrieval.

### Tools

**`search(query, opts?)`**
- Semantic search across indexed content
- Returns ranked results with URL, title, snippet, score, and routeFile
- Options: `scope`, `topK` (1-100), `pathPrefix`, `tags`, `groupBy` (`"page"` | `"chunk"`)

**`get_page(pathOrUrl, opts?)`**
- Retrieve full indexed page content as markdown with frontmatter
- Options: `scope`

### Setup (Claude Code)

Add a `.mcp.json` file to your project root (safe to commit — no secrets needed since the CLI auto-loads `.env`):

```json
{
  "mcpServers": {
    "searchsocket": {
      "type": "stdio",
      "command": "npx",
      "args": ["searchsocket", "mcp"],
      "env": {}
    }
  }
}
```

Restart Claude Code. The `search` and `get_page` tools will be available automatically. Verify with:

```bash
claude mcp list
```

### Setup (Claude Desktop)

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "searchsocket": {
      "command": "npx",
      "args": ["searchsocket", "mcp"],
      "cwd": "/path/to/your/project"
    }
  }
}
```

Restart Claude Desktop. The tools appear in the MCP menu.

### HTTP Transport

For non-stdio clients, run the MCP server over HTTP:

```bash
npx searchsocket mcp --transport http --port 3338
```

This starts a stateless server at `http://127.0.0.1:3338/mcp`. Each POST request creates a fresh server instance with no session persistence.

## Environment Variables

### Required

**Upstash Search:**
- `UPSTASH_SEARCH_REST_URL` — Upstash Search REST API endpoint
- `UPSTASH_SEARCH_REST_TOKEN` — Upstash Search REST API token

### Optional

- `SEARCHSOCKET_SCOPE` — Override scope (when `scope.mode: "env"`)
- `SEARCHSOCKET_AUTO_INDEX` — Enable build-triggered indexing
- `SEARCHSOCKET_DISABLE_AUTO_INDEX` — Disable build-triggered indexing
- `SEARCHSOCKET_FORCE_REINDEX` — Force full re-index in CI/CD (`1`, `true`, or `yes`)

The CLI automatically loads `.env` from the working directory on startup.

## Configuration

### Full Example

```ts
export default {
  project: {
    id: "my-site",
    baseUrl: "https://example.com"
  },

  scope: {
    mode: "git",           // "fixed" | "git" | "env"
    fixed: "main",
    sanitize: true
  },

  source: {
    mode: "build",         // "static-output" | "crawl" | "content-files" | "build"
    staticOutputDir: "build",
    strictRouteMapping: false,

    // Build mode (recommended for CI/CD)
    build: {
      outputDir: ".svelte-kit/output",
      previewTimeout: 30000,
      exclude: ["/api/*"],
      paramValues: {
        "/blog/[slug]": ["hello-world", "getting-started"]
      },
      discover: false,
      seedUrls: ["/"],
      maxPages: 200,
      maxDepth: 5
    },

    // Crawl mode (alternative)
    crawl: {
      baseUrl: "http://localhost:4173",
      routes: ["/", "/docs", "/blog"],
      sitemapUrl: "https://example.com/sitemap.xml"
    },

    // Content files mode (alternative)
    contentFiles: {
      globs: ["src/routes/**/*.md"],
      baseDir: "."
    }
  },

  extract: {
    mainSelector: "main",
    dropTags: ["header", "nav", "footer", "aside"],
    dropSelectors: [".sidebar", ".toc"],
    ignoreAttr: "data-search-ignore",
    noindexAttr: "data-search-noindex",
    imageDescAttr: "data-search-description",
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
    prependTitle: true,       // prepend page title to chunk text before indexing
    pageSummaryChunk: true    // generate synthetic identity chunk per page
  },

  upstash: {
    urlEnv: "UPSTASH_SEARCH_REST_URL",
    tokenEnv: "UPSTASH_SEARCH_REST_TOKEN",
    // OR use direct credentials:
    // url: "https://...",
    // token: "..."
  },

  search: {
    dualSearch: true,         // parallel page + chunk search
    pageSearchWeight: 0.3     // page result boost factor (0-1)
  },

  ranking: {
    enableIncomingLinkBoost: true,
    enableDepthBoost: true,
    pageWeights: {
      "/": 1.1,
      "/docs": 1.15
    },
    minScore: 0.3,
    aggregationCap: 5,
    aggregationDecay: 0.5,
    minChunkScoreRatio: 0.5,
    scoreGapThreshold: 0.4,
    weights: {
      incomingLinks: 0.05,
      depth: 0.03,
      aggregation: 0.1,
      titleMatch: 0.15
    }
  },

  api: {
    path: "/api/search",
    cors: {
      allowOrigins: ["https://example.com"]
    }
  },

  mcp: {
    enable: true,
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
```

## License

MIT
