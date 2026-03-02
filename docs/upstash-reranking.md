# Upstash Search Reranking in SearchSocket

## How Upstash Search Works

Upstash Search uses a **three-stage pipeline** for every query:

1. **Input Enrichment** — An LLM expands the query with related terms, handles misspellings, and adds context. Enabled by default (`inputEnrichment: true`). Adds some latency.
2. **Hybrid Vector Search** — Combines semantic (embedding) search with BM25 full-text search. The balance is controlled by `semanticWeight` (default `0.75` = 75% semantic, 25% keyword).
3. **Reranking** — A secondary AI model re-scores and reorders the candidate documents for better relevance. **Opt-in, disabled by default.**

## Reranking Details

### What it does

After the hybrid search returns candidate documents, the reranker applies a state-of-the-art cross-encoder model that evaluates each (query, document) pair for fine-grained relevance. This is more accurate than embedding similarity alone because cross-encoders see both query and document together rather than comparing pre-computed vectors.

### SDK parameter

The `@upstash/search` SDK exposes reranking as a simple boolean on `index.search()`:

```ts
const results = await index.search({
  query: "how to deploy sveltekit",
  limit: 10,
  reranking: true,        // opt-in reranking
  semanticWeight: 0.75,   // hybrid search balance
  inputEnrichment: true,  // query expansion
});
```

Full type signature from the SDK (`@upstash/search`):

```ts
search: (params: {
  query: string;
  limit?: number;                              // default: 5
  filter?: string | TreeNode;
  reranking?: boolean;                         // default: false
  semanticWeight?: number;                     // default: 0.75 (0–1)
  inputEnrichment?: boolean;                   // default: true
  keepOriginalQueryAfterEnrichment?: boolean;  // default: false
}) => Promise<SearchResult[]>;
```

### Pricing

Reranking is charged separately at **$1 per 1,000 re-ranked documents**:

| Scenario | Documents reranked | Cost per query |
|---|---|---|
| `limit: 10, reranking: true` | 10 | ~$0.01 |
| `limit: 50, reranking: true` | 50 | ~$0.05 |
| `limit: 100, reranking: true` | 100 | ~$0.10 |
| `reranking: false` (default) | 0 | $0 (included in base pricing) |

The number of documents reranked equals the `limit` parameter — every document returned goes through the reranker.

## Current State in SearchSocket

### What we expose

In `src/config/schema.ts`, the `search` section currently has:

```ts
search: z.object({
  semanticWeight: z.number().min(0).max(1).optional(),
  inputEnrichment: z.boolean().optional(),
}).optional()
```

Defaults in `src/config/defaults.ts`:

```ts
search: {
  semanticWeight: 0.75,
  inputEnrichment: true,
}
```

### What's missing

- **`reranking`** — not in the config schema, not in defaults, not passed to `store.search()`
- **`keepOriginalQueryAfterEnrichment`** — also not exposed (lower priority)

### Where the search call happens

`src/vector/upstash.ts` — the `search()` method (line 108–151) builds the Upstash SDK call:

```ts
const results = await index.search({
  query,
  limit: opts.limit,
  semanticWeight: opts.semanticWeight,
  inputEnrichment: opts.inputEnrichment,
  filter: opts.filter,
  // reranking is NOT passed
});
```

## Implementation Plan

### 1. Add `reranking` to config schema (`src/config/schema.ts`)

Add to the `search` object:

```ts
search: z.object({
  semanticWeight: z.number().min(0).max(1).optional(),
  inputEnrichment: z.boolean().optional(),
  reranking: z.boolean().optional(),  // NEW
}).optional()
```

### 2. Set default (`src/config/defaults.ts`)

```ts
search: {
  semanticWeight: 0.75,
  inputEnrichment: true,
  reranking: false,  // disabled by default — opt-in due to cost
}
```

**Rationale for `false` default:** Reranking costs $1/1K documents. For a site search tool that may handle many queries, this should be a conscious opt-in. Users enable it in `searchsocket.config.ts`:

```ts
export default {
  search: {
    reranking: true
  }
}
```

### 3. Update types (`src/types.ts` or wherever `ResolvedSearchSocketConfig` is defined)

Add `reranking: boolean` to the `search` section of `ResolvedSearchSocketConfig`.

### 4. Thread through to the search call (`src/vector/upstash.ts`)

Update the `search()` method options and pass it to the SDK:

```ts
async search(
  query: string,
  opts: {
    limit: number;
    semanticWeight?: number;
    inputEnrichment?: boolean;
    reranking?: boolean;  // NEW
    filter?: string;
  },
  scope: Scope
): Promise<VectorHit[]> {
  const index = this.chunkIndex(scope);

  const results = await index.search({
    query,
    limit: opts.limit,
    semanticWeight: opts.semanticWeight,
    inputEnrichment: opts.inputEnrichment,
    reranking: opts.reranking,  // NEW
    filter: opts.filter,
  });
  // ...
}
```

### 5. Pass from engine (`src/search/engine.ts`)

In the `search()` method, add `reranking` to the store call:

```ts
const hits = await this.store.search(
  input.q,
  {
    limit: candidateK,
    semanticWeight: this.config.search.semanticWeight,
    inputEnrichment: this.config.search.inputEnrichment,
    reranking: this.config.search.reranking,  // NEW
    filter
  },
  resolvedScope
);
```

### 6. Optional: per-request override via `SearchRequest`

Allow callers (API, MCP, CLI) to override reranking per-request:

```ts
const requestSchema = z.object({
  q: z.string().trim().min(1),
  topK: z.number().int().positive().max(100).optional(),
  scope: z.string().optional(),
  pathPrefix: z.string().optional(),
  tags: z.array(z.string()).optional(),
  groupBy: z.enum(["page", "chunk"]).optional(),
  reranking: z.boolean().optional(),  // NEW — override config default
});
```

Then in the engine: `reranking: input.reranking ?? this.config.search.reranking`

### 7. CLI `search` command

Add a `--rerank` flag (like the old Jina reranker flag that was removed).

## Files to modify

| File | Change |
|---|---|
| `src/config/schema.ts` | Add `reranking` to `search` schema |
| `src/config/defaults.ts` | Add `reranking: false` default |
| `src/types.ts` | Add to `ResolvedSearchSocketConfig.search` |
| `src/vector/upstash.ts` | Accept and pass `reranking` param |
| `src/search/engine.ts` | Thread config value to store call |
| `src/cli/commands/search.ts` | Add `--rerank` flag |
| `docs/config.md` | Update search config docs |
| `README.md` | Update reranking references (remove old Jina text) |

## Cost considerations

With `candidateK` set to `Math.max(topK * 10, 50)` for page aggregation, a typical `topK: 10` search fetches 100 candidates. With reranking enabled, that's 100 documents reranked per query ($0.10 per query at $1/1K). Consider whether reranking should apply to the full candidate set or a smaller window — though Upstash handles this server-side based on `limit`, so the `limit` parameter directly controls cost.
