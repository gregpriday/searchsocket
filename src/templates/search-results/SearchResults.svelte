<!--
  SearchResults — Standalone result list for SearchSocket
  Minimal Tailwind 4 starting point. Customize freely.
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
    const escaped = q.trim().split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
    const splitter = new RegExp(`(${escaped})`, "gi");
    const tester = new RegExp(`^(?:${escaped})$`, "i");
    return text.split(splitter).filter(Boolean).map((part) => ({ text: part, match: tester.test(part) }));
  }
</script>

<div class="w-full">
  {#if loading}
    <div class="py-3 text-sm text-neutral-500" aria-live="polite">Searching...</div>
  {/if}

  {#if error}
    <div class="py-3 text-sm text-red-600" role="alert">{error.message}</div>
  {/if}

  {#if results.length > 0}
    <ul class="divide-y divide-neutral-200 dark:divide-neutral-700">
      {#each results as result}
        <li>
          <a href={buildResultUrl(result)} class="flex flex-col gap-1 py-3 no-underline hover:opacity-80">
            <span class="font-medium">
              {#each highlightParts(result.title, query) as part}
                {#if part.match}<mark class="rounded-sm bg-yellow-200 dark:bg-yellow-500/30">{part.text}</mark>{:else}{part.text}{/if}
              {/each}
            </span>
            {#if result.snippet}
              <span class="text-sm text-neutral-500 dark:text-neutral-400">
                {#each highlightParts(result.snippet, query) as part}
                  {#if part.match}<mark class="rounded-sm bg-yellow-200 dark:bg-yellow-500/30">{part.text}</mark>{:else}{part.text}{/if}
                {/each}
              </span>
            {/if}
          </a>
        </li>
      {/each}
    </ul>
  {/if}

  {#if query && !loading && results.length === 0 && !error}
    <div class="py-3 text-sm text-neutral-500">No results found.</div>
  {/if}
</div>
