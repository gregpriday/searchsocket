import type { SearchRequest, SearchResponse, SearchResult } from "./types";

/**
 * Build a URL for a search result that includes the section title as a query
 * parameter (`_ss`) and a Text Fragment (`#:~:text=`). When the destination
 * page uses `searchsocketScrollToText`, the `_ss` parameter triggers a smooth
 * scroll on SvelteKit client-side navigations. For full page loads, browsers
 * that support Text Fragments will scroll natively.
 *
 * If the result has no `sectionTitle`, the original URL is returned unchanged.
 */
export function buildResultUrl(result: SearchResult): string {
  if (!result.sectionTitle) {
    return result.url;
  }

  // Split the URL preserving its original form (relative, absolute, etc.)
  const hashIdx = result.url.indexOf("#");
  const beforeHash = hashIdx >= 0 ? result.url.slice(0, hashIdx) : result.url;
  const existingHash = hashIdx >= 0 ? result.url.slice(hashIdx) : "";

  const queryIdx = beforeHash.indexOf("?");
  const path = queryIdx >= 0 ? beforeHash.slice(0, queryIdx) : beforeHash;
  const existingQuery = queryIdx >= 0 ? beforeHash.slice(queryIdx + 1) : "";

  const params = new URLSearchParams(existingQuery);
  params.set("_ss", result.sectionTitle);

  // Build a Text Fragment for native browser scroll-to-text support
  const textFragment = `:~:text=${encodeURIComponent(result.sectionTitle)}`;
  const hash = existingHash
    ? `${existingHash}${textFragment}`
    : `#${textFragment}`;

  return `${path}?${params.toString()}${hash}`;
}

export interface SearchClientOptions {
  endpoint?: string;
  fetchImpl?: typeof fetch;
}

export function createSearchClient(options: SearchClientOptions = {}) {
  const endpoint = options.endpoint ?? "/api/search";
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    async search(request: SearchRequest): Promise<SearchResponse> {
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(request)
      });

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        if (!response.ok) {
          throw new Error("Search failed");
        }
        throw new Error("Invalid search response");
      }

      if (!response.ok) {
        const message = (payload as { error?: { message?: string } }).error?.message ?? "Search failed";
        throw new Error(message);
      }

      return payload as SearchResponse;
    }
  };
}
