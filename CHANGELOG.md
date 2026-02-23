# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.1] - 2026-02-24

### Changed

- Exclude source maps from published package (8.6 MB → 2.8 MB unpacked)

## [0.2.0] - 2026-02-24

Initial public release.

### Added

- **Indexing pipeline** with incremental updates, content hashing, and cost tracking
- **Four source modes**: `static-output`, `build`, `crawl`, and `content-files`
- **Semantic search** with Jina AI embeddings (`jina-embeddings-v3`) with task-specific LoRA adapters
- **Vector storage** via Turso/libSQL (local and remote)
- **Reranking** with Jina AI for improved result relevance
- **Page-level score aggregation** with score-weighted decay
- **Synthetic page summary chunks** with meta extraction
- **MCP server** (stdio and HTTP transport) with `search` and `get_page` tools
- **SvelteKit integration**: Vite plugin for build-triggered indexing and server hook for search API
- **Browser client** (`searchsocket/client`) for frontend search integration
- **CLI commands**: `init`, `index`, `status`, `dev`, `clean`, `prune`, `doctor`, `mcp`, `search`
- **Markdown mirror** of indexed pages for content workflows (git-trackable)
- **Multi-scope support** using git branches for environment isolation
- **Noindex support** for excluding pages from indexing
- **Gzip sitemap support** for crawl source mode
- **Auto-loading of `.env`** file on CLI startup
- **Structured error handling** with typed error codes
- **Request validation** with Zod schemas
- **Rate limiting** and CORS configuration for the search API

[0.2.1]: https://github.com/gregpriday/searchsocket/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/gregpriday/searchsocket/releases/tag/v0.2.0
