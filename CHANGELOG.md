# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0] - 2026-02-25

### Added

- **NDJSON streaming search** — new streaming search endpoint with smart merge utility for combining partial results
- **Robots.txt support** — respects `robots.txt` directives during indexing
- **Meta-based page weighting** — extract and apply weight hints from page meta tags
- **Glob pattern filtering** — include/exclude pages by glob patterns in config
- **MCP rerank support** — the MCP `search` tool now supports reranking results
- **`SEARCHSOCKET_FORCE_REINDEX` env var** — set to `1`, `true`, or `yes` in CI/CD to trigger force rebuilds without CLI flag changes

### Changed

- Upgraded default embedding model to `jina-embeddings-v5-text-small`
- Upgraded default reranker to `jina-reranker-v3`

### Fixed

- Replaced fraction-based merge metric with single `maxDisplacement` check for more reliable result merging

## [0.3.3] - 2026-02-25

### Changed

- Reduced rerank API payload size for lower latency

## [0.3.2] - 2026-02-25

### Added

- Support `pageWeights: 0` as a no-index signal to exclude specific pages
- Prioritise `og:title` and `h1` over `<title>` tag during content extraction

## [0.3.1] - 2026-02-24

### Added

- Limit chunks per page sent to reranker for efficiency
- Include page description and keywords in reranker text for better relevance

## [0.3.0] - 2026-02-24

### Added

- **Page-level reranking** — reranker now receives assembled page documents (all matching chunks concatenated in document order) instead of individual chunk snippets, giving it a holistic view of each page's relevance
- **Stored chunk text** — full chunk markdown (up to 4000 chars) is now persisted alongside the snippet for richer reranking context
- **`ranking.minScore`** — configurable minimum absolute score threshold to filter out low-relevance results before they reach the client (default: `0`, disabled)
- **Link-discovery crawling for build mode** — `source.build.discover` enables automatic page discovery by crawling internal links from seed URLs, with configurable `maxPages` and `maxDepth` limits
- **Direct credential passing** — `embeddings.apiKey`, `vector.turso.url`, and `vector.turso.authToken` allow passing credentials directly in config instead of through environment variables
- **Dimension mismatch auto-recovery** — automatically detects and recreates the chunks table when switching to an embedding model with a different vector dimension

### Changed

- Replaced OpenAI embedding provider with Jina AI (`jina-embeddings-v3`) as the default and only provider; uses task-specific LoRA adapters (`retrieval.passage` for indexing, `retrieval.query` for search)
- Reranker uses Jina AI (`jina-reranker-v2-base-multilingual`), sharing the same API key as embeddings
- Removed `openai` dependency

### Fixed

- Fixed TypeScript errors in test mocks (missing `dropAllTables` implementations)

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

[0.4.0]: https://github.com/gregpriday/searchsocket/compare/v0.3.3...v0.4.0
[0.3.3]: https://github.com/gregpriday/searchsocket/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/gregpriday/searchsocket/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/gregpriday/searchsocket/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/gregpriday/searchsocket/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/gregpriday/searchsocket/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/gregpriday/searchsocket/releases/tag/v0.2.0
