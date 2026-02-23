# SearchSocket

Semantic site search and MCP retrieval for SvelteKit content projects.

## Features

- **Embeddings**: OpenAI `text-embedding-3-small` (configurable)
- **Vector Backend**: Turso/libSQL with vector search (local file DB for development, remote for production)
- **Rerank**: Optional Jina reranker for improved relevance
- **SvelteKit Integrations**:
  - `searchsocketHandle()` for `POST /api/search` endpoint
  - `searchsocketVitePlugin()` for build-triggered indexing
- **MCP Server**: Model Context Protocol tools for search and page retrieval
- **Git-Tracked Markdown Mirror**: Commit-safe deterministic markdown outputs

## Install

```bash
pnpm add -D searchsocket
```

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

This:
- Crawls your static build output (default: `build/`)
- Extracts content from `<main>` (configurable)
- Chunks text with semantic heading boundaries
- Generates embeddings via OpenAI
- Stores vectors in Turso/libSQL with cosine similarity index
- Writes markdown mirror to `.searchsocket/pages/<scope>/`

### 6. Query

**Via API:**
```bash
curl -X POST http://localhost:5173/api/search \
  -H "content-type: application/json" \
  -d '{"q":"getting started","topK":5,"pathPrefix":"/docs"}'
```

**Via CLI:**
```bash
pnpm searchsocket search --q "getting started" --top-k 5 --path-prefix /docs
```

**Response:**
```json
{
  "q": "getting started",
  "scope": "main",
  "results": [
    {
      "url": "https://example.com/docs/intro",
      "title": "Getting Started",
      "sectionTitle": "Installation",
      "snippet": "Install SearchSocket with pnpm add searchsocket...",
      "score": 0.89,
      "routeFile": "src/routes/docs/intro/+page.svelte"
    }
  ],
  "meta": {
    "timingsMs": { "embed": 120, "vector": 15, "rerank": 0, "total": 135 },
    "usedRerank": false,
    "modelId": "text-embedding-3-small"
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
2. **Embedding**: Each chunk is sent to OpenAI's embedding API
3. **Batching**: Requests batched (64 texts per request) for efficiency
4. **Storage**: Vectors stored in Turso with metadata (URL, title, tags, depth, etc.)

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
- `build/` (static output)
- Content files (if using `source.mode: "content-files"`)

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

SearchSocket provides an **MCP server** for integration with Claude Desktop and other AI tools.

### Tools

**`search(query, opts?)`**
- Semantic search across indexed content
- Returns ranked results with snippets and metadata

**`get_page(pathOrUrl, opts?)`**
- Retrieve full page content from markdown mirror
- Returns markdown with frontmatter

### Setup (Claude Desktop)

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "searchsocket": {
      "command": "pnpm",
      "args": ["searchsocket", "mcp"],
      "cwd": "/path/to/your/project"
    }
  }
}
```

Restart Claude Desktop. The tools appear in the MCP menu.

## Environment Variables

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
    mode: "static-output", // "static-output" | "crawl" | "content-files"
    staticOutputDir: "build",
    strictRouteMapping: false
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
    dontSplitInside: ["code", "table", "blockquote"]
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
    weights: {
      incomingLinks: 0.05,
      depth: 0.03,
      rerank: 1.0
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

## Docs

- **[Config Reference](docs/config.md)** — Full configuration options
- **[CI/CD Workflows](docs/ci.md)** — GitHub Actions, Vercel, etc.

## License

MIT
