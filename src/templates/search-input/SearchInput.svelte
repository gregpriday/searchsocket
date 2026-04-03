<!--
  SearchInput — Inline search input with dropdown results for SearchSocket
  Minimal Tailwind 4 starting point. Customize freely.
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

  const search = createSearch({ endpoint, topK: 8, groupBy: "page" });

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
    return activeIndex >= 0 && activeIndex < search.results.length
      ? `ss-inline-option-${activeIndex}`
      : undefined;
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
        if (activeIndex >= 0 && activeIndex < count) navigateTo(search.results[activeIndex]);
        break;
      case "Escape":
        e.preventDefault();
        dropdownOpen = false;
        inputEl?.blur();
        break;
    }
  }

  function handleFocusOut(e: FocusEvent) {
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
    const escaped = query.trim().split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
    const splitter = new RegExp(`(${escaped})`, "gi");
    const tester = new RegExp(`^(?:${escaped})$`, "i");
    return text.split(splitter).filter(Boolean).map((part) => ({ text: part, match: tester.test(part) }));
  }
</script>

<div class="relative w-full" bind:this={containerEl} onfocusout={handleFocusOut}>
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
    class="w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 dark:border-neutral-700 dark:bg-neutral-900"
  />

  {#if showDropdown}
    <div class="absolute top-full left-0 right-0 z-50 mt-1 overflow-hidden rounded-md border bg-white shadow-lg dark:border-neutral-700 dark:bg-neutral-900">
      {#if search.loading}
        <div class="px-3 py-2 text-sm text-neutral-500" aria-live="polite">Searching...</div>
      {/if}

      {#if search.error}
        <div class="px-3 py-2 text-sm text-red-600" role="alert">{search.error.message}</div>
      {/if}

      {#if search.results.length > 0}
        <ul role="listbox" id={listboxId} class="max-h-72 overflow-y-auto">
          {#each search.results as result, i}
            <li
              role="option"
              id="ss-inline-option-{i}"
              aria-selected={i === activeIndex}
              class="flex cursor-pointer flex-col gap-0.5 px-3 py-2 {i === activeIndex ? 'bg-neutral-100 dark:bg-neutral-800' : ''}"
              onclick={() => navigateTo(result)}
              onmouseenter={() => (activeIndex = i)}
            >
              <span class="font-medium">
                {#each highlightParts(result.title, search.query) as part}
                  {#if part.match}<mark class="rounded-sm bg-yellow-200 dark:bg-yellow-500/30">{part.text}</mark>{:else}{part.text}{/if}
                {/each}
              </span>
              {#if result.snippet}
                <span class="text-sm text-neutral-500 dark:text-neutral-400">
                  {#each highlightParts(result.snippet, search.query) as part}
                    {#if part.match}<mark class="rounded-sm bg-yellow-200 dark:bg-yellow-500/30">{part.text}</mark>{:else}{part.text}{/if}
                  {/each}
                </span>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}

      {#if search.query && !search.loading && search.results.length === 0 && !search.error}
        <div class="px-3 py-2 text-sm text-neutral-500">No results found.</div>
      {/if}
    </div>
  {/if}
</div>
