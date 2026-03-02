import type { SearchRequest, SearchResponse, SearchResult } from "./types";

/**
 * Build a URL for a search result that includes section metadata (`_ssk`) and
 * a text-target phrase (`_sskt`) plus a Text Fragment (`#:~:text=`). When the destination
 * page uses `searchsocketScrollToText`, `_sskt` (or `_ssk`) triggers a smooth
 * scroll on SvelteKit client-side navigations. For full page loads, browsers
 * that support Text Fragments will scroll natively.
 *
 * If no usable text target is available, the original URL is returned unchanged.
 */
const SNIPPET_TARGET_MAX_WORDS = 12;

function normalizeTargetText(value: string): string {
  return value
    .replace(/\u2026/g, " ")
    .replace(/\.{3,}/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function shortenForTarget(value: string): string {
  const words = value.split(/\s+/).filter(Boolean);
  if (words.length <= SNIPPET_TARGET_MAX_WORDS) {
    return value;
  }
  return words.slice(0, SNIPPET_TARGET_MAX_WORDS).join(" ");
}

function selectTextTarget(result: SearchResult): string {
  const sectionTitle = normalizeTargetText(result.sectionTitle ?? "");
  const snippetCandidate = normalizeTargetText(result.chunks?.[0]?.snippet ?? result.snippet);

  // Prefer snippet text when it appears to be tied to the selected section.
  if (snippetCandidate) {
    if (!sectionTitle || snippetCandidate.toLowerCase().includes(sectionTitle.toLowerCase())) {
      return shortenForTarget(snippetCandidate);
    }
  }

  return sectionTitle;
}

export function buildResultUrl(result: SearchResult): string {
  const textTarget = selectTextTarget(result);
  if (!textTarget) {
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
  if (result.sectionTitle) {
    params.set("_ssk", result.sectionTitle);
  } else {
    params.delete("_ssk");
  }
  params.set("_sskt", textTarget);

  // Build a Text Fragment for native browser scroll-to-text support
  const textFragment = `:~:text=${encodeURIComponent(textTarget)}`;
  const hashWithoutTextFragment = existingHash.replace(/:~:text=.*$/u, "");
  const hash = existingHash
    ? `${hashWithoutTextFragment}${textFragment}`
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
