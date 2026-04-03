<!--
  SearchDialog — Cmd+K search dialog for SearchSocket
  Minimal Tailwind 4 starting point. Customize freely.
  For non-SvelteKit apps, replace `goto` with `window.location.href = url`.
-->
<script lang="ts">
  import { createSearch } from "searchsocket/svelte";
  import { buildResultUrl } from "searchsocket/client";
  import { goto } from "$app/navigation";

  let {
    open = $bindable(false),
    endpoint = "/api/search",
    placeholder = "Search...",
  }: {
    open?: boolean;
    endpoint?: string;
    placeholder?: string;
  } = $props();

  const search = createSearch({ endpoint, topK: 8, groupBy: "page" });

  let activeIndex = $state(-1);
  let inputEl = $state<HTMLInputElement | null>(null);
  let listboxId = "ss-listbox";

  // Reset active index when results change
  $effect(() => {
    search.results;
    activeIndex = -1;
  });

  // Focus input when dialog opens
  $effect(() => {
    if (open && inputEl) inputEl.focus();
  });

  // Lock body scroll when open
  $effect(() => {
    if (open) document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = ""; };
  });

  // Global Cmd+K / Ctrl+K shortcut
  $effect(() => {
    function onKeydown(e: KeyboardEvent) {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        open = !open;
      }
    }
    document.addEventListener("keydown", onKeydown);
    return () => document.removeEventListener("keydown", onKeydown);
  });

  // Cleanup search state on destroy
  $effect(() => {
    return () => search.destroy();
  });

  function activeOptionId(): string | undefined {
    return activeIndex >= 0 && activeIndex < search.results.length
      ? `ss-option-${activeIndex}`
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
        open = false;
        break;
    }
  }

  function navigateTo(result: (typeof search.results)[number]) {
    open = false;
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

{#if open}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-[15vh]"
    onclick={() => (open = false)}
    onkeydown={handleKeydown}
  >
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="flex w-full max-w-lg flex-col overflow-hidden rounded-lg border bg-white shadow-lg dark:border-neutral-700 dark:bg-neutral-900"
      role="dialog"
      aria-modal="true"
      aria-label="Site search"
      onclick={(e) => e.stopPropagation()}
    >
      <input
        bind:this={inputEl}
        type="text"
        role="combobox"
        aria-expanded={search.results.length > 0}
        aria-haspopup="listbox"
        aria-controls={listboxId}
        aria-autocomplete="list"
        aria-activedescendant={activeOptionId()}
        {placeholder}
        value={search.query}
        oninput={(e) => (search.query = e.currentTarget.value)}
        class="w-full border-b bg-transparent px-4 py-3 text-base outline-none dark:border-neutral-700"
      />

      {#if search.loading}
        <div class="px-4 py-3 text-sm text-neutral-500" aria-live="polite">Searching...</div>
      {/if}

      {#if search.error}
        <div class="px-4 py-3 text-sm text-red-600" role="alert">{search.error.message}</div>
      {/if}

      {#if search.results.length > 0}
        <ul role="listbox" id={listboxId} class="max-h-80 overflow-y-auto">
          {#each search.results as result, i}
            <li
              role="option"
              id="ss-option-{i}"
              aria-selected={i === activeIndex}
              class="flex cursor-pointer flex-col gap-0.5 px-4 py-2.5 {i === activeIndex ? 'bg-neutral-100 dark:bg-neutral-800' : ''}"
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
        <div class="px-4 py-3 text-sm text-neutral-500">No results found.</div>
      {/if}
    </div>
  </div>
{/if}
