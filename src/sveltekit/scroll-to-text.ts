/**
 * SvelteKit scroll-to-text helper for search result navigation.
 *
 * When a visitor arrives on a page via a search result link that contains
 * a `_sskt` (text target) or `_ssk` (section title) query parameter, this
 * hook finds matching text in the document, scrolls it into view, and briefly
 * highlights it.
 *
 * Uses a TreeWalker-based text map to match across split DOM nodes (e.g.
 * `<em>Install</em>ation`), and the CSS Custom Highlight API when available
 * for non-destructive highlighting that avoids DOM mutation.
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

/** Name for the CSS Custom Highlight API registry entry. */
const HIGHLIGHT_NAME = "ssk-search-match";

// ---------- Style injection ----------

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
    ::highlight(${HIGHLIGHT_NAME}) {
      background-color: rgba(16, 185, 129, 0.18);
    }
  `;
  document.head.appendChild(style);
}

// ---------- Text map ----------

interface TextChunk {
  node: Text;
  start: number;
  end: number;
}

interface TextMap {
  text: string;
  chunks: TextChunk[];
}

const IGNORED_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"]);

function buildTextMap(root: Node): TextMap {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent || IGNORED_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });

  const chunks: TextChunk[] = [];
  let text = "";
  let current: Node | null;

  while ((current = walker.nextNode())) {
    const value = (current as Text).nodeValue ?? "";
    if (!value) continue;
    chunks.push({ node: current as Text, start: text.length, end: text.length + value.length });
    text += value;
  }

  return { text, chunks };
}

// ---------- Matching ----------

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildNeedleRegex(needle: string): RegExp | null {
  const tokenParts = needle.split(/[^\p{L}\p{N}]+/u).filter(Boolean);

  if (tokenParts.length > 1) {
    const pattern = tokenParts.map(escapeRegExp).join("[^\\p{L}\\p{N}]+");
    return new RegExp(pattern, "iu");
  }

  if (tokenParts.length === 1) {
    return new RegExp(escapeRegExp(tokenParts[0]!), "iu");
  }

  if (!needle) return null;
  return new RegExp(escapeRegExp(needle).replace(/\s+/g, "\\s+"), "i");
}

function buildLenientRegex(needle: string): RegExp | null {
  const tokenParts = needle.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (tokenParts.length <= 1) return null;
  const pattern = tokenParts.map(escapeRegExp).join("[^\\p{L}\\p{N}]*");
  return new RegExp(pattern, "iu");
}

interface MatchOffsets {
  start: number;
  end: number;
}

function findMatch(fullText: string, needle: string): MatchOffsets | null {
  const regex = buildNeedleRegex(needle);
  if (regex) {
    const m = regex.exec(fullText);
    if (m && typeof m.index === "number") {
      return { start: m.index, end: m.index + m[0].length };
    }
  }

  // Lenient pass: allow zero separators between tokens (handles adjacent DOM nodes)
  const lenient = buildLenientRegex(needle);
  if (lenient) {
    const m = lenient.exec(fullText);
    if (m && typeof m.index === "number") {
      return { start: m.index, end: m.index + m[0].length };
    }
  }

  return null;
}

// ---------- Range resolution ----------

function resolveRange(map: TextMap, offsets: MatchOffsets): Range | null {
  let startChunk: TextChunk | undefined;
  let endChunk: TextChunk | undefined;

  for (const chunk of map.chunks) {
    if (!startChunk && offsets.start >= chunk.start && offsets.start < chunk.end) {
      startChunk = chunk;
    }
    if (offsets.end > chunk.start && offsets.end <= chunk.end) {
      endChunk = chunk;
    }
    if (startChunk && endChunk) break;
  }

  if (!startChunk || !endChunk) return null;

  const range = document.createRange();
  range.setStart(startChunk.node, offsets.start - startChunk.start);
  range.setEnd(endChunk.node, offsets.end - endChunk.start);
  return range;
}

// ---------- Highlighting ----------

function hasCustomHighlightAPI(): boolean {
  return typeof CSS !== "undefined" && typeof (CSS as any).highlights !== "undefined";
}

let highlightTimer: ReturnType<typeof setTimeout> | null = null;

function highlightWithCSS(range: Range): void {
  ensureHighlightStyle();
  const hl = new (globalThis as any).Highlight(range);
  (CSS as any).highlights.set(HIGHLIGHT_NAME, hl);

  if (highlightTimer) clearTimeout(highlightTimer);
  highlightTimer = setTimeout(() => {
    (CSS as any).highlights.delete(HIGHLIGHT_NAME);
    highlightTimer = null;
  }, HIGHLIGHT_DURATION);
}

function unwrapMarker(marker: HTMLElement): void {
  if (!marker.isConnected) return;
  const parent = marker.parentNode;
  if (!parent) return;
  while (marker.firstChild) parent.insertBefore(marker.firstChild, marker);
  parent.removeChild(marker);
  if (parent instanceof Element) parent.normalize();
}

function highlightWithDOM(range: Range): Element {
  ensureHighlightStyle();
  try {
    const marker = document.createElement("span");
    marker.classList.add(HIGHLIGHT_CLASS);
    marker.setAttribute(HIGHLIGHT_MARKER_ATTR, "true");
    range.surroundContents(marker);
    setTimeout(() => unwrapMarker(marker), HIGHLIGHT_DURATION);
    return marker;
  } catch {
    // surroundContents fails on cross-element ranges — highlight the ancestor
    const ancestor = range.commonAncestorContainer;
    const el = ancestor instanceof Element ? ancestor : ancestor.parentElement;
    if (el) {
      el.classList.add(HIGHLIGHT_CLASS);
      setTimeout(() => el.classList.remove(HIGHLIGHT_CLASS), HIGHLIGHT_DURATION);
      return el;
    }
    return document.body;
  }
}

// ---------- Scrolling ----------

function scrollToRange(range: Range): void {
  const rect = range.getBoundingClientRect();
  window.scrollTo({
    top: window.scrollY + rect.top - window.innerHeight / 3,
    behavior: "smooth"
  });
}

function scrollIntoViewIfPossible(el: Element): void {
  if (typeof (el as any).scrollIntoView === "function") {
    el.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

// ---------- Main ----------

/**
 * A function compatible with SvelteKit's `afterNavigate` callback.
 *
 * Reads `_sskt` (preferred) or `_ssk` from the destination URL, walks text
 * nodes in document order via a TreeWalker text map, and scrolls/highlights
 * the first match. Matches can span multiple DOM text nodes.
 *
 * Uses the CSS Custom Highlight API when available for non-destructive
 * highlighting, with a DOM mutation fallback for older browsers.
 *
 * Silent no-op when no target parameter is present or no match is found.
 */
export function searchsocketScrollToText(navigation: AfterNavigateParam): void {
  if (typeof document === "undefined") return;

  const params = navigation.to?.url.searchParams;
  const raw = params?.get("_sskt") ?? params?.get("_ssk");
  if (!raw) return;

  const needle = normalize(raw);
  if (!needle) return;

  const map = buildTextMap(document.body);
  const offsets = findMatch(map.text, needle);
  if (!offsets) return;

  const range = resolveRange(map, offsets);
  if (!range) return;

  if (hasCustomHighlightAPI()) {
    highlightWithCSS(range);
    scrollToRange(range);
  } else {
    const marker = highlightWithDOM(range);
    const target =
      typeof (marker as any).scrollIntoView === "function" ? marker : marker.parentElement;
    if (target) scrollIntoViewIfPossible(target);
  }
}
