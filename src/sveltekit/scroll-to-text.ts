/**
 * SvelteKit scroll-to-text helper for search result navigation.
 *
 * When a visitor arrives on a page via a search result link that contains
 * a `_sskt` (text target) or `_ssk` (section title) query parameter, this
 * hook finds matching text in the document, scrolls it into view, and briefly
 * highlights it.
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

/** CSS class applied to the matched element during the highlight flash. */
const HIGHLIGHT_CLASS = "ssk-highlight";

/** Duration in milliseconds for the highlight animation. */
const HIGHLIGHT_DURATION = 2000;

/** Marker attribute used for temporary inline text wrappers. */
const HIGHLIGHT_MARKER_ATTR = "data-ssk-highlight-marker";

/** Inject the highlight keyframe animation once per page. */
let styleInjected = false;
function ensureHighlightStyle(): void {
  if (styleInjected || typeof document === "undefined") return;
  styleInjected = true;

  const style = document.createElement("style");
  style.textContent = `
    @keyframes ssk-highlight-fade {
      0%   { background-color: rgba(16, 185, 129, 0.18); }
      100% { background-color: transparent; }
    }
    .${HIGHLIGHT_CLASS} {
      animation: ssk-highlight-fade ${HIGHLIGHT_DURATION}ms ease-out forwards;
      border-radius: 4px;
    }
  `;
  document.head.appendChild(style);
}

/**
 * Apply a temporary highlight effect to an element then clean up.
 */
function highlightElement(el: Element): void {
  ensureHighlightStyle();
  el.classList.add(HIGHLIGHT_CLASS);
  setTimeout(() => el.classList.remove(HIGHLIGHT_CLASS), HIGHLIGHT_DURATION);
}

function unwrapHighlightMarker(marker: HTMLElement): void {
  if (!marker.isConnected) {
    return;
  }

  const parent = marker.parentNode;
  if (!parent) {
    return;
  }

  while (marker.firstChild) {
    parent.insertBefore(marker.firstChild, marker);
  }

  parent.removeChild(marker);
  if (parent instanceof Element) {
    parent.normalize();
  }
}

/**
 * Normalize a string for loose comparison: lowercase, collapse whitespace,
 * and trim.
 */
function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildNeedleRegex(needle: string): RegExp | null {
  const tokenParts = needle.split(/[^\p{L}\p{N}]+/u).filter(Boolean);

  if (tokenParts.length > 1) {
    const pattern = tokenParts.map((part) => escapeRegExp(part)).join("[^\\p{L}\\p{N}]+");
    return new RegExp(pattern, "iu");
  }

  if (tokenParts.length === 1) {
    return new RegExp(escapeRegExp(tokenParts[0]!), "iu");
  }

  if (!needle) {
    return null;
  }

  return new RegExp(escapeRegExp(needle).replace(/\s+/g, "\\s+"), "i");
}

function isIgnoredParent(el: Element): boolean {
  const tag = el.tagName;
  return tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT" || tag === "TEMPLATE";
}

function scrollIntoViewIfPossible(el: Element): void {
  if (typeof (el as { scrollIntoView?: unknown }).scrollIntoView !== "function") {
    return;
  }
  (el as { scrollIntoView: (options: ScrollIntoViewOptions) => void }).scrollIntoView({
    behavior: "smooth",
    block: "start"
  });
}

type ScrollMatch =
  | {
      kind: "range";
      node: Text;
      start: number;
      end: number;
      parent: Element;
    }
  | {
      kind: "element";
      element: Element;
    };

function findScrollMatch(needle: string): ScrollMatch | null {
  const regex = buildNeedleRegex(needle);
  const walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent || isIgnoredParent(parent)) return NodeFilter.FILTER_SKIP;
        if (!normalize(node.textContent ?? "")) return NodeFilter.FILTER_SKIP;
        return NodeFilter.FILTER_ACCEPT;
      }
    }
  );

  let fallbackElement: Element | null = null;
  for (let current = walker.nextNode(); current; current = walker.nextNode()) {
    const textNode = current as Text;
    const parent = textNode.parentElement;
    if (!parent) continue;

    const text = textNode.textContent ?? "";
    if (!text) continue;

    if (regex) {
      const match = regex.exec(text);
      if (match?.[0] && typeof match.index === "number") {
        return {
          kind: "range",
          node: textNode,
          start: match.index,
          end: match.index + match[0].length,
          parent
        };
      }
    }

    if (!fallbackElement && normalize(text).includes(needle)) {
      fallbackElement = parent;
    }
  }

  if (fallbackElement) {
    return { kind: "element", element: fallbackElement };
  }

  return null;
}

function highlightTextMatch(match: Extract<ScrollMatch, { kind: "range" }>): Element {
  ensureHighlightStyle();

  try {
    const range = document.createRange();
    range.setStart(match.node, match.start);
    range.setEnd(match.node, match.end);

    const marker = document.createElement("span");
    marker.classList.add(HIGHLIGHT_CLASS);
    marker.setAttribute(HIGHLIGHT_MARKER_ATTR, "true");
    range.surroundContents(marker);
    setTimeout(() => unwrapHighlightMarker(marker), HIGHLIGHT_DURATION);
    return marker;
  } catch {
    highlightElement(match.parent);
    return match.parent;
  }
}

/**
 * A function compatible with SvelteKit's `afterNavigate` callback.
 *
 * Reads `_sskt` (preferred) or `_ssk` from the destination URL, walks text
 * nodes in document order, and scrolls/highlights the first match.
 *
 * Silent no-op when no target parameter is present or no match is found.
 */
export function searchsocketScrollToText(navigation: AfterNavigateParam): void {
  if (typeof document === "undefined") return;

  const searchParams = navigation.to?.url.searchParams;
  const rawNeedle = searchParams?.get("_sskt") ?? searchParams?.get("_ssk");
  if (!rawNeedle) return;

  const needle = normalize(rawNeedle);
  if (!needle) return;

  const match = findScrollMatch(needle);
  if (!match) return;

  if (match.kind === "range") {
    const marker = highlightTextMatch(match);
    const scrollTarget = typeof (marker as { scrollIntoView?: unknown }).scrollIntoView === "function"
      ? marker
      : match.parent;
    scrollIntoViewIfPossible(scrollTarget);
    return;
  }

  scrollIntoViewIfPossible(match.element);
  highlightElement(match.element);
}
