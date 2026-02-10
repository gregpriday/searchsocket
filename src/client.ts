import type { SearchRequest, SearchResponse } from "./types";

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

      const payload = await response.json();

      if (!response.ok) {
        const message = (payload as { error?: { message?: string } }).error?.message ?? "Search failed";
        throw new Error(message);
      }

      return payload as SearchResponse;
    }
  };
}
