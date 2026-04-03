<!--
  SearchInput — Inline search input with dropdown results for SearchSocket
  Copy-paste component: edit freely to match your project.
  For non-SvelteKit apps, replace `goto` with `window.location.href = url`.
-->
<script lang="ts">
  import { createSearch } from "searchsocket/svelte";
  import { buildResultUrl } from "searchsocket/client";
  import { goto } from "$app/navigation";

  let {
    endpoint = "/api/search",
    placeholder = "Search...",
  }: {
    endpoint?: string;
    placeholder?: string;
  } = $props();

  const search = createSearch({ endpoint });

  let activeIndex = $state(-1);
  let inputEl = $state<HTMLInputElement | null>(null);
  let containerEl = $state<HTMLDivElement | null>(null);
  let dropdownOpen = $state(false);
  let listboxId = "ss-inline-listbox";

  let showDropdown = $derived(dropdownOpen && search.query.trim().length > 0);

  // Reset active index when results change
  $effect(() => {
    search.results;
    activeIndex = -1;
  });

  // Cleanup search state on destroy
  $effect(() => {
    return () => search.destroy();
  });

  function activeOptionId(): string | undefined {
    if (activeIndex >= 0 && activeIndex < search.results.length) {
      return `ss-inline-option-${activeIndex}`;
    }
    return undefined;
  }

  function handleKeydown(e: KeyboardEvent) {
    const count = search.results.length;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        activeIndex = count > 0 ? (activeIndex + 1) % count : -1;
        break;
      case "ArrowUp":
        e.preventDefault();
        activeIndex = count > 0 ? (activeIndex - 1 + count) % count : -1;
        break;
      case "Enter":
        e.preventDefault();
        if (activeIndex >= 0 && activeIndex < count) {
          navigateTo(search.results[activeIndex]);
        }
        break;
      case "Escape":
        e.preventDefault();
        dropdownOpen = false;
        inputEl?.blur();
        break;
    }
  }

  function handleFocusOut(e: FocusEvent) {
    // Close dropdown when focus leaves the entire container
    if (containerEl && !containerEl.contains(e.relatedTarget as Node)) {
      dropdownOpen = false;
    }
  }

  function navigateTo(result: (typeof search.results)[number]) {
    dropdownOpen = false;
    search.query = "";
    goto(buildResultUrl(result));
  }

  function highlightParts(text: string, query: string): Array<{ text: string; match: boolean }> {
    if (!query.trim()) return [{ text, match: false }];
    const escaped = query
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

<div class="ss-search-input" bind:this={containerEl} onfocusout={handleFocusOut}>
  <input
    bind:this={inputEl}
    type="text"
    role="combobox"
    aria-expanded={showDropdown && search.results.length > 0}
    aria-haspopup="listbox"
    aria-controls={listboxId}
    aria-autocomplete="list"
    aria-activedescendant={activeOptionId()}
    {placeholder}
    value={search.query}
    oninput={(e) => (search.query = e.currentTarget.value)}
    onfocus={() => (dropdownOpen = true)}
    onkeydown={handleKeydown}
    class="ss-input"
  />

  {#if showDropdown}
    <div class="ss-dropdown">
      {#if search.loading}
        <div class="ss-loading" aria-live="polite">Searching...</div>
      {/if}

      {#if search.error}
        <div class="ss-error" role="alert">{search.error.message}</div>
      {/if}

      {#if search.results.length > 0}
        <ul role="listbox" id={listboxId} class="ss-results">
          {#each search.results as result, i}
            <li
              role="option"
              id="ss-inline-option-{i}"
              aria-selected={i === activeIndex}
              class="ss-result"
              class:ss-result-active={i === activeIndex}
              onclick={() => navigateTo(result)}
              onmouseenter={() => (activeIndex = i)}
            >
              <span class="ss-result-title">
                {#each highlightParts(result.title, search.query) as part}
                  {#if part.match}<mark>{part.text}</mark>{:else}{part.text}{/if}
                {/each}
              </span>
              {#if result.snippet}
                <span class="ss-result-snippet">
                  {#each highlightParts(result.snippet, search.query) as part}
                    {#if part.match}<mark>{part.text}</mark>{:else}{part.text}{/if}
                  {/each}
                </span>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}

      {#if search.query && !search.loading && search.results.length === 0 && !search.error}
        <div class="ss-empty">No results found.</div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .ss-search-input {
    position: relative;
    width: var(--ss-input-width, 100%);
  }

  .ss-input {
    width: 100%;
    padding: var(--ss-input-padding, 10px 12px);
    border: 1px solid var(--ss-border-color, #d1d5db);
    border-radius: var(--ss-input-radius, 8px);
    font-size: var(--ss-input-font-size, 14px);
    outline: none;
    background: var(--ss-input-bg, #fff);
    color: inherit;
  }

  .ss-input:focus {
    border-color: var(--ss-input-focus-border, #3b82f6);
    box-shadow: var(--ss-input-focus-shadow, 0 0 0 2px rgba(59, 130, 246, 0.15));
  }

  .ss-dropdown {
    position: absolute;
    top: 100%;
    left: 0;
    right: 0;
    margin-top: 4px;
    background: var(--ss-dropdown-bg, #fff);
    border: 1px solid var(--ss-border-color, #d1d5db);
    border-radius: var(--ss-dropdown-radius, 8px);
    box-shadow: var(--ss-dropdown-shadow, 0 4px 24px rgba(0, 0, 0, 0.12));
    overflow: hidden;
    z-index: var(--ss-z-index, 100);
    max-height: var(--ss-dropdown-max-height, 360px);
    overflow-y: auto;
  }

  .ss-loading,
  .ss-empty,
  .ss-error {
    padding: var(--ss-message-padding, 10px 12px);
    font-size: var(--ss-message-font-size, 13px);
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
    padding: var(--ss-result-padding, 8px 12px);
    cursor: pointer;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .ss-result-active {
    background: var(--ss-result-active-bg, #f3f4f6);
  }

  .ss-result-title {
    font-weight: 500;
  }

  .ss-result-snippet {
    font-size: var(--ss-snippet-font-size, 12px);
    color: var(--ss-snippet-color, #6b7280);
  }

  mark {
    background: var(--ss-mark-bg, #fef08a);
    color: inherit;
    border-radius: 2px;
    padding: 0 1px;
  }
</style>
