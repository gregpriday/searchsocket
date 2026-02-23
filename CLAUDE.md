# SearchSocket - Claude Code Notes

## Project Overview

Semantic site search and MCP retrieval for SvelteKit static sites. Published on NPM as `searchsocket`.

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

## Build & Test

- Build: `pnpm run build` (uses tsup, outputs ESM + CJS + types to dist/)
- Test: `pnpm run test` (vitest, 314 tests across 42 files)
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
- `tests/` - Test files
