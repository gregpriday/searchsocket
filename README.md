# SearchSocket

Semantic site search and MCP retrieval for SvelteKit content projects.

**Requirements**: Node.js >= 20

## Features

- **Embeddings**: OpenAI `text-embedding-3-small` (configurable)
- **Vector Backend**: Turso/libSQL with vector search (local file DB for development, remote for production)
- **Rerank**: Optional Jina reranker for improved relevance
- **Page Aggregation**: Group results by page with score-weighted chunk decay
- **Meta Extraction**: Automatically extracts `<meta name="description">` and `<meta name="keywords">` for improved relevance
- **SvelteKit Integrations**:
  - `searchsocketHandle()` for `POST /api/search` endpoint
  - `searchsocketVitePlugin()` for build-triggered indexing
- **Client Library**: `createSearchClient()` for browser-side search
- **MCP Server**: Model Context Protocol tools for search and page retrieval
- **Git-Tracked Markdown Mirror**: Commit-safe deterministic markdown outputs

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
  embeddings: { apiKeyEnv: "OPENAI_API_KEY" }
};
```

**That's it!** Turso defaults work out of the box:
- **Development**: Uses local file DB at `.searchsocket/vectors.db`
- **Production**: Set `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` to use remote Turso

### 3. Add SvelteKit API Hook

Create or update `src/hooks.server.ts`:

```ts
import { searchsocketHandle } from "searchsocket/sveltekit";

