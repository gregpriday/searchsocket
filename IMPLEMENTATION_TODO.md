# SiteScribe Detailed Implementation TODO

This checklist is derived from `spec.md`.

## Phase 1: Package + Tooling

- [x] Initialize npm package as `sitescribe`
- [x] Configure TypeScript build for ESM + CJS outputs
- [x] Add `sitescribe` CLI binary output
- [x] Export package entrypoints: `sitescribe`, `sitescribe/sveltekit`, `sitescribe/client`
- [x] Add test harness (Vitest)
- [x] Add strict TS config and compile checks

## Phase 2: Core Types + Config + State

- [x] Define typed config schema with defaults
- [x] Implement config loader for `sitescribe.config.ts`
- [x] Implement scope resolution (`fixed` / `git` / `env`)
- [x] Implement project ID inference from `package.json`
- [x] Implement `.sitescribe` state directory management
- [x] Implement manifest read/write/update
- [x] Implement local scope registry read/write/update
- [x] Add structured error codes (`CONFIG_MISSING`, etc.)

## Phase 3: Source Ingestion + Mapping

- [x] Implement source mode auto-detection
- [x] Implement `static-output` page discovery + URL derivation
- [x] Implement `crawl` page retrieval (routes/sitemap)
- [x] Implement `content-files` mode (initial MVP behavior)
- [x] Implement SvelteKit route scan (`src/routes/**/+page.svelte`)
- [x] Implement URL-to-route file mapping with specificity ranking
- [x] Implement best-effort fallback behavior

## Phase 4: Extraction + Markdown Mirror

- [x] Implement HTML extraction rooted in `mainSelector`
- [x] Remove boilerplate by tags/selectors
- [x] Honor `data-search-ignore` filtering
- [x] Honor robots/noindex behavior
- [x] Convert extracted HTML to deterministic Markdown
- [x] Preserve code blocks and tables in transform
- [x] Compute graph metadata (incoming/outgoing/depth)
- [x] Write mirror files to `.sitescribe/pages/<scope>/...`
- [x] Write deterministic frontmatter including `routeFile`

## Phase 5: Chunking + Hashing + Incremental Plan

- [x] Implement hybrid heading-aware chunking
- [x] Implement paragraph splitting with overlap
- [x] Avoid splitting inside code/table/blockquote blocks
- [x] Generate chunk metadata fields (`headingPath`, etc.)
- [x] Compute deterministic `chunkKey`
- [x] Compute `contentHash`
- [x] Implement chunk diff against manifest for upsert/delete plan

## Phase 6: Embeddings + Cache + Cost

- [x] Implement OpenAI embeddings provider
- [x] Add batching + concurrency limits
- [x] Add retries with exponential backoff on 429/5xx
- [x] Improve token estimation beyond char/4 fallback
- [x] Implement sqlite embedding cache lookup/write
- [x] Implement cost estimate preflight summaries
- [x] Track cache reuse/new counts and estimate totals

## Phase 7: Vector Backends

- [x] Define `VectorStore` interface per spec
- [x] Implement Milvus/Zilliz Cloud adapter (primary)
- [x] Implement Pinecone adapter
- [x] Implement local sqlite vector adapter
- [x] Store record metadata required by search/MCP
- [x] Implement `pathPrefix` filtering
- [x] Implement scope delete + id delete operations
- [x] Implement scope listing via registry strategy
- [x] Implement backend health checks

## Phase 8: Search + Ranking + API

- [x] Implement retrieval flow (embed query -> vector search)
- [x] Add depth/incoming link boosts
- [x] Implement optional Jina reranker integration
- [x] Implement request validation for `/api/search`
- [x] Implement timing metadata in API responses
- [x] Implement model mismatch protection
- [x] Implement CORS + rate limiting + payload guardrails
- [x] Implement `sitescribeHandle()` memoized provider init

## Phase 9: MCP Server

- [x] Implement `sitescribe mcp` command
- [x] Add stdio transport
- [x] Add optional localhost HTTP transport
- [x] Implement `search` tool
- [x] Implement `get_page` tool
- [x] Ensure results include `routeFile`
- [x] Keep MCP retrieval-only (no indexing tool)

## Phase 10: CLI Commands

- [x] `sitescribe init`
- [x] `sitescribe index`
- [x] `sitescribe status`
- [x] `sitescribe dev` watch mode
- [x] `sitescribe clean`
- [x] `sitescribe prune` (dry-run default + fallback summary)
- [x] `sitescribe doctor`
- [x] Add human + JSON logging mode

## Phase 11: Tests

- [x] Unit: extraction behavior
- [x] Unit: chunking/key stability
- [x] Unit: route mapping correctness
- [x] Unit: embedding cache behavior
- [x] Contract: local vector adapter filter behavior
- [x] Contract: Milvus adapter behavior (mocked client)
- [x] Contract: Pinecone adapter behavior (mocked client)
- [x] Integration smoke: index -> search using local backend

## Phase 12: Docs + Examples

- [x] Add README quickstart and command docs
- [x] Add full config reference (`docs/config.md`)
- [x] Add SvelteKit integration snippet
- [x] Add MCP usage examples
- [x] Add CI workflow examples (`docs/ci.md`)
- [x] Add build-triggered indexing guidance for local/CI/Vercel
