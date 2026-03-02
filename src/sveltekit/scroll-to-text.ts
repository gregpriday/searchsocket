/**
 * SvelteKit scroll-to-text helper for search result navigation.
 *
 * When a visitor arrives on a page via a search result link that contains
 * a `_ss` query parameter, this hook finds the matching section heading
 * and scrolls it into view.
 *
 * Usage in a SvelteKit layout:
 * ```svelte
 * <script>
 *   import { afterNavigate } from '$app/navigation';
 *   import { searchsocketScrollToText } from 'searchsocket/sveltekit';
 *   afterNavigate(searchsocketScrollToText);
 * </script>
 * ```
 */

/** Minimal representation of SvelteKit's `AfterNavigate` parameter. */
export interface AfterNavigateParam {
  to: {
    url: URL;
  } | null;
}

/**
 * Normalize a string for loose comparison: lowercase, collapse whitespace,
 * and trim.
 */
function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * A function compatible with SvelteKit's `afterNavigate` callback.
 *
 * Reads the `_ss` query parameter from the destination URL, walks the DOM
 * for a heading whose text matches (case-insensitively), and scrolls it
 * into view. Falls back to a broader text node search if no heading matches.
 *
 * Silent no-op when `_ss` is absent or no match is found.
 */
export function searchsocketScrollToText(navigation: AfterNavigateParam): void {
  if (typeof document === "undefined") return;

  const sectionTitle = navigation.to?.url.searchParams.get("_ss");
  if (!sectionTitle) return;

  const needle = normalize(sectionTitle);
  if (!needle) return;

  // 1. Try headings first (h1–h6)
  const headings = document.querySelectorAll("h1, h2, h3, h4, h5, h6");
  for (let i = 0; i < headings.length; i++) {
    const heading = headings[i]!;
    const text = normalize(heading.textContent ?? "");
    if (text === needle || text.includes(needle)) {
      heading.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
  }

  // 2. Fallback: walk the DOM looking for a text node that contains the
  //    section title, then scroll its parent element into view.
  const walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_SKIP;
        const tag = parent.tagName;
        if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT" || tag === "TEMPLATE") {
          return NodeFilter.FILTER_SKIP;
        }
        const text = normalize(node.textContent ?? "");
        return text.includes(needle)
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_SKIP;
      }
    }
  );

  const match = walker.nextNode();
  if (match?.parentElement) {
    match.parentElement.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}
