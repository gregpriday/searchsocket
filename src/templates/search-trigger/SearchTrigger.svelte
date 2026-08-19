<!--
  SearchTrigger — the visible button that opens SearchDialog.

  A keyboard shortcut alone is not discoverable, so most sites want this in the
  header or sidebar. Bind it to the same `open` state as the dialog:

    <SearchTrigger bind:open={searchOpen} />
    <SearchDialog bind:open={searchOpen} />

  Layout placement belongs to your app, which is why this is separate from the
  dialog rather than baked into it.
-->
<script lang="ts">
  import { platformShortcutLabel } from "./search-ui";
  import "./search-theme.css";

  let {
    open = $bindable(false),
    label = "Search",
    ariaLabel = "Open site search",
    theme = "inherit",
    showShortcut = true,
    iconOnly = false,
    class: className = "",
    style = "",
  }: {
    open?: boolean;
    label?: string;
    ariaLabel?: string;
    theme?: "inherit" | "system" | "light" | "dark";
    showShortcut?: boolean;
    iconOnly?: boolean;
    class?: string;
    style?: string;
  } = $props();

  let shortcutLabel = $state("Ctrl K");

  // Resolved after mount so server and client render the same initial markup.
  $effect(() => {
    shortcutLabel = platformShortcutLabel();
  });
</script>

<div class="ss-search ss-search--trigger {className}" data-theme={theme} {style}>
  <button
    type="button"
    class="ss-search__trigger"
    data-icon-only={iconOnly}
    aria-label={ariaLabel}
    onclick={() => (open = true)}
  >
    <svg class="ss-search__search-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor"
      stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
      <circle cx="9" cy="9" r="5.5" />
      <path d="M13.2 13.2 17 17" />
    </svg>

    {#if !iconOnly}
      <span class="ss-search__trigger-label">{label}</span>
      {#if showShortcut}
        <kbd class="ss-search__kbd">{shortcutLabel}</kbd>
      {/if}
    {/if}
  </button>
</div>
