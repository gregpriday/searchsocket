# Using SearchSocket MCP with Claude Code over HTTP

SearchSocket exposes an MCP (Model Context Protocol) endpoint through its SvelteKit hook handler. When your SvelteKit app is running — locally via `npm run dev` or deployed to Vercel, Cloudflare, etc. — the MCP endpoint is available at `/api/mcp` by default.

This guide covers setting up Claude Code to connect to that endpoint over HTTP.

## Why HTTP over stdio?

SearchSocket also supports stdio transport (spawning a local process), but HTTP is the recommended approach:

- **No local process to manage** — the MCP server runs inside your existing SvelteKit app
- **Works with deployed sites** — connect to production, staging, or preview deployments
- **Serverless-compatible** — each request is a stateless JSON-RPC POST, no persistent connection needed
- **No env vars in MCP config** — credentials live in your SvelteKit app's environment, not in `.mcp.json`
- **Same server serves everything** — search API, MCP, and your site all run on the same process

## Server-side setup

The MCP endpoint is enabled automatically when you use `searchsocketHandle()` in your SvelteKit hooks. No additional configuration is required for local development.

In `src/hooks.server.ts`:

```ts
import { searchsocketHandle } from "searchsocket/sveltekit";

export const handle = searchsocketHandle();
```

The default MCP endpoint path is `/api/mcp`. You can customize it and add API key authentication via config:

```ts
export const handle = searchsocketHandle({
  rawConfig: {
    // ... other config
    mcp: {
      handle: {
        path: '/api/mcp',           // default
        apiKey: 'your-secret-key',  // optional — require Bearer token auth
        enableJsonResponse: true     // default, required for serverless
      }
    }
  }
});
```

The transport uses `WebStandardStreamableHTTPServerTransport` from `@modelcontextprotocol/sdk` with `enableJsonResponse: true`, making it fully stateless and serverless-compatible. Each request is an independent JSON-RPC POST — no session or persistent connection is needed.

## Claude Code configuration

Claude Code supports remote HTTP MCP servers natively. Add a `.mcp.json` file to your project root.

### Local development

Point to your local dev server:

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

Make sure your dev server is running (`npm run dev`) before starting Claude Code.

### Production (deployed site)

Point to your deployed site:

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

### With API key authentication

If you configured an `apiKey` on the server side, pass it via a Bearer token header:

```json
{
  "mcpServers": {
    "searchsocket": {
      "type": "http",
      "url": "https://your-site.com/api/mcp",
      "headers": {
        "Authorization": "Bearer ${SEARCHSOCKET_API_KEY}"
      }
    }
  }
}
```

The `${SEARCHSOCKET_API_KEY}` syntax references an environment variable so you don't hardcode secrets in `.mcp.json`.

### Auto-approving the MCP server

By default, Claude Code prompts for approval when an MCP tool is invoked. To skip the prompt, add the server to `.claude/settings.json`:

```json
{
  "allowedMcpServers": [
    { "serverName": "searchsocket" }
  ]
}
```

## Available MCP tools

Once connected, Claude Code has access to six tools:

### `search`

Semantic search across indexed content. Returns ranked results with URL, title, snippet, score, and `routeFile` (the SvelteKit source file path). When `groupBy` is `"page"` (default), results include a `chunks` array with section-level sub-results.

Parameters:
- `query` (string, required) — search query
- `scope` (string) — index scope
- `topK` (number, 1-100) — max results
- `pathPrefix` (string) — filter by URL prefix (e.g. `"/docs"`)
- `tags` (string[]) — filter by tags
- `filters` (object) — structured metadata filters (e.g. `{"version": 2}`)
- `groupBy` (`"page"` | `"chunk"`) — result grouping mode
- `maxSubResults` (number, 1-20) — max chunks per page result

### `get_page`

Fetch the full indexed markdown for a specific page, including frontmatter and `routeFile` mapping.

Parameters:
- `pathOrUrl` (string, required) — page path or URL
- `scope` (string) — index scope

### `list_pages`

List all indexed pages with cursor-based pagination. Returns URL, title, description, and `routeFile` for each page.

Parameters:
- `pathPrefix` (string) — filter by URL prefix
- `cursor` (string) — pagination cursor from previous response
- `limit` (number, 1-200) — page size
- `scope` (string) — index scope

### `get_site_structure`

Returns the hierarchical page tree derived from URL paths. Useful for understanding site navigation and scoping further operations.

Parameters:
- `pathPrefix` (string) — filter to a subtree
- `scope` (string) — index scope
- `maxPages` (number, 1-2000) — limit for large sites

### `find_source_file`

Find the SvelteKit source file for a piece of site content. Returns the URL, route file path, section title, and a content snippet. Use this when you need to locate and edit content.

Parameters:
- `query` (string, required) — search query describing the content
- `scope` (string) — index scope

### `get_related_pages`

Find pages related to a given URL using link graph, semantic similarity, and structural proximity. Returns related pages ranked by a composite relatedness score.

Parameters:
- `pathOrUrl` (string, required) — the page URL to find related content for
- `scope` (string) — index scope
- `topK` (number, 1-25) — max related pages to return

## Stdio alternative

For local development, you can also use stdio transport which spawns a local SearchSocket process:

```json
{
  "mcpServers": {
    "searchsocket": {
      "type": "stdio",
      "command": "npx",
      "args": ["searchsocket", "mcp"],
      "env": {
        "UPSTASH_SEARCH_REST_URL": "${UPSTASH_SEARCH_REST_URL}",
        "UPSTASH_SEARCH_REST_TOKEN": "${UPSTASH_SEARCH_REST_TOKEN}"
      }
    }
  }
}
```

This approach requires Upstash credentials in the MCP config and runs a separate process. The HTTP approach avoids both of these requirements.

## Verifying the connection

After configuring `.mcp.json`, restart Claude Code and verify the tools are available:

```bash
claude mcp list
```

You should see `searchsocket` listed with all six tools. You can then use natural language to search your site content directly from Claude Code — for example, "search my docs for authentication" or "find the source file for the getting started page".
