# Building a Search UI

This guide walks through building a complete search experience with SearchSocket in a SvelteKit app. It covers the building blocks, common patterns, and practical examples — without prescribing any particular visual style.

## Quick start with templates

SearchSocket includes copy-paste Svelte 5 components you can add to your project and customize freely:

```bash
pnpm searchsocket add search-dialog     # Cmd+K modal dialog
pnpm searchsocket add search-input      # Inline input with dropdown
pnpm searchsocket add search-results    # Standalone result list
```

These are copied into `src/lib/components/search/` (configurable with `--dir`). They use Tailwind 4 utility classes, include full keyboard navigation, ARIA attributes, and dark mode support. The styling is intentionally minimal — just enough structure to be functional. Edit them however you like — they're your code once copied.

The rest of this guide explains the underlying building blocks so you can build from scratch or understand what the templates are doing.

## Building blocks

SearchSocket provides three layers for building search UIs:

### 1. `createSearch` — reactive Svelte 5 store

The easiest way to wire up search in a Svelte component. Handles debouncing, caching, abort control, and loading state.

```svelte
<script>
  import { createSearch } from "searchsocket/svelte";

  const search = createSearch({
    debounce: 250,      // ms before firing request (default)
    cache: true,         // LRU result caching (default)
    cacheSize: 50,       // max cached queries (default)
    topK: 10,
    groupBy: "page"
  });
</script>

<input bind:value={search.query} />

<!-- Reactive properties: -->
<!-- search.results  — SearchResult[] -->
<!-- search.loading  — boolean -->
<!-- search.error    — Error | null -->
<!-- search.destroy()— cleanup function -->
```

The store is reactive — updating `search.query` triggers a debounced search automatically. Previous in-flight requests are aborted when a new query comes in.

### 2. `createSearchClient` — imperative client

For full control over when and how searches happen. Useful when you need custom debounce logic, want to trigger search on form submit, or are working outside Svelte components.

```ts
import { createSearchClient } from "searchsocket/client";

const client = createSearchClient({
  endpoint: "/api/search"   // default
});

const response = await client.search({
  q: "deployment guide",
  topK: 8,
  groupBy: "page",
  pathPrefix: "/docs",       // scope to a section
  tags: ["guide"],           // filter by tags
  maxSubResults: 3           // chunks per page result
});
```

### 3. `buildResultUrl` — scroll-to-text links

Builds a URL from a search result that includes scroll-to-text metadata. When the user navigates to the result, the page scrolls to the matching section and highlights the text.

```ts
import { buildResultUrl } from "searchsocket/client";

const href = buildResultUrl(result);
// "/docs/getting-started?_ssk=Installation&_sskt=Install+with+pnpm#:~:text=Install%20with%20pnpm"
```

Use this as the `href` for result links. If the result has no section title, the original URL is returned unchanged.

## Search modal (Cmd+K pattern)

The most common search UI pattern: a modal triggered by a keyboard shortcut.

### Basic structure

```svelte
<!-- SearchModal.svelte -->
<script lang="ts">
  import { createSearch } from "searchsocket/svelte";
  import { buildResultUrl } from "searchsocket/client";
  import { goto } from "$app/navigation";

  let { open = $bindable(false) }: { open?: boolean } = $props();

  const search = createSearch({ topK: 8, groupBy: "page" });

  let activeIndex = $state(-1);
  let inputEl = $state<HTMLInputElement | null>(null);

  // Focus input when modal opens
  $effect(() => {
    if (open && inputEl) inputEl.focus();
  });

  // Reset selection when results change
  $effect(() => {
    search.results;
    activeIndex = -1;
  });

  function navigateTo(result: (typeof search.results)[number]) {
    open = false;
    search.query = "";
    goto(buildResultUrl(result));
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
        if (activeIndex >= 0) navigateTo(search.results[activeIndex]);
        break;
      case "Escape":
        e.preventDefault();
        open = false;
        break;
    }
  }
</script>

{#if open}
  <div class="backdrop" onclick={() => (open = false)} onkeydown={handleKeydown}>
    <div class="dialog" role="dialog" aria-modal="true" onclick={(e) => e.stopPropagation()}>
      <input
        bind:this={inputEl}
        type="text"
        role="combobox"
        aria-expanded={search.results.length > 0}
        aria-haspopup="listbox"
        aria-autocomplete="list"
        placeholder="Search..."
        value={search.query}
        oninput={(e) => (search.query = e.currentTarget.value)}
      />

      {#if search.loading}
        <div aria-live="polite">Searching...</div>
      {/if}

      {#if search.results.length > 0}
        <ul role="listbox">
          {#each search.results as result, i}
            <li
              role="option"
              aria-selected={i === activeIndex}
              onclick={() => navigateTo(result)}
              onmouseenter={() => (activeIndex = i)}
            >
              <strong>{result.title}</strong>
              {#if result.sectionTitle}
                <span>{result.sectionTitle}</span>
              {/if}
              {#if result.snippet}
                <p>{result.snippet}</p>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}

      {#if search.query && !search.loading && !search.results.length && !search.error}
        <div>No results found.</div>
      {/if}
    </div>
  </div>
{/if}
```

