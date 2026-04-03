# SearchSocket

Semantic site search and MCP retrieval for SvelteKit content projects. Index your site, search it from the browser or AI tools, and scroll users to the exact content they're looking for.

**Requirements**: Node.js >= 20 | **Backend**: [Upstash Vector](https://upstash.com/docs/vector/overall/getstarted) | **License**: MIT

## How it works

```
SvelteKit Pages → Extractor (Cheerio + Turndown) → Chunker → Upstash Vector
                                                                    ↓
                    Search UI ← SvelteKit API Hook ← Search Engine + Ranking
                                       ↓
                              MCP Endpoint → Claude Code / Claude Desktop
```

SearchSocket extracts content from your SvelteKit site, converts it to markdown, splits it into chunks, and stores them in Upstash Vector. At runtime, the SvelteKit hook serves both a search API for your frontend and an MCP endpoint for AI tools.

## Features

- **Semantic + keyword search** — Upstash Vector handles hybrid search with built-in reranking and input enrichment
- **Dual search** — parallel page-level and chunk-level queries with configurable score blending
- **Scroll-to-text** — auto-scroll to the matching section when a user clicks a search result, with CSS Highlight API and Text Fragment support
- **SvelteKit integration** — server hook for the search API, Vite plugin for build-triggered indexing
- **Svelte 5 components** — reactive `createSearch` store and `<SearchSocket>` metadata component
- **MCP server** — six tools for Claude Code, Claude Desktop, and other MCP clients (stdio + HTTP)
- **llms.txt generation** — auto-generate LLM-friendly site indexes during indexing
- **Four source modes** — index from static output, build manifest, a running server, or raw markdown files
- **CLI** — init, index, search, dev, status, doctor, clean, prune, test, mcp, add

## Install

```bash
pnpm add -D searchsocket
```

SearchSocket is typically a dev dependency since indexing runs at build time. If you use `searchsocketHandle()` at runtime (e.g., in a Node server adapter or serving the MCP endpoint from a production deployment), add it as a regular dependency:

```bash
pnpm add searchsocket
```

## Quickstart

### 1. Initialize

```bash
pnpm searchsocket init
```

Creates `searchsocket.config.ts`, the `.searchsocket/` state directory, wires up your SvelteKit hooks and Vite config, and generates `.mcp.json` for Claude Code.

### 2. Configure

Minimal config (`searchsocket.config.ts`):

```ts
export default {};
```

That's it — defaults handle the rest. SearchSocket reads `UPSTASH_VECTOR_REST_URL` and `UPSTASH_VECTOR_REST_TOKEN` from your environment automatically.

### 3. Set environment variables

```bash
# .env
UPSTASH_VECTOR_REST_URL=https://...
UPSTASH_VECTOR_REST_TOKEN=...
```

Create an [Upstash Vector index](https://console.upstash.com/vector) with the `bge-large-en-v1.5` embedding model (1024 dimensions). Copy the REST URL and token.

### 4. Add the SvelteKit hook

The `init` command does this for you, but if you need to do it manually:

```ts
// src/hooks.server.ts
import { searchsocketHandle } from "searchsocket/sveltekit";

export const handle = searchsocketHandle();
```

This exposes `POST /api/search`, `GET /api/search/health`, the MCP endpoint at `/api/mcp`, and page retrieval routes.

If you run into SSR bundling issues, mark SearchSocket as external in your Vite config:

```ts
// vite.config.ts
export default defineConfig({
  plugins: [sveltekit()],
  ssr: {
    external: ["searchsocket", "searchsocket/sveltekit", "searchsocket/client"]
  }
});
```

### 5. Add search to your frontend

Copy the search dialog template into your project:

```bash
pnpm searchsocket add search-dialog
```

This copies a Svelte 5 component to `src/lib/components/search/SearchDialog.svelte` with Cmd+K built in. Import it in your layout and add the scroll-to-text handler:

```svelte
<!-- src/routes/+layout.svelte -->
<script>
  import { afterNavigate } from "$app/navigation";
  import { searchsocketScrollToText } from "searchsocket/sveltekit";
  import SearchDialog from "$lib/components/search/SearchDialog.svelte";

  afterNavigate(searchsocketScrollToText);
</script>

<SearchDialog />

<slot />
```

Users can now press Cmd+K to search. See [Building a Search UI](docs/search-ui.md) for scoped search, custom styling, and more patterns.

### 6. Deploy

SearchSocket is designed to index automatically on deploy. The `init` command already added the Vite plugin to your config. Set these environment variables on your hosting platform (Vercel, Cloudflare, etc.):

| Variable | Value |
|----------|-------|
| `UPSTASH_VECTOR_REST_URL` | Your Upstash Vector REST URL |
| `UPSTASH_VECTOR_REST_TOKEN` | Your Upstash Vector REST token |
| `SEARCHSOCKET_AUTO_INDEX` | `1` |

Every deploy will build your site, index the content, and serve the search API — fully automated.

For local testing, you can also build and index manually:

```bash
pnpm build
pnpm searchsocket index
```

### 7. Connect Claude Code (optional)

Point Claude Code at your deployed site's MCP endpoint:

```json
{
  "mcpServers": {
    "searchsocket": {
      "type": "http",
      "url": "https://your-site.com/api/mcp"
    }
  }
}
```

See [MCP Server](#mcp-server) for authentication and other options.

### Querying the API directly

The search API is also available via HTTP and CLI:

```bash
# cURL
curl -X POST http://localhost:5173/api/search \
  -H "content-type: application/json" \
  -d '{"q":"getting started","topK":5,"groupBy":"page"}'

# CLI
pnpm searchsocket search --q "getting started" --top-k 5
```

### Response format

With `groupBy: "page"` (the default):

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

The `chunks` array contains matching sections within each page. Use `groupBy: "chunk"` for flat per-chunk results without page aggregation.

## Source Modes

SearchSocket supports four ways to load your site content for indexing.

### `static-output` (default)

Reads prerendered HTML files from SvelteKit's build output directory.

```ts
export default {
  source: {
    mode: "static-output",
    staticOutputDir: "build"   // default
  }
};
```

Best for fully prerendered sites. Run `vite build` first, then `searchsocket index`.

### `build`

Discovers routes from SvelteKit's build manifest and renders via an ephemeral `vite preview` server. No manual route lists needed.

```ts
export default {
  source: {
    mode: "build",
    build: {
      exclude: ["/api/*", "/admin/*"],
      paramValues: {
        "/blog/[slug]": ["hello-world", "getting-started"],
        "/docs/[category]/[page]": ["guides/quickstart", "api/search"]
      },
      discover: true,        // crawl internal links to find more pages
      seedUrls: ["/"],
      maxPages: 200,
      maxDepth: 5
    }
  }
};
```

Best for CI/CD pipelines: `vite build && searchsocket index` with zero route configuration.

### `crawl`

Fetches pages from a running HTTP server.

```ts
export default {
  source: {
    mode: "crawl",
    crawl: {
      baseUrl: "http://localhost:4173",
      routes: ["/", "/docs", "/blog"],
      sitemapUrl: "https://example.com/sitemap.xml"
    }
  }
};
```

### `content-files`

Reads markdown and Svelte source files directly, without building or serving.

```ts
export default {
  source: {
    mode: "content-files",
    contentFiles: {
      globs: ["src/routes/**/*.md", "content/**/*.md"],
      baseDir: "."
    }
  }
};
```

## Client Library

### `createSearchClient(options?)`

Lightweight browser-side search client.

```ts
import { createSearchClient } from "searchsocket/client";

const client = createSearchClient({
  endpoint: "/api/search",   // default
  fetchImpl: fetch            // override for SSR or testing
});

const { results } = await client.search({
  q: "deployment guide",
  topK: 8,
  groupBy: "page",
  pathPrefix: "/docs",
  tags: ["guide"],
  filters: { version: 2 },
  maxSubResults: 3
});
```

### `buildResultUrl(result)`

Builds a URL from a search result that includes scroll-to-text metadata:

- `_ssk` query parameter — section title for SvelteKit client-side navigation
- `_sskt` query parameter — text target snippet for precise scroll
- `#:~:text=` — [Text Fragment](https://developer.mozilla.org/en-US/docs/Web/URI/Fragment/Text_fragments) for native browser scroll on full page loads

```ts
import { buildResultUrl } from "searchsocket/client";

const href = buildResultUrl(result);
// "/docs/getting-started?_ssk=Installation&_sskt=Install+with+pnpm#:~:text=Install%20with%20pnpm"
```

## Svelte 5 Integration

### `createSearch(options?)`

A reactive search store built on Svelte 5 runes with debouncing and LRU caching.

```svelte
<script>
  import { createSearch } from "searchsocket/svelte";
  import { buildResultUrl } from "searchsocket/client";

  const search = createSearch({
    endpoint: "/api/search",
    debounce: 250,            // ms (default)
    cache: true,              // LRU result caching (default)
    cacheSize: 50,            // max cached queries (default)
    topK: 10,
    groupBy: "page",
    pathPrefix: "/docs"       // scope search to a section
  });
</script>

<input bind:value={search.query} placeholder="Search docs..." />

{#if search.loading}
  <p>Searching...</p>
{/if}

{#if search.error}
  <p class="error">{search.error.message}</p>
{/if}

{#each search.results as result}
  <a href={buildResultUrl(result)}>
    <strong>{result.title}</strong>
    {#if result.sectionTitle}
      <span>— {result.sectionTitle}</span>
    {/if}
  </a>
  <p>{result.snippet}</p>
{/each}
```

Call `search.destroy()` to clean up when no longer needed (automatic in component context).

### `<SearchSocket>` component

Declarative meta tag component for controlling per-page search behavior:

```svelte
<script>
  import { SearchSocket } from "searchsocket/svelte";
</script>

<!-- Boost this page's search ranking -->
<SearchSocket weight={1.2} />

<!-- Exclude from search -->
<SearchSocket noindex />

<!-- Add filterable tags -->
<SearchSocket tags={["guide", "advanced"]} />

<!-- Add structured metadata (filterable via search API) -->
<SearchSocket meta={{ version: 2, category: "api" }} />
```

The component renders `<meta>` tags in `<svelte:head>` that SearchSocket reads during indexing.

### Template components

Copy ready-made search UI components into your project:

```bash
pnpm searchsocket add search-dialog
pnpm searchsocket add search-input
pnpm searchsocket add search-results
```

These are Svelte 5 components copied to `src/lib/components/search/` (configurable via `--dir`). They're starting points to customize, not dependencies.

## Scroll-to-Text Navigation

When a user clicks a search result, SearchSocket scrolls them to the matching section on the destination page.

### Setup

Add the scroll handler to your root layout:

```svelte
<!-- src/routes/+layout.svelte -->
<script>
  import { afterNavigate } from '$app/navigation';
  import { searchsocketScrollToText } from 'searchsocket/sveltekit';

  afterNavigate(searchsocketScrollToText);
</script>
```

### How it works

1. `buildResultUrl()` encodes the section title and text snippet into the URL
2. On SvelteKit client-side navigation, the `afterNavigate` hook reads `_ssk`/`_sskt` params
3. A TreeWalker-based text mapper finds the exact position in the DOM
4. The page scrolls smoothly to the match
5. The matching text is highlighted using the [CSS Custom Highlight API](https://developer.mozilla.org/en-US/docs/Web/API/CSS_Custom_Highlight_API) (with a DOM fallback for older browsers)
6. On full page loads, browsers that support Text Fragments (`#:~:text=`) handle scrolling natively

The highlight fades after 2 seconds. Customize with CSS:

```css
::highlight(ssk-highlight) {
  background-color: rgba(250, 204, 21, 0.4);
}
```

## Search & Ranking

### Dual search

By default, SearchSocket runs two parallel queries — one against page-level summaries and one against individual chunks — then blends the scores:

```ts
export default {
  search: {
    dualSearch: true,          // default
    pageSearchWeight: 0.3      // weight of page results vs chunks (0-1)
  }
};
```

### Page aggregation

With `groupBy: "page"` (default), chunk results are grouped by page URL:

1. The top chunk score becomes the base page score
2. Additional matching chunks add a decaying bonus: `chunk_score * decay^i`
3. Per-URL page weights are applied multiplicatively

### Ranking configuration

```ts
export default {
  ranking: {
    enableIncomingLinkBoost: true,    // boost pages with more internal links pointing to them
    enableDepthBoost: true,           // boost shallower pages (/ > /docs > /docs/api)
    enableFreshnessBoost: false,      // boost recently published content
    enableAnchorTextBoost: false,     // boost pages whose link text matches the query

    pageWeights: {                    // per-URL score multipliers (prefix matching)
      "/": 0.95,
      "/docs": 1.15,
      "/download": 1.05
    },

    aggregationCap: 5,               // max chunks contributing to page score
    aggregationDecay: 0.5,           // decay for additional chunks
    minScoreRatio: 0.70,             // drop results below 70% of best score
    scoreGapThreshold: 0.4,          // trim results >40% below best
    minChunkScoreRatio: 0.5,         // threshold for sub-chunks

    weights: {
      incomingLinks: 0.05,
      depth: 0.03,
      aggregation: 0.1,
      titleMatch: 0.15,
      freshness: 0.1,
      anchorText: 0.10
    }
  }
};
```

Use gentle `pageWeights` values (0.9–1.2) since they compound with other boosts.

## Build-Triggered Indexing

The recommended workflow is to index automatically on every deploy. Add the Vite plugin to your config:

```ts
// vite.config.ts
import { sveltekit } from "@sveltejs/kit/vite";
import { searchsocketVitePlugin } from "searchsocket/sveltekit";

export default {
  plugins: [
    sveltekit(),
    searchsocketVitePlugin({
      changedOnly: true,    // incremental indexing (default)
      verbose: true
    })
  ]
};
```

### Vercel / Cloudflare / Netlify

Set these environment variables in your hosting platform:

| Variable | Value |
|----------|-------|
| `UPSTASH_VECTOR_REST_URL` | Your Upstash Vector REST URL |
| `UPSTASH_VECTOR_REST_TOKEN` | Your Upstash Vector REST token |
| `SEARCHSOCKET_AUTO_INDEX` | `1` |

Every deploy will build your site, index the content into Upstash, and serve the search API and MCP endpoint — fully automated.

### Environment variable control

```bash
# Enable indexing on build
SEARCHSOCKET_AUTO_INDEX=1 pnpm build

# Disable temporarily
SEARCHSOCKET_DISABLE_AUTO_INDEX=1 pnpm build

# Force full rebuild (ignore incremental cache)
SEARCHSOCKET_FORCE_REINDEX=1 pnpm build
```

## Making Images Searchable

SearchSocket converts images to text during extraction using this priority chain:

1. `data-search-description` on the `<img>` — your explicit description
2. `data-search-description` on the parent `<figure>`
3. `alt` text + `<figcaption>` combined
4. `alt` text alone (filters generic words like "image", "icon")
5. `<figcaption>` alone
6. Removed — images with no useful text are dropped

```html
<img
  src="/screenshots/settings.png"
  alt="Settings page"
  data-search-description="The settings page showing API key configuration, theme selection, and notification preferences"
/>
```

Works with SvelteKit's `enhanced:img`:

```svelte
<enhanced:img
  src="./screenshots/dashboard.png"
  alt="Dashboard"
  data-search-description="Main dashboard showing active projects and indexing status"
/>
```

## MCP Server

SearchSocket includes an MCP server that gives Claude Code, Claude Desktop, and other MCP clients direct access to your site's search index. The MCP endpoint is built into `searchsocketHandle()` — once your site is deployed, any MCP client can connect to it over HTTP.

### Available tools

| Tool | Description |
|------|-------------|
| `search` | Semantic search with filtering, grouping, and reranking |
| `get_page` | Retrieve full page markdown with frontmatter |
| `list_pages` | Cursor-paginated page listing |
| `get_site_structure` | Hierarchical page tree |
| `find_source_file` | Locate the SvelteKit source file for content |
| `get_related_pages` | Find related pages by links, semantics, and structure |

### Connecting to your deployed site

The recommended setup is to connect Claude Code to your deployed site's MCP endpoint. This way the index stays up to date automatically as you deploy, and there's no local process to manage.

Add `.mcp.json` to your project root:

```json
{
  "mcpServers": {
    "searchsocket": {
      "type": "http",
      "url": "https://your-site.com/api/mcp"
    }
  }
}
```

That's it. Restart Claude Code and the six search tools are available. You can search your docs, retrieve page content, and find source files directly from the AI assistant.

To protect the endpoint, add API key authentication:

```ts
// src/hooks.server.ts
export const handle = searchsocketHandle({
  rawConfig: {
    mcp: {
      handle: {
        apiKey: process.env.SEARCHSOCKET_MCP_API_KEY
      }
    }
  }
});
```

Then pass the key in `.mcp.json`:

```json
{
  "mcpServers": {
    "searchsocket": {
      "type": "http",
      "url": "https://your-site.com/api/mcp",
      "headers": {
        "Authorization": "Bearer ${SEARCHSOCKET_MCP_API_KEY}"
      }
    }
  }
}
```

The `${SEARCHSOCKET_MCP_API_KEY}` syntax references an environment variable so you don't hardcode secrets in `.mcp.json`.

### Auto-approving in Claude Code

Skip the approval prompt each time a tool is called:

```json
{
  "allowedMcpServers": [
    { "serverName": "searchsocket" }
  ]
}
```

Add this to `.claude/settings.json` in your project.

### Local development

During local development, you can point to your dev server instead:

```json
{
  "mcpServers": {
    "searchsocket": {
      "type": "http",
      "url": "http://localhost:5173/api/mcp"
    }
  }
}
```

### Claude Desktop

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

### Standalone HTTP server

Run the MCP server as a standalone process (outside SvelteKit):

```bash
pnpm searchsocket mcp --transport http --port 3338
```

## llms.txt Generation

Generate [llms.txt](https://llmstxt.org/) files during indexing — a standardized way to make your site content available to LLMs.

```ts
export default {
  project: {
    baseUrl: "https://example.com"
  },
  llmsTxt: {
    enable: true,
    title: "My Project",
    description: "Documentation for My Project",
    outputPath: "static/llms.txt",    // default
    generateFull: true,                // also generate llms-full.txt
    serveMarkdownVariants: false       // serve /page.md variants via the hook
  }
};
```

After indexing, `llms.txt` (page index with links) and `llms-full.txt` (full content) are written to your static directory and served by `searchsocketHandle()`.

## CLI Commands

### `searchsocket init`

Initialize config and state directory. Creates `searchsocket.config.ts`, `.searchsocket/`, `.mcp.json`, and wires up your hooks and Vite config.

```bash
pnpm searchsocket init
pnpm searchsocket init --non-interactive
```

### `searchsocket index`

Index content into Upstash Vector.

```bash
pnpm searchsocket index                    # incremental (default: --changed-only)
pnpm searchsocket index --force            # full re-index
pnpm searchsocket index --source build     # override source mode
pnpm searchsocket index --scope staging    # override scope
pnpm searchsocket index --dry-run          # preview without writing
pnpm searchsocket index --max-pages 10     # limit for testing
pnpm searchsocket index --verbose          # detailed output
pnpm searchsocket index --json             # machine-readable output
```

### `searchsocket search`

CLI search for testing.

```bash
pnpm searchsocket search --q "getting started" --top-k 5
pnpm searchsocket search --q "api" --path-prefix /docs
```

### `searchsocket dev`

Watch for file changes and auto-reindex, with optional playground UI.

```bash
pnpm searchsocket dev                                # watch + playground at :3337
pnpm searchsocket dev --mcp --mcp-port 3338          # also start MCP HTTP server
pnpm searchsocket dev --no-playground                 # watch only
```

### `searchsocket status`

Show indexing status and backend health.

```bash
pnpm searchsocket status
```

### `searchsocket doctor`

Validate config, env vars, provider connectivity, and write access.

```bash
pnpm searchsocket doctor
```

### `searchsocket test`

Run search quality assertions against the live index.

```bash
pnpm searchsocket test                              # uses searchsocket.test.json
pnpm searchsocket test --file custom-tests.json     # custom test file
```

Test file format:

```json
[
  {
    "query": "installation guide",
    "expect": {
      "topResult": "/docs/getting-started",
      "inTop5": ["/docs/getting-started", "/docs/quickstart"]
    }
  }
]
```

Reports pass/fail per assertion and Mean Reciprocal Rank (MRR) across all queries.

### `searchsocket clean`

Delete local state and optionally remote indexes.

```bash
pnpm searchsocket clean                    # local state only
pnpm searchsocket clean --remote           # also delete remote scope
pnpm searchsocket clean --scope staging    # specific scope
```

### `searchsocket prune`

List and delete stale scopes. Compares against git branches to find orphaned scopes.

```bash
pnpm searchsocket prune                       # dry-run (default)
pnpm searchsocket prune --apply               # actually delete
pnpm searchsocket prune --older-than 30d      # only scopes older than 30 days
```

### `searchsocket mcp`

Run the MCP server standalone.

```bash
pnpm searchsocket mcp                                   # stdio (default)
pnpm searchsocket mcp --transport http --port 3338       # HTTP
pnpm searchsocket mcp --access public --api-key SECRET   # public with auth
```

### `searchsocket add`

Copy Svelte 5 search UI template components into your project.

```bash
pnpm searchsocket add search-dialog
pnpm searchsocket add search-input
pnpm searchsocket add search-results
pnpm searchsocket add search-dialog --dir src/lib/components/ui  # custom dir
```

## Real-World Example

Here's how [Canopy](https://canopy.dev) integrates SearchSocket into a production SvelteKit site.

### Configuration

```ts
// searchsocket.config.ts
export default {
  project: {
    id: "canopy-website",
    baseUrl: "https://canopy.dev"
  },
  source: {
    mode: "build"
  },
  extract: {
    dropSelectors: [".nav-blur", ".mobile-overlay", ".docs-sidebar"]
  },
  ranking: {
    minScoreRatio: 0.70,
    pageWeights: {
      "/": 0.95,
      "/download": 1.05,
      "/docs/**": 1.05
    },
    aggregationCap: 3,
    aggregationDecay: 0.3
  }
};
```

### Server hook

```ts
// src/hooks.server.ts
import { searchsocketHandle } from "searchsocket/sveltekit";
import { env } from "$env/dynamic/private";

export const handle = searchsocketHandle({
  rawConfig: {
    project: { id: "canopy-website", baseUrl: "https://canopy.dev" },
    source: { mode: "build" },
    upstash: {
      url: env.UPSTASH_VECTOR_REST_URL,
      token: env.UPSTASH_VECTOR_REST_TOKEN
    },
    extract: {
      dropSelectors: [".nav-blur", ".mobile-overlay", ".docs-sidebar"]
    },
    ranking: {
      minScoreRatio: 0.70,
      pageWeights: { "/": 0.95, "/download": 1.05, "/docs/**": 1.05 },
      aggregationCap: 3,
      aggregationDecay: 0.3
    }
  }
});
```

### Search modal with scoped search

```svelte
<!-- SearchModal.svelte -->
<script>
  import { createSearchClient, buildResultUrl } from "searchsocket/client";

  let { open = $bindable(false), pathPrefix = "", placeholder = "Search..." } = $props();

  const client = createSearchClient();
  let query = $state("");
  let results = $state([]);

  async function doSearch() {
    if (!query.trim()) { results = []; return; }
    const res = await client.search({
      q: query,
      topK: 8,
      groupBy: "page",
      pathPrefix: pathPrefix || undefined
    });
    results = res.results;
  }
</script>

{#if open}
  <dialog open>
    <input bind:value={query} oninput={doSearch} {placeholder} />
    {#each results as result}
      <a href={buildResultUrl(result)} onclick={() => open = false}>
        <strong>{result.title}</strong>
        {#if result.sectionTitle}<span>— {result.sectionTitle}</span>{/if}
        <p>{result.snippet}</p>
      </a>
    {/each}
  </dialog>
{/if}
```

### Scroll-to-text in layout

```svelte
<!-- src/routes/+layout.svelte -->
<script>
  import { afterNavigate } from "$app/navigation";
  import { searchsocketScrollToText } from "searchsocket/sveltekit";

  afterNavigate(searchsocketScrollToText);
</script>
```

### Deploy and index

Indexing runs automatically on every Vercel deploy. Set these env vars in the Vercel dashboard:

- `UPSTASH_VECTOR_REST_URL`
- `UPSTASH_VECTOR_REST_TOKEN`
- `SEARCHSOCKET_AUTO_INDEX=1`

The Vite plugin handles the rest. Alternatively, use a postbuild script:

```json
{
  "scripts": {
    "build": "vite build",
    "postbuild": "searchsocket index"
  }
}
```

### Connect Claude Code to the deployed site

```json
{
  "mcpServers": {
    "searchsocket": {
      "type": "http",
      "url": "https://canopy.dev/api/mcp"
    }
  }
}
```

Now Claude Code can search the live docs, retrieve page content, and find source files — all backed by the production index that stays current with every deploy.

### Excluding pages from search

```svelte
<!-- src/routes/blog/+page.svelte (archive page) -->
<svelte:head>
  <meta name="searchsocket-weight" content="0" />
</svelte:head>
```

Or with the component:

```svelte
<script>
  import { SearchSocket } from "searchsocket/svelte";
</script>

<SearchSocket weight={0} />
```

### Vite SSR config

```ts
// vite.config.ts
import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [sveltekit()],
  ssr: {
    external: ["searchsocket", "searchsocket/sveltekit", "searchsocket/client"]
  }
});
```

## Environment Variables

### Required

| Variable | Description |
|----------|-------------|
| `UPSTASH_VECTOR_REST_URL` | Upstash Vector REST API endpoint |
| `UPSTASH_VECTOR_REST_TOKEN` | Upstash Vector REST API token |

### Optional

| Variable | Description |
|----------|-------------|
| `GEMINI_API_KEY` | Google Gemini API key — only for experimental image embedding (`embedding.images.enable: true`). Not needed for standard text search. |
| `SEARCHSOCKET_SCOPE` | Override scope (when `scope.mode: "env"`) |
| `SEARCHSOCKET_AUTO_INDEX` | Enable build-triggered indexing (`1`, `true`, or `yes`) |
| `SEARCHSOCKET_DISABLE_AUTO_INDEX` | Disable build-triggered indexing |
| `SEARCHSOCKET_FORCE_REINDEX` | Force full re-index in CI/CD |

The CLI automatically loads `.env` from the working directory on startup.

## Configuration Reference

See [docs/config.md](docs/config.md) for the full configuration reference. Here's the full example:

```ts
export default {
  project: {
    id: "my-site",
    baseUrl: "https://example.com"
  },

  scope: {
    mode: "git",                 // "fixed" | "git" | "env"
    fixed: "main",
    sanitize: true
  },

  exclude: ["/admin/*", "/api/*"],
  respectRobotsTxt: true,

  source: {
    mode: "build",
    staticOutputDir: "build",
    build: {
      exclude: ["/api/*"],
      paramValues: {
        "/blog/[slug]": ["hello-world", "getting-started"]
      },
      discover: true,
      maxPages: 200
    }
  },

  extract: {
    mainSelector: "main",
    dropTags: ["header", "nav", "footer", "aside"],
    dropSelectors: [".sidebar", ".toc"],
    ignoreAttr: "data-search-ignore",
    noindexAttr: "data-search-noindex",
    imageDescAttr: "data-search-description"
  },

  chunking: {
    maxChars: 1500,
    overlapChars: 200,
    minChars: 250,
    prependTitle: true,
    pageSummaryChunk: true
  },

  upstash: {
    urlEnv: "UPSTASH_VECTOR_REST_URL",
    tokenEnv: "UPSTASH_VECTOR_REST_TOKEN"
  },

  search: {
    dualSearch: true,
    pageSearchWeight: 0.3
  },

  ranking: {
    enableIncomingLinkBoost: true,
    enableDepthBoost: true,
    pageWeights: { "/docs": 1.15 },
    minScoreRatio: 0.70,
    aggregationCap: 5,
    aggregationDecay: 0.5
  },

  api: {
    path: "/api/search",
    cors: { allowOrigins: ["https://example.com"] }
  },

  mcp: {
    enable: true,
    handle: { path: "/api/mcp" }
  },

  llmsTxt: {
    enable: true,
    title: "My Project",
    description: "Documentation for My Project"
  },

  state: {
    dir: ".searchsocket"
  }
};
```

## CI/CD

See [docs/ci.md](docs/ci.md) for ready-to-use GitHub Actions workflows covering:

- Main branch indexing on push
- PR dry-run validation
- Preview branch scope isolation
- Scheduled scope pruning
- Vercel build-triggered indexing

## Further Reading

- [Building a Search UI](docs/search-ui.md) — Cmd+K modals, scoped search, styling, and API reference
- [Tuning Search Relevance](docs/tuning.md) — visual playground, ranking parameters, and search quality testing
- [Configuration Reference](docs/config.md) — all config options, indexing hooks, and custom records
- [CI/CD Workflows](docs/ci.md) — GitHub Actions and Vercel integration
- [MCP over HTTP Guide](docs/mcp-claude-code.md) — detailed HTTP MCP setup for Claude Code
- [Troubleshooting](docs/troubleshooting.md) — common issues, diagnostics, and FAQ

## License

MIT
