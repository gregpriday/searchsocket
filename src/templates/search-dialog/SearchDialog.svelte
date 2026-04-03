<!--
  SearchDialog — Cmd+K search dialog for SearchSocket
  Copy-paste component: edit freely to match your project.
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

  const search = createSearch({ endpoint });

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
    if (open && inputEl) {
      inputEl.focus();
    }
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
    if (activeIndex >= 0 && activeIndex < search.results.length) {
      return `ss-option-${activeIndex}`;
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

{#if open}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="ss-backdrop" onclick={() => (open = false)} onkeydown={handleKeydown}>
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="ss-dialog" role="dialog" aria-modal="true" aria-label="Site search" onclick={(e) => e.stopPropagation()}>
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
        class="ss-input"
      />

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
              id="ss-option-{i}"
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
  </div>
{/if}

<style>
  .ss-backdrop {
    position: fixed;
    inset: 0;
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding-top: var(--ss-dialog-top, 15vh);
    background: var(--ss-backdrop-bg, rgba(0, 0, 0, 0.5));
    z-index: var(--ss-z-index, 9999);
  }

  .ss-dialog {
    width: var(--ss-dialog-width, 560px);
    max-width: 90vw;
    max-height: var(--ss-dialog-max-height, 480px);
    display: flex;
    flex-direction: column;
    background: var(--ss-dialog-bg, #fff);
    border-radius: var(--ss-dialog-radius, 12px);
    box-shadow: var(--ss-dialog-shadow, 0 16px 70px rgba(0, 0, 0, 0.2));
    overflow: hidden;
  }

  .ss-input {
    width: 100%;
    padding: var(--ss-input-padding, 16px);
    border: none;
    outline: none;
    font-size: var(--ss-input-font-size, 16px);
    background: transparent;
    color: inherit;
  }

  .ss-loading,
  .ss-empty,
  .ss-error {
    padding: var(--ss-message-padding, 12px 16px);
    font-size: var(--ss-message-font-size, 14px);
  }

  .ss-error {
    color: var(--ss-error-color, #dc2626);
  }

  .ss-results {
    list-style: none;
    margin: 0;
    padding: 0;
    overflow-y: auto;
    border-top: 1px solid var(--ss-border-color, #e5e7eb);
  }

  .ss-result {
    padding: var(--ss-result-padding, 10px 16px);
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