export const handle = searchsocketHandle();
```

This exposes `POST /api/search` with automatic scope resolution.

### 4. Set Environment Variables

The CLI automatically loads `.env` from the working directory on startup, so your existing `.env` file works out of the box — no wrapper scripts or shell exports needed.

Development (`.env`):
```bash
OPENAI_API_KEY=sk-...
```

Production (add these for remote Turso):
```bash
OPENAI_API_KEY=sk-...
TURSO_DATABASE_URL=libsql://your-db.turso.io
TURSO_AUTH_TOKEN=eyJ...
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
- Prepends page title to each chunk for embedding context
- Generates a synthetic summary chunk per page for identity matching
- Generates embeddings via OpenAI
- Stores vectors in Turso/libSQL with cosine similarity index

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
    "timingsMs": { "embed": 120, "vector": 15, "rerank": 0, "total": 135 },
    "usedRerank": false,
    "modelId": "text-embedding-3-small"
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
      }
    }
  }
};
```

Best for: CI/CD pipelines. Enables `vite build && searchsocket index` with zero route configuration.

**How it works**:
1. Parses `.svelte-kit/output/server/manifest-full.js` to discover all page routes
2. Expands dynamic routes using `paramValues` (skips dynamic routes without values)
3. Starts an ephemeral `vite preview` server on a random port
4. Fetches all routes concurrently for SSR-rendered HTML
5. Provides exact route-to-file mapping (no heuristic matching needed)
6. Shuts down the preview server

**Dynamic routes**: Each key in `paramValues` maps to a route ID (e.g., `/blog/[slug]`) or its URL equivalent. Each value in the array replaces all `[param]` segments in the URL. Routes with layout groups like `/(app)/blog/[slug]` also match the URL key `/blog/[slug]`.

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
  tags: ["guide"],
  rerank: true
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

## Vector Backend: Turso/libSQL

SearchSocket uses **Turso** (libSQL) as its single vector backend, providing a unified experience across development and production.

### Local Development

By default, SearchSocket uses a **local file database**:
- Path: `.searchsocket/vectors.db` (configurable)
- No account or API keys needed
- Full vector search with `libsql_vector_idx` and `vector_top_k`
- Perfect for local development and CI testing

### Production (Remote Turso)

For production, switch to **Turso's hosted service**:

1. **Sign up for Turso** (free tier available):
   ```bash
   # Install Turso CLI
   brew install tursodatabase/tap/turso

   # Sign up
   turso auth signup

   # Create a database
   turso db create searchsocket-prod

   # Get credentials
   turso db show searchsocket-prod --url
   turso db tokens create searchsocket-prod
   ```

2. **Set environment variables**:
   ```bash
   TURSO_DATABASE_URL=libsql://searchsocket-prod-xxx.turso.io
   TURSO_AUTH_TOKEN=eyJhbGc...
   ```

3. **Index normally** — SearchSocket auto-detects the remote URL and uses it.

### Why Turso?

- **Single backend** — no more choosing between Pinecone, Milvus, or local JSON
- **Local-first development** — zero external dependencies for local dev
- **Production-ready** — same codebase scales to remote hosted DB
- **Cost-effective** — Turso free tier includes 9GB storage, 500M row reads/month
- **Vector search native** — `F32_BLOB` vectors, cosine similarity index, `vector_top_k` ANN queries

## Embeddings: OpenAI

SearchSocket uses **OpenAI's embedding models** to convert text into semantic vectors.

### Default Model

- **Model**: `text-embedding-3-small`
- **Dimensions**: 1536
- **Cost**: ~$0.00002 per 1K tokens (~4K chars)

### How It Works

1. **Chunking**: Text is split into semantic chunks (default 2200 chars, 200 overlap)
2. **Title Prepend**: Page title is prepended to each chunk for better context (`chunking.prependTitle`, default: true)
3. **Summary Chunk**: A synthetic identity chunk is generated per page with title, URL, and first paragraph (`chunking.pageSummaryChunk`, default: true)
4. **Embedding**: Each chunk is sent to OpenAI's embedding API
5. **Batching**: Requests batched (64 texts per request) for efficiency
6. **Storage**: Vectors stored in Turso with metadata (URL, title, tags, depth, etc.)

### Cost Estimation

Use `--dry-run` to preview costs:
```bash
pnpm searchsocket index --dry-run
```

Output:
```
pages processed: 42
chunks total: 156
chunks changed: 156
embeddings created: 156
estimated tokens: 32,400
estimated cost (USD): $0.000648
```

### Custom Model

Override in config:
```ts
export default {
  embeddings: {
    provider: "openai",
    model: "text-embedding-3-large",  // 3072 dims, higher quality
    apiKeyEnv: "OPENAI_API_KEY",
    pricePer1kTokens: 0.00013
  }
};
```

**Note**: Changing the model after indexing requires re-indexing with `--force`.

## Search & Ranking

### Page Aggregation

By default (`groupBy: "page"`), SearchSocket groups chunk results by page URL and computes a page-level score:

1. The top chunk score becomes the base page score
2. Additional matching chunks contribute a decaying bonus: `chunk_score * decay^i`
3. Optional per-URL page weights are applied multiplicatively

Configure aggregation behavior:

```ts
export default {
  ranking: {
    aggregationCap: 5,          // max chunks contributing to page score (default: 5)
    aggregationDecay: 0.5,      // decay factor for additional chunks (default: 0.5)
    minChunkScoreRatio: 0.5,    // threshold for sub-chunks in results (default: 0.5)
    pageWeights: {              // per-URL score multipliers
      "/": 1.1,
      "/docs": 1.15,
      "/download": 1.2
    },
    weights: {
      aggregation: 0.1,        // weight of aggregation bonus (default: 0.1)
      incomingLinks: 0.05,     // incoming link boost weight (default: 0.05)
      depth: 0.03,             // URL depth boost weight (default: 0.03)
      rerank: 1.0              // reranker score weight (default: 1.0)
    }
  }
};
```

`pageWeights` supports exact URL matches and prefix matching. A weight of `1.15` on `"/docs"` boosts all pages under `/docs/` by 15%. Use gentle values (1.05-1.2x) since they compound with aggregation.

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

## Git-Tracked Markdown Mirror

Indexing writes a **deterministic markdown mirror**:

```
.searchsocket/pages/<scope>/<path>.md
```

Example:
```
.searchsocket/pages/main/docs/intro.md
```

Each file contains:
- Frontmatter: URL, title, scope, route file, metadata
- Markdown: Extracted content

**Why commit it?**
- Content workflows (edit markdown, regenerate embeddings)
- Version control for indexed content
- Debugging (see exactly what was indexed)
- Offline search (grep the mirror)

Add to `.gitignore` if you don't need it:
```
.searchsocket/pages/
```

## Commands

### `searchsocket init`

Initialize config and state directory.

```bash
pnpm searchsocket init
```

### `searchsocket index`

Index content into vectors.

```bash
# Incremental (only changed chunks)
pnpm searchsocket index --changed-only

# Full re-index
pnpm searchsocket index --force

# Preview cost without indexing
pnpm searchsocket index --dry-run

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

Show indexing status, scope, and vector health.

