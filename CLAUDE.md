# SearchSocket - Claude Code Notes

## Project Overview

Semantic site search and MCP retrieval for SvelteKit static sites. Published on NPM as `searchsocket`.

## Architecture Mental Model

- **Indexing Pipeline (`src/indexing/pipeline.ts`)**:
  Source Pages (HTML/MD) -> Filtering (Exclude/Robots) -> Route Mapping -> Extraction (`cheerio`/`turndown`) -> Link Analysis -> Chunking (Split by headings/length) -> Hashing (for incremental updates) -> Upsert to Upstash Vector.
  The pipeline supports hooks (`transformPage`, `transformChunk`, `beforeIndex`, `afterIndex`) and dry-run mode.
- **Dual Search**: The system indexes both full pages (summaries) and individual chunks. Search queries run parallel vector search at both page and chunk granularity with score blending for improved relevance.
- **Serverless First**: The core search engine (`SearchEngine`) and MCP Server must remain completely stateless and serverless-compatible. No in-memory rate limiting or persistent WebSocket connections.

## Tech Stack & Core Dependencies

Use existing libraries from `package.json` — do not introduce new dependencies for tasks these already handle:
- **HTML Parsing**: `cheerio` (avoid regex for HTML).
- **Markdown Conversion**: `turndown` and `turndown-plugin-gfm`.
- **Frontmatter**: `gray-matter`.
- **Vector Database**: `@upstash/vector` (Note: Jina/Turso were removed in v0.5.0, DO NOT use them).
- **File globbing**: `fast-glob`.
- **Validation**: `zod`.
- **AST Manipulation**: `magicast` (used in `src/init-helpers.ts`).

## Coding Conventions & Patterns

- **Error Handling**: Do not throw generic `Error` objects. Use the custom `SearchSocketError` class from `src/errors/index.ts` with the appropriate typed error code (e.g., `CONFIG_MISSING`, `INVALID_REQUEST`, `VECTOR_BACKEND_UNAVAILABLE`).
- **Logging**: Never use `console.log` or `console.error` in core logic. Use the `Logger` class from `src/core/logger.ts` which supports JSON output, verbosity flags, and stderr-only modes.
- **Config Validation**: All configuration validation must go through `zod` schemas defined in `src/config/schema.ts`.
- **Svelte 5**: Any UI templates (in `src/templates/`) MUST use Svelte 5 Runes (`$state`, `$props`, `$effect`, `$derived`, `$bindable`). Do not use Svelte 4 `export let` syntax.
- **Path Handling**: Use the utility functions in `src/utils/path.ts` (`normalizeUrlPath`, `staticHtmlFileToUrl`, `getUrlDepth`, `joinUrl`) instead of raw string manipulation for URLs and routes.

## Release Process

- Version 0.2.0 is the initial public release
- GitHub Actions workflow (`.github/workflows/publish.yml`) handles publishing on tag push via NPM Trusted Publishing (OIDC, no secrets needed)
- To release a new version:
  ```bash
  npm version patch   # or minor
  git push origin main --tags
  ```
- `npm version` updates package.json, commits, and creates the `v*` tag automatically
- The workflow runs: pnpm install, build, test, then `npm publish --provenance --access public`
- Trusted publisher is configured on NPM to accept the `publish.yml` workflow from `gregpriday/searchsocket`
- Update CHANGELOG.md with each release
- You can automate the release process by running the custom `/release` command.

## Build & Test

- Build: `pnpm run build` (uses tsup, outputs ESM + CJS + types to dist/)
- Unit Tests: `pnpm run test` (vitest). Place new tests in `tests/` and use fixtures in `tests/fixtures/`.
- Search Quality Tests: `pnpm run test:quality` runs Mean Reciprocal Rank (MRR) assertions against the live index using judgments in `tests/fixtures/quality-judgments.ts`. Run this when tweaking `src/search/ranking.ts` to ensure search quality isn't degraded.
- Typecheck: `pnpm run typecheck`
- Package manager: pnpm

## Package Structure

- Three entry points: `searchsocket` (core), `searchsocket/sveltekit`, `searchsocket/client`
- CLI binary: `searchsocket` (dist/cli.js)
- Only `dist/` and `README.md` are published to NPM (controlled by `files` in package.json)

## Key Directories

- `src/` - TypeScript source
- `src/cli/` - CLI commands (init, index, status, dev, clean, prune, doctor, mcp, search)
- `src/indexing/` - Indexing pipeline
- `src/search/` - Search engine and ranking
- `src/mcp/` - MCP server (stdio + HTTP)
- `src/sveltekit/` - SvelteKit Vite plugin and server hook
- `src/client/` - Browser search client
- `src/templates/` - Svelte 5 search UI components
- `tests/` - Test files
