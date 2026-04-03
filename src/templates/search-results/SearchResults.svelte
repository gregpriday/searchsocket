<!--
  SearchResults — Standalone result list for SearchSocket
  Copy-paste component: edit freely to match your project.
  Use this when you manage search state yourself and just need a result display.
-->
<script lang="ts">
  import { buildResultUrl } from "searchsocket/client";

  interface SearchResultItem {
    url: string;
    title: string;
    sectionTitle?: string;
    snippet: string;
    score: number;
    routeFile: string;
    chunks?: { sectionTitle?: string; snippet: string; headingPath: string[]; score: number }[];
  }

  let {
    results = [],
    query = "",
    loading = false,
    error = null,
  }: {
    results?: SearchResultItem[];
    query?: string;
    loading?: boolean;
    error?: Error | null;
  } = $props();

  function highlightParts(text: string, q: string): Array<{ text: string; match: boolean }> {
    if (!q.trim()) return [{ text, match: false }];
    const escaped = q
      .trim()
      .split(/\s+/)
      .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("|");
    const splitter = new RegExp(`(${escaped})`, "gi");
    const tester = new RegExp(`^(?:${escaped})$`, "i");
    return text
      .split(splitter)
      .filter(Boolean)
      .map((part) => ({ text: part, match: tester.test(part) }));
  }
</script>

<div class="ss-search-results">
  {#if loading}
    <div class="ss-loading" aria-live="polite">Searching...</div>
  {/if}

  {#if error}
    <div class="ss-error" role="alert">{error.message}</div>
  {/if}

  {#if results.length > 0}
    <ul class="ss-results">
      {#each results as result}
        <li class="ss-result">
          <a href={buildResultUrl(result)} class="ss-result-link">
            <span class="ss-result-title">
              {#each highlightParts(result.title, query) as part}
                {#if part.match}<mark>{part.text}</mark>{:else}{part.text}{/if}
              {/each}
            </span>
            {#if result.snippet}
              <span class="ss-result-snippet">
                {#each highlightParts(result.snippet, query) as part}
                  {#if part.match}<mark>{part.text}</mark>{:else}{part.text}{/if}
                {/each}
              </span>
            {/if}
          </a>
        </li>
      {/each}
    </ul>
  {/if}

  {#if query && !loading && results.length === 0 && !error}
    <div class="ss-empty">No results found.</div>
  {/if}
</div>

<style>
  .ss-search-results {
    width: 100%;
  }

  .ss-loading,
  .ss-empty,
  .ss-error {
    padding: var(--ss-message-padding, 12px 0);
    font-size: var(--ss-message-font-size, 14px);
  }

  .ss-error {
    color: var(--ss-error-color, #dc2626);
  }

  .ss-results {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .ss-result {
    border-bottom: 1px solid var(--ss-border-color, #e5e7eb);
  }

  .ss-result:last-child {
    border-bottom: none;
  }

  .ss-result-link {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: var(--ss-result-padding, 12px 0);
    text-decoration: none;
    color: inherit;
  }

  .ss-result-link:hover {
    opacity: 0.8;
  }

  .ss-result-title {
    font-weight: 500;
  }

  .ss-result-snippet {
    font-size: var(--ss-snippet-font-size, 13px);
    color: var(--ss-snippet-color, #6b7280);
  }

  mark {
    background: var(--ss-mark-bg, #fef08a);
    color: inherit;
    border-radius: 2px;
    padding: 0 1px;
  }
</style>