### Triggering with Cmd+K

Wire the keyboard shortcut in your root layout:

```svelte
<!-- src/routes/+layout.svelte -->
<script>
  import { afterNavigate } from "$app/navigation";
  import { searchsocketScrollToText } from "searchsocket/sveltekit";
  import SearchModal from "$lib/components/SearchModal.svelte";

  let searchOpen = $state(false);

  afterNavigate(searchsocketScrollToText);

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      searchOpen = !searchOpen;
    }
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<SearchModal bind:open={searchOpen} />

<slot />
```

### Preventing body scroll

Lock scrolling when the modal is open:

```svelte
$effect(() => {
  if (open) {
    document.body.style.overflow = "hidden";
  }
  return () => {
    document.body.style.overflow = "";
  };
});
```

## Scoped search

Scope search to a section of your site (e.g., only docs, only blog) by passing `pathPrefix`:

```svelte
<script>
  import { createSearch } from "searchsocket/svelte";

  let { pathPrefix = "" }: { pathPrefix?: string } = $props();

  const search = createSearch({
    topK: 8,
    groupBy: "page",
    pathPrefix: pathPrefix || undefined
  });
</script>
```

### Managing scope with a shared store

Create a lightweight state module so any component can open search with a specific scope:

```ts
// src/lib/search-state.svelte.ts
let open = $state(false);
let pathPrefix = $state("");
let placeholder = $state("Search...");

export function getSearchState() {
  return {
    get open() { return open; },
    set open(v: boolean) { open = v; },
    get pathPrefix() { return pathPrefix; },
    get placeholder() { return placeholder; },
    openGlobal() {
      pathPrefix = "";
      placeholder = "Search...";
      open = true;
    },
    openScoped(prefix: string, ph: string) {
      pathPrefix = prefix;
      placeholder = ph;
      open = true;
    }
  };
}
```

Then from a docs sidebar:

```svelte
<script>
  import { getSearchState } from "$lib/search-state.svelte";
  const search = getSearchState();
</script>

<button onclick={() => search.openScoped("/docs", "Search docs...")}>
  Search docs
</button>
```

And from the global nav:

```svelte
<button onclick={() => search.openGlobal()}>
  Search (Cmd+K)
</button>
```

## Result display patterns

### Query highlighting

Highlight matching terms in result titles and snippets:

```ts
function highlightParts(
  text: string,
  query: string
): Array<{ text: string; match: boolean }> {
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
```

Usage:

```svelte
{#each highlightParts(result.title, search.query) as part}
  {#if part.match}<mark>{part.text}</mark>{:else}{part.text}{/if}
{/each}
```

### Breadcrumb paths

Turn a result URL into a readable breadcrumb:

```ts
function urlToBreadcrumb(url: string): string {
  return url
    .replace(/^\//, "")
    .replace(/\/$/, "")
    .split("/")
    .map((s) => s.replace(/-/g, " "))
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join(" / ");
}
```

```svelte
<span class="breadcrumb">{urlToBreadcrumb(result.url)}</span>
```

### Section badges

Categorize results by URL prefix:

```svelte
{#if result.url.startsWith("/docs")}
  <span class="badge docs">Docs</span>
{:else if result.url.startsWith("/blog")}
  <span class="badge blog">Blog</span>
{/if}
```

### Sub-results (chunks)

When using `groupBy: "page"`, each result may include matching chunks from different sections of the page:

```svelte
{#each search.results as result}
  <div class="result">
    <a href={buildResultUrl(result)}>{result.title}</a>
    {#if result.chunks && result.chunks.length > 1}
      <ul class="sub-results">
        {#each result.chunks as chunk}
          <li>
            <a href={buildResultUrl({ ...result, sectionTitle: chunk.sectionTitle, snippet: chunk.snippet })}>
              {chunk.sectionTitle}
            </a>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
{/each}
```