```bash
pnpm searchsocket status

# Output:
# project: my-site
# resolved scope: main
# embedding model: text-embedding-3-small
# vector backend: turso/libsql (local (.searchsocket/vectors.db))
# vector health: ok
# last indexed (main): 2025-02-23T10:30:00Z
# tracked chunks: 156
# last estimated tokens: 32,400
# last estimated cost: $0.000648
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

Delete local state and optionally remote vectors.

```bash
# Local state only
pnpm searchsocket clean

# Local + remote vectors
pnpm searchsocket clean --remote --scope staging
```

### `searchsocket prune`

Delete stale scopes (e.g., deleted git branches).

```bash
# Dry run (shows what would be deleted)
pnpm searchsocket prune --older-than 30d

# Apply deletions
pnpm searchsocket prune --older-than 30d --apply

# Use custom scope list
pnpm searchsocket prune --scopes-file active-branches.txt --apply
```

### `searchsocket doctor`

Validate config, env vars, and connectivity.

```bash
pnpm searchsocket doctor

# Output:
# PASS config parse
# PASS env OPENAI_API_KEY
# PASS turso/libsql (local file: .searchsocket/vectors.db)
# PASS source: build manifest
# PASS source: vite binary
# PASS embedding provider connectivity
# PASS vector backend connectivity
# PASS vector backend write permission
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
pnpm searchsocket search --q "turso vector search" --top-k 5 --rerank
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

The CLI automatically loads `.env` from the working directory on startup. Existing `process.env` values take precedence over `.env` file values. This only applies to CLI commands (`searchsocket index`, `searchsocket mcp`, etc.) — library imports like `searchsocketHandle()` rely on your framework's own `.env` handling (Vite/SvelteKit).

### Required

**OpenAI:**
- `OPENAI_API_KEY` — OpenAI API key for embeddings

### Optional (Turso)

**Remote Turso (production):**
- `TURSO_DATABASE_URL` — Turso database URL (e.g., `libsql://my-db.turso.io`)
- `TURSO_AUTH_TOKEN` — Turso auth token

If not set, uses local file DB at `.searchsocket/vectors.db`.

### Optional (Rerank)

**Jina:**
- `JINA_API_KEY` — Jina reranker API key (if using `rerank: { provider: "jina" }`)

### Optional (Scope/Build)

- `SEARCHSOCKET_SCOPE` — Override scope (when `scope.mode: "env"`)
- `SEARCHSOCKET_AUTO_INDEX` — Enable build-triggered indexing
- `SEARCHSOCKET_DISABLE_AUTO_INDEX` — Disable build-triggered indexing

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
      }
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
    respectRobotsNoindex: true
  },

  chunking: {
    maxChars: 2200,
    overlapChars: 200,
    minChars: 250,
    headingPathDepth: 3,
    dontSplitInside: ["code", "table", "blockquote"],
    prependTitle: true,       // prepend page title to chunk text before embedding
    pageSummaryChunk: true    // generate synthetic identity chunk per page
  },

  embeddings: {
    provider: "openai",
    model: "text-embedding-3-small",
    apiKeyEnv: "OPENAI_API_KEY",
    batchSize: 64,
    concurrency: 4
  },

  vector: {
    dimension: 1536,  // optional, inferred from first embedding
    turso: {
      urlEnv: "TURSO_DATABASE_URL",
      authTokenEnv: "TURSO_AUTH_TOKEN",
      localPath: ".searchsocket/vectors.db"
    }
  },

  rerank: {
    provider: "jina",  // "none" | "jina"
    topN: 20,
    jina: {
      apiKeyEnv: "JINA_API_KEY",
      model: "jina-reranker-v2-base-multilingual"
    }
  },

  ranking: {
    enableIncomingLinkBoost: true,
    enableDepthBoost: true,
    pageWeights: {
      "/": 1.1,
      "/docs": 1.15
    },
    aggregationCap: 5,
    aggregationDecay: 0.5,
    minChunkScoreRatio: 0.5,
    weights: {
      incomingLinks: 0.05,
      depth: 0.03,
      rerank: 1.0,
      aggregation: 0.1
    }
  },

  api: {
    path: "/api/search",
    cors: {
      allowOrigins: ["https://example.com"]
    },
    rateLimit: {
      windowMs: 60_000,
      max: 60
    }
  }
};
```

## License

MIT
