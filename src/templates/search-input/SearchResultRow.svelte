<!--
  SearchResultRow — visual content of a single search result.

  Renders text only: no links, no buttons, no navigation. The parent decides the
  semantics — the dialog and inline input wrap this in a `role="option"`, the
  standalone list wraps it in an `<a>`. Keeping interactive elements out of here
  is what stops a link ending up inside a listbox option.
-->
<script lang="ts">
  import type { SearchResult } from "searchsocket";
  import { highlightParts, resultSectionLabel, urlToBreadcrumb } from "./search-ui";

  let {
    result,
    query = "",
    active = false,
    showSnippets = true,
    showBreadcrumbs = true,
    showSectionTitle = true,
    showAction = true,
  }: {
    result: SearchResult;
    query?: string;
    active?: boolean;
    showSnippets?: boolean;
    showBreadcrumbs?: boolean;
    showSectionTitle?: boolean;
    showAction?: boolean;
  } = $props();

  const section = $derived(showSectionTitle ? resultSectionLabel(result) : null);
  const breadcrumb = $derived(showBreadcrumbs ? urlToBreadcrumb(result.url) : "");
</script>

<span class="ss-search__result" data-active={active}>
  <span class="ss-search__result-main">
    <span class="ss-search__result-title">
      {#each highlightParts(result.title, query) as part}
        {#if part.match}<mark>{part.text}</mark>{:else}{part.text}{/if}
      {/each}
    </span>

    {#if section || breadcrumb}
      <span class="ss-search__result-meta">
        {#if section}
          <span class="ss-search__result-section">{section}</span>
        {/if}
        {#if section && breadcrumb}
          <span class="ss-search__result-sep" aria-hidden="true">·</span>
        {/if}
        {#if breadcrumb}
          <span class="ss-search__result-breadcrumb">{breadcrumb}</span>
        {/if}
      </span>
    {/if}

    {#if showSnippets && result.snippet}
      <span class="ss-search__result-snippet">
        {#each highlightParts(result.snippet, query) as part}
          {#if part.match}<mark>{part.text}</mark>{:else}{part.text}{/if}
        {/each}
      </span>
    {/if}
  </span>

  {#if showAction}
    <span class="ss-search__result-action" aria-hidden="true">
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"
        stroke-linecap="round" stroke-linejoin="round">
        <path d="M4 10h11" />
        <path d="M11 6l4 4-4 4" />
      </svg>
    </span>
  {/if}
</span>
