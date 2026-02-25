import type { SearchRequest, SearchResponse, StreamSearchEvent, StreamEvent } from "./types";

export { mergeSearchResults } from "./merge";

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
    },

    async streamSearch(
      request: SearchRequest & { stream: true; rerank: true },
      onPhase: (event: StreamSearchEvent) => void
    ): Promise<SearchResponse> {
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(request)
      });

      if (!response.ok) {
        let payload: unknown;
        try {
          payload = await response.json();
        } catch {
          throw new Error("Search failed");
        }
        const message = (payload as { error?: { message?: string } }).error?.message ?? "Search failed";
        throw new Error(message);
      }

      const contentType = response.headers.get("content-type") ?? "";

      // Fallback: server returned standard JSON (e.g. older server without streaming)
      if (contentType.includes("application/json")) {
        const data = (await response.json()) as SearchResponse;
        onPhase({ phase: "initial", data });
        return data;
      }

      // NDJSON stream
      if (!response.body) {
        throw new Error("Response body is not readable");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let lastResponse: SearchResponse | null = null;

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        let newlineIdx: number;
        while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newlineIdx).trim();
          buffer = buffer.slice(newlineIdx + 1);

          if (line.length === 0) continue;

          const event = JSON.parse(line) as StreamEvent;

          if (event.phase === "error") {
            const errData = event.data as { error: { message?: string } };
            throw new Error(errData.error.message ?? "Streaming search error");
          }

          const searchEvent = event as StreamSearchEvent;
          onPhase(searchEvent);
          lastResponse = searchEvent.data;
        }
      }

      // Process any remaining data in buffer
      const remaining = buffer.trim();
      if (remaining.length > 0) {
        const event = JSON.parse(remaining) as StreamEvent;
        if (event.phase === "error") {
          const errData = event.data as { error: { message?: string } };
          throw new Error(errData.error.message ?? "Streaming search error");
        }
        const searchEvent = event as StreamSearchEvent;
        onPhase(searchEvent);
        lastResponse = searchEvent.data;
      }

      if (!lastResponse) {
        throw new Error("No search results received");
      }

      return lastResponse;
    }
  };
}
