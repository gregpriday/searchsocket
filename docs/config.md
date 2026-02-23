# SearchSocket Config Reference

Configuration file: `searchsocket.config.ts`

```ts
export default {
  embeddings: { apiKeyEnv: "JINA_API_KEY" }
};
```

## Top-level

- `project.id` (default: `package.json` name)
- `project.baseUrl` (optional canonical URL)
- `scope.mode` (`fixed` | `git` | `env`, default `fixed`)
- `scope.fixed` (default `main`)
- `scope.envVar` (default `SEARCHSOCKET_SCOPE`)
- `scope.sanitize` (default `true`)

## Source

- `source.mode` (`static-output` | `crawl` | `content-files`)
  - auto-detected as:
    - `static-output` if output dir exists
    - fallback defaults to `static-output` before first build
- `source.staticOutputDir` (default `build`)
- `source.crawl.baseUrl` (required in crawl mode)
- `source.crawl.routes` (optional route list)
- `source.crawl.sitemapUrl` (optional sitemap path/url)
- `source.contentFiles.globs` (required in content-files mode)
- `source.contentFiles.baseDir` (default project root)

## Extraction / Transform

- `extract.mainSelector` (default `main`)
- `extract.dropTags` (default `header`, `nav`, `footer`, `aside`)
- `extract.dropSelectors` (default includes sidebar/toc/breadcrumb patterns)
- `extract.ignoreAttr` (default `data-search-ignore`)
- `extract.noindexAttr` (default `data-search-noindex`)
- `extract.respectRobotsNoindex` (default `true`)

- `transform.output` (`markdown`)
- `transform.preserveCodeBlocks` (default `true`)
- `transform.preserveTables` (default `true`)

## Chunking

- `chunking.strategy` (`hybrid`)
- `chunking.maxChars` (default `2200`)
- `chunking.overlapChars` (default `200`)
- `chunking.minChars` (default `250`)
- `chunking.headingPathDepth` (default `3`)
- `chunking.dontSplitInside` (default `code`, `table`, `blockquote`)

## Embeddings

- `embeddings.provider` (`jina`)
- `embeddings.model` (default `jina-embeddings-v3`)
- `embeddings.apiKeyEnv` (default `JINA_API_KEY`)
- `embeddings.batchSize` (default `64`)
- `embeddings.concurrency` (default `4`)

## Vector Backend

### Turso / libSQL

- `vector.turso.urlEnv` (default `TURSO_DATABASE_URL`)
- `vector.turso.authTokenEnv` (default `TURSO_AUTH_TOKEN`)
- `vector.turso.localPath` (default `.searchsocket/vectors.db`)

## Reranking

- `rerank.enabled` (default `false`)
- `rerank.topN` (default `20`)
- `rerank.model` (default `jina-reranker-v2-base-multilingual`)

Reranking uses the same `JINA_API_KEY` from `embeddings.apiKeyEnv`.

## Ranking

- `ranking.enableIncomingLinkBoost` (default `true`)
- `ranking.enableDepthBoost` (default `true`)
- `ranking.weights.incomingLinks` (default `0.05`)
- `ranking.weights.depth` (default `0.03`)
- `ranking.weights.rerank` (default `1.0`)

## API / MCP / State

- `api.path` (default `/api/search`)
- `api.cors.allowOrigins` (default `[]`)
- `api.rateLimit.windowMs` / `api.rateLimit.max` (optional)

- `mcp.enable` (default `true` in dev, `false` in prod)
- `mcp.transport` (`stdio` | `http`, default `stdio`)
- `mcp.http.port` (default `3338`)
- `mcp.http.path` (default `/mcp`)

- `state.dir` (default `.searchsocket`)

## Env Variables

Common env variables:

- `JINA_API_KEY`
- `TURSO_DATABASE_URL`
- `TURSO_AUTH_TOKEN`
- `SEARCHSOCKET_SCOPE` (only with `scope.mode = "env"`)
- `SEARCHSOCKET_AUTO_INDEX` (build plugin trigger)
- `SEARCHSOCKET_DISABLE_AUTO_INDEX` (build plugin kill switch)
