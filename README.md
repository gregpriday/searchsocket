# SiteScribe

Semantic site search and MCP retrieval for SvelteKit content projects.

## Current 1.0 Scope

- Embeddings: **OpenAI**
- Vector backends: **Milvus/Zilliz Cloud**, **Pinecone**, **Local SQLite**
- Rerank: **none** or **Jina** (optional)
- SvelteKit integrations:
  - `sitescribeHandle()` for `POST /api/search`
  - `sitescribeVitePlugin()` for build-triggered indexing

## Install

```bash
pnpm add -D sitescribe
```

## Quickstart

1. Initialize:

```bash
pnpm sitescribe init
```

2. Minimal config (`sitescribe.config.ts`):

```ts
export default {
  embeddings: { apiKeyEnv: "OPENAI_API_KEY" },
  vector: { provider: "milvus" } // or "pinecone" or "local"
};
```

3. Add SvelteKit API hook (`src/hooks.server.ts`):

```ts
import { sitescribeHandle } from "sitescribe/sveltekit";

export const handle = sitescribeHandle();
```

4. Index:

```bash
pnpm sitescribe index --changed-only
```

5. Query:

```bash
curl -X POST http://localhost:5173/api/search \
  -H "content-type: application/json" \
  -d '{"q":"getting started","topK":5,"pathPrefix":"/docs"}'
```

## Build-Triggered Indexing (SvelteKit-First)

```ts
import { sitescribeVitePlugin } from "sitescribe/sveltekit";

export default {
  plugins: [
    sitescribeVitePlugin({
      changedOnly: true
    })
  ]
};
```

Env-driven enable/disable:

```bash
SITESCRIBE_AUTO_INDEX=1 pnpm build
SITESCRIBE_DISABLE_AUTO_INDEX=1 pnpm build
```

## Git-Tracked Markdown Mirror

Indexing writes deterministic markdown mirror files:

```text
.sitescribe/pages/<scope>/**.md
```

For content workflows, you can commit this mirror to git.

## Commands

```bash
sitescribe init
sitescribe index [--scope <name>] [--changed-only] [--force] [--dry-run]
sitescribe status [--scope <name>]
sitescribe dev [--mcp] [--scope <name>]
sitescribe clean [--remote] [--scope <name>]
sitescribe prune [--older-than 30d] [--apply]
sitescribe doctor
sitescribe mcp [--transport stdio|http]
sitescribe search --q "..." [--rerank]
```

## MCP

Start MCP server:

```bash
sitescribe mcp
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
- `SITESCRIBE_SCOPE`
- `SITESCRIBE_AUTO_INDEX`
- `SITESCRIBE_DISABLE_AUTO_INDEX`
