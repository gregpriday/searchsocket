# SearchSocket

Semantic site search and MCP retrieval for SvelteKit content projects.

## Current 1.0 Scope

- Embeddings: **OpenAI**
- Vector backends: **Milvus/Zilliz Cloud**, **Pinecone**, **Local SQLite**
- Rerank: **none** or **Jina** (optional)
- SvelteKit integrations:
  - `searchsocketHandle()` for `POST /api/search`
  - `searchsocketVitePlugin()` for build-triggered indexing

## Install

```bash
pnpm add -D searchsocket
```

## Quickstart

1. Initialize:

```bash
pnpm searchsocket init
```

2. Minimal config (`searchsocket.config.ts`):

```ts
export default {
  embeddings: { apiKeyEnv: "OPENAI_API_KEY" },
  vector: { provider: "milvus" } // or "pinecone" or "local"
};
```

3. Add SvelteKit API hook (`src/hooks.server.ts`):

```ts
import { searchsocketHandle } from "searchsocket/sveltekit";

export const handle = searchsocketHandle();
```

4. Index:

```bash
pnpm searchsocket index --changed-only
```

5. Query:

```bash
curl -X POST http://localhost:5173/api/search \
  -H "content-type: application/json" \
  -d '{"q":"getting started","topK":5,"pathPrefix":"/docs"}'
```

## Build-Triggered Indexing (SvelteKit-First)

```ts
import { searchsocketVitePlugin } from "searchsocket/sveltekit";

export default {
  plugins: [
    searchsocketVitePlugin({
      changedOnly: true
    })
  ]
};
```

Env-driven enable/disable:

```bash
SEARCHSOCKET_AUTO_INDEX=1 pnpm build
SEARCHSOCKET_DISABLE_AUTO_INDEX=1 pnpm build
```

## Git-Tracked Markdown Mirror

Indexing writes deterministic markdown mirror files:

```text
.searchsocket/pages/<scope>/**.md
```

For content workflows, you can commit this mirror to git.

## Commands

```bash
searchsocket init
searchsocket index [--scope <name>] [--changed-only] [--force] [--dry-run]
searchsocket status [--scope <name>]
searchsocket dev [--mcp] [--scope <name>]
searchsocket clean [--remote] [--scope <name>]
searchsocket prune [--older-than 30d] [--apply]
searchsocket doctor
searchsocket mcp [--transport stdio|http]
searchsocket search --q "..." [--rerank]
```

## MCP

Start MCP server:

```bash
searchsocket mcp
```

Tools:
- `search(query, opts?)`
- `get_page(pathOrUrl, opts?)`

Each search result includes `routeFile` mapping to `src/routes/**/+page.svelte`.

## Docs

- Config reference: `docs/config.md`
- CI/CD workflows: `docs/ci.md`

## Environment Variables

Core:
- `OPENAI_API_KEY`

Milvus:
- `MILVUS_URI`
- `MILVUS_TOKEN`

Pinecone:
- `PINECONE_API_KEY`

Optional rerank:
- `JINA_API_KEY`

Optional scope/build:
- `SEARCHSOCKET_SCOPE`
- `SEARCHSOCKET_AUTO_INDEX`
- `SEARCHSOCKET_DISABLE_AUTO_INDEX`
