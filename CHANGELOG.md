# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.7.1] - 2026-04-11

### Fixed

- Reject GET and DELETE requests to MCP endpoint with 405 to prevent SSE reconnect storms on serverless
- Allow `SearchEngine` to operate without Upstash credentials — returns typed `SEARCH_NOT_CONFIGURED` error instead of crashing

## [0.7.0] - 2026-04-05

### Changed

- **Breaking:** Reduce MCP tool surface from 6 tools to 3 focused tools (`search`, `get_page`, `get_related_pages`)
- Remove `find_source_file` tool (redundant — `search` already returns `routeFile` in every result)
- Remove `list_pages` tool (LLMs should search, not browse; filesystem handles enumeration locally)
- Remove `get_site_structure` tool (same reasoning; too much context for LLM consumption)
- Rename `pathOrUrl` parameter to `path` in `get_page` and `get_related_pages` for LLM usability
- Rewrite all tool descriptions with cross-references, negative constraints, and parameter examples
- Add smart error recovery to `get_page` — suggests similar pages when requested page not found
- Return human-readable "no results" message from `search` instead of empty JSON
- Remove `outputSchema` from search tool to reduce token overhead in tool definitions

## [0.6.3] - 2026-04-04

### Changed

- Remove `markdown` field from page vector metadata to avoid exceeding Upstash's 48KB metadata limit on large pages
- Reconstruct page markdown on demand from chunks via new `getChunksForPage()` method
- Add 30,000-character hard cap on `chunkText` in chunk metadata as a safety net

## [0.6.2] - 2026-04-04

### Fixed

- Gracefully skip indexing when vector backend is unavailable instead of crashing
- Upgrade to Node 24 for npm v11 OIDC support in publish workflow
- Switch publish command to pnpm with provenance
- Remove broken `npm install -g npm@latest` from publish workflow

## [0.6.1] - 2026-04-03

### Fixed

- Use targeted `fetch()` for chunk content hashes instead of `range()` scan to avoid namespace cross-contamination on hybrid indexes
- Use `range()` scan for stale chunk ID detection (safe for deletion since removing non-existent IDs is idempotent)
- Reduce Upstash batch size from 100 to 90 to stay within API limits

## [0.6.0] - 2026-04-03

### Added

- **Hybrid search (dense + BM25)** — enables combined dense vector and BM25 keyword search with 512-token limit enforcement
- **Page-first search pipeline** — per-page chunk retrieval for better result grouping
- **Namespace support** — Upstash Vector namespace isolation for multi-tenant indexing
- **Structured metadata filtering** — filter search results by indexed metadata fields
- **Freshness scoring** — time-based ranking signal to boost recently updated content
- **Internal link anchor text ranking** — use anchor text from internal links as an additional relevance signal
- **Content-level heading weight** — heading context influences chunk embeddings for better semantic matching
- **Query-aware excerpts** — generate contextual excerpts highlighting query-relevant passages
- **Sub-results in MCP** — expose chunk-level sub-results with configurable `maxSubResults`
- **Custom record indexing API** — index non-HTML content (JSON, CSV, API data) programmatically
- **Interactive ranking tuner** — dev playground tool for tuning ranking parameters in real time
- **`get_related_pages` MCP tool** — find related pages using multi-signal scoring
- **`get_site_structure` MCP tool** — hierarchical page tree for site navigation
- **`list_pages` MCP tool** — enumerate indexed pages with path prefix filtering
- **`find_source_file` MCP tool** — locate source files for content editing workflows
- **MCP public/private access modes** — API key authentication for public MCP endpoints
- **MCP endpoint via `searchsocketHandle`** — serverless MCP access through SvelteKit hooks
- **Component indexing** — index Svelte component files alongside pages
- **`llms.txt` generation** — default `generateFull: true` and serve markdown variants
- **`.mcp.json` generation** — auto-generate MCP config during `searchsocket init`
- **Interactive CLI setup** — `searchsocket init` with auto-config injection
- **Copy-paste component recipes** — `searchsocket add` command for UI components
- **Search playground UI** — interactive search testing during dev mode
- **Search quality CLI** — `searchsocket test` command for MRR-based quality assertions
- **GET API endpoints** — REST endpoints for search, health, and page retrieval
- **Opt-in search analytics** — analytics tracking with CLI report command
- **Lifecycle hooks** — `transformPage`, `transformChunk`, `beforeIndex`, `afterIndex` pipeline hooks
- **Incremental page records** — content hashing for efficient re-indexing
- **Reactive Svelte 5 search primitives** — `createSearch` and `SearchSocket.svelte` for frontend

### Changed

- **Switched to Upstash built-in embedding** — use Upstash's native embedding via `data` field, removing external embedding dependency
- **Removed Gemini embedder** — dropped `@google/generative-ai` dependency and related config
- **Replaced absolute `minScore` with relative `minScoreRatio`** — score threshold is now relative to the top result for more consistent filtering
- **Migrated search UI to Tailwind 4** — updated template components to Tailwind 4 utility classes

### Fixed

- Prevent incoming link count inflation from anchor text deduplication
- Map `OutgoingLink[]` to `string[]` for `outgoingLinkUrls` compatibility
- Propagate score breakdown through `dualSearch` merge
- Handle missing Upstash credentials gracefully
- Prevent `apiPath` guard from bypassing `llms.txt` intercept

## [0.5.0] - 2026-03-02

### Added

- **Scroll-to-text navigation** — search result links now include `_sskt` (text target) and `_ssk` (section title) query params plus native `#:~:text=` fragments for smooth scroll-to-text on both SvelteKit client navigations and full page loads
- **Cross-node text matching** — TreeWalker-based text map concatenates all visible text nodes, enabling matches that span split DOM nodes (e.g. `<em>Install</em>ation`)
- **CSS Custom Highlight API** — non-destructive highlighting via `::highlight()` pseudo-element in modern browsers, with DOM mutation fallback for older browsers
- **Two-pass regex matching** — strict pass requires separators between tokens; lenient fallback allows zero-width separators for adjacent DOM nodes without whitespace
- **Dual page+chunk parallel search** — parallel vector search at both page and chunk granularity with score blending for improved relevance
- **Reranking, score-gap trimming, and title boost** — search quality improvements with configurable ranking pipeline

### Changed

- **Migrated vector backend from Jina + Turso to Upstash Search** — simplified infrastructure with a single managed search service
- Removed local markdown mirror feature

### Fixed

- Respect Upstash 4096-char content limit per document during indexing
- Fixed pnpm version in CI prune workflow

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

[0.6.1]: https://github.com/gregpriday/searchsocket/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/gregpriday/searchsocket/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/gregpriday/searchsocket/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/gregpriday/searchsocket/compare/v0.3.3...v0.4.0
[0.3.3]: https://github.com/gregpriday/searchsocket/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/gregpriday/searchsocket/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/gregpriday/searchsocket/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/gregpriday/searchsocket/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/gregpriday/searchsocket/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/gregpriday/searchsocket/releases/tag/v0.2.0
