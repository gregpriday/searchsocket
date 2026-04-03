import type { SearchRequest, SearchResponse, SearchResult } from "../types";

export interface CreateSearchOptions {
  endpoint?: string;
  debounce?: number;
  cache?: boolean;
  cacheSize?: number;
  fetchImpl?: typeof fetch;
  topK?: number;
  scope?: string;
  pathPrefix?: string;
  tags?: string[];
  groupBy?: "page" | "chunk";
}

class LruCache<K, V> {
  private map = new Map<K, V>();
  constructor(private maxSize: number) {}

  get(key: K): V | undefined {
    const value = this.map.get(key);
    if (value !== undefined) {
      // Move to end (most recently used)
      this.map.delete(key);
      this.map.set(key, value);
    }
    return value;
  }

  set(key: K, value: V): void {
    this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.maxSize) {
      const oldest = this.map.keys().next().value!;
      this.map.delete(oldest);
    }
  }

  get size(): number {
    return this.map.size;
  }
}

function buildCacheKey(query: string, options: CreateSearchOptions): string {
  const parts: Record<string, unknown> = { q: query };
  if (options.topK !== undefined) parts.topK = options.topK;
  if (options.scope !== undefined) parts.scope = options.scope;
  if (options.pathPrefix !== undefined) parts.pathPrefix = options.pathPrefix;
  if (options.tags !== undefined) parts.tags = options.tags;
  if (options.groupBy !== undefined) parts.groupBy = options.groupBy;
  return JSON.stringify(parts);
}

export interface SearchState {
  query: string;
  readonly results: SearchResult[];
  readonly loading: boolean;
  readonly error: Error | null;
  readonly destroy: () => void;
}

export function createSearch(options: CreateSearchOptions = {}): SearchState {
  const endpoint = options.endpoint ?? "/api/search";
  const debounceMs = options.debounce ?? 250;
  const cacheEnabled = options.cache !== false;
  const cacheSize = options.cacheSize ?? 50;
  const fetchFn = options.fetchImpl ?? fetch;

  const resultCache = new LruCache<string, SearchResult[]>(cacheSize);

  let query = $state("");
  let results = $state<SearchResult[]>([]);
  let loading = $state(false);
  let error = $state<Error | null>(null);

  const destroy = $effect.root(() => {
    $effect(() => {
      const currentQuery = query;

      if (!currentQuery.trim()) {
        results = [];
        loading = false;
        error = null;
        return;
      }

      const cacheKey = buildCacheKey(currentQuery, options);

      if (cacheEnabled) {
        const cached = resultCache.get(cacheKey);
        if (cached) {
          results = cached;
          loading = false;
          error = null;
          return;
        }
      }

      loading = true;
      const controller = new AbortController();

      const timer = setTimeout(async () => {
        const request: SearchRequest = { q: currentQuery };
        if (options.topK !== undefined) request.topK = options.topK;
        if (options.scope !== undefined) request.scope = options.scope;
        if (options.pathPrefix !== undefined) request.pathPrefix = options.pathPrefix;
        if (options.tags !== undefined) request.tags = options.tags;
        if (options.groupBy !== undefined) request.groupBy = options.groupBy;

        try {
          const response = await fetchFn(endpoint, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(request),
            signal: controller.signal,
          });

          let payload: unknown;
          try {
            payload = await response.json();
          } catch {
            throw new Error(response.ok ? "Invalid search response" : "Search failed");
          }

          if (!response.ok) {
            const message =
              (payload as { error?: { message?: string } }).error?.message ?? "Search failed";
            throw new Error(message);
          }

          const data = payload as SearchResponse;
          if (cacheEnabled) {
            resultCache.set(cacheKey, data.results);
          }
          results = data.results;
          error = null;
        } catch (err) {
          if (err instanceof DOMException && err.name === "AbortError") return;
          if (controller.signal.aborted) return;
          error = err instanceof Error ? err : new Error(String(err));
          results = [];
        } finally {
          if (!controller.signal.aborted) {
            loading = false;
          }
        }
      }, debounceMs);

      return () => {
        clearTimeout(timer);
        controller.abort();
      };
    });
  });

  return {
    get query() {
      return query;
    },
    set query(v: string) {
      query = v;
    },
    get results() {
      return results;
    },
    get loading() {
      return loading;
    },
    get error() {
      return error;
    },
    destroy,
  };
}