## Scroll-to-text setup

For search result navigation to scroll to the matching section, add the handler to your root layout:

```svelte
<!-- src/routes/+layout.svelte -->
<script>
  import { afterNavigate } from "$app/navigation";
  import { searchsocketScrollToText } from "searchsocket/sveltekit";

  afterNavigate(searchsocketScrollToText);
</script>
```

This reads the `_ssk` and `_sskt` query params from URLs generated by `buildResultUrl()` and:

1. Finds the matching text in the DOM using a TreeWalker
2. Scrolls smoothly to the match
3. Highlights the text using the CSS Custom Highlight API (with a DOM `<mark>` fallback)

Customize the highlight appearance:

```css
/* CSS Custom Highlight API (modern browsers) */
::highlight(ssk-highlight) {
  background-color: rgba(250, 204, 21, 0.4);
}

/* DOM fallback */
.ssk-highlight {
  background-color: rgba(250, 204, 21, 0.4);
  border-radius: 2px;
}
```

## Styling

The template components use Tailwind 4 utility classes with intentionally minimal styling — just enough to be functional. They include `dark:` variants out of the box. Since they're copied into your project, you style them by editing the classes directly.

The templates use neutral colors and standard Tailwind utilities. Replace them with your design system's tokens or custom classes as needed.

## Using the imperative client

For cases where the reactive store doesn't fit — server-side search, custom debounce, form-based search pages:

```ts
import { createSearchClient } from "searchsocket/client";

const client = createSearchClient();

// Search with all available parameters
const response = await client.search({
  q: "deployment",
  topK: 10,
  groupBy: "page",        // "page" (default) or "chunk"
  pathPrefix: "/docs",     // filter by URL prefix
  tags: ["guide"],         // filter by tags (AND logic)
  filters: { version: 2 }, // structured metadata filters
  maxSubResults: 5         // max chunks per page result
});

// Response shape
response.results     // SearchResult[]
response.q           // echoed query
response.scope       // resolved scope name
response.meta        // { timingsMs: { total: number } }
```

### Search result shape

```ts
interface SearchResult {
  url: string;
  title: string;
  sectionTitle?: string;        // heading of best-matching section
  snippet: string;              // text excerpt
  chunkText?: string;           // full chunk text (chunk mode)
  score: number;                // relevance score (0-1)
  routeFile: string;            // SvelteKit source file path
  chunks?: SearchResultChunk[]; // sub-results (page mode only)
}

interface SearchResultChunk {
  sectionTitle?: string;
  snippet: string;
  headingPath: string[];        // e.g. ["Getting Started", "Installation"]
  score: number;
}
```

## Accessibility

The template components include ARIA attributes for screen readers. If building from scratch, the key attributes are:

- Input: `role="combobox"`, `aria-expanded`, `aria-haspopup="listbox"`, `aria-autocomplete="list"`, `aria-activedescendant`
- Results list: `role="listbox"`
- Each result: `role="option"`, `aria-selected`, unique `id`
- Modal: `role="dialog"`, `aria-modal="true"`, `aria-label`
- Loading/error states: `aria-live="polite"` or `role="alert"`

## SvelteKit preloading

Speed up navigation by preloading page data when the user hovers a result:

```svelte
<script>
  import { preloadData } from "$app/navigation";
</script>

<a
  href={buildResultUrl(result)}
  onmouseenter={() => preloadData(result.url)}
>
  {result.title}
</a>
```

## API reference

### `POST /api/search`

The search endpoint accepts JSON:

```ts
{
  q: string;                    // required — search query
  topK?: number;                // max results (default: 10, max: 100)
  groupBy?: "page" | "chunk";  // result grouping (default: "page")
  pathPrefix?: string;          // filter by URL prefix
  tags?: string[];              // filter by tags (AND logic)
  filters?: Record<string, any>; // structured metadata filters
  maxSubResults?: number;       // chunks per page (default: 5, max: 20)
  scope?: string;               // index scope override
}
```

Also available as GET with query parameters:

```
GET /api/search?q=getting+started&topK=5&groupBy=page&pathPrefix=/docs
```

### `GET /api/search/health`

Returns backend health status:

```json
{ "status": "ok" }
```

### `GET /api/pages/<path>`

Retrieve indexed markdown for a specific page:

```
GET /api/pages/docs/getting-started
```

Returns the full page content as markdown with frontmatter.
