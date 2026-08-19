/*
  SearchSocket search UI helpers
  ---------------------------------------------------------------------------
  Pure, framework-free functions shared by the generated search components.
  No DOM access, no side effects — safe to call during SSR and easy to unit
  test. This file is yours once copied; edit it freely.
*/

import type { SearchResult, SearchResultChunk } from "searchsocket";

export interface HighlightPart {
  text: string;
  match: boolean;
}

/**
 * Split `text` into alternating plain/matching parts so the caller can wrap
 * matches in `<mark>` without ever injecting HTML.
 */
export function highlightParts(text: string, query: string): HighlightPart[] {
  const terms = query
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));

  if (terms.length === 0) return [{ text, match: false }];

  const pattern = terms.join("|");
  const splitter = new RegExp(`(${pattern})`, "gi");
  const tester = new RegExp(`^(?:${pattern})$`, "i");

  return text
    .split(splitter)
    .filter(Boolean)
    .map((part) => ({ text: part, match: tester.test(part) }));
}

/** Collapse whitespace so "  deploy   guide " and "deploy guide" share a cache entry. */
export function normalizeQuery(query: string): string {
  return query.trim().replace(/\s+/g, " ");
}

const BREADCRUMB_SEPARATOR = " / ";

/**
 * Turn a result URL into a readable trail: "/docs/getting-started" becomes
 * "Docs / Getting Started". Returns "" for the site root so callers can omit
 * the line entirely.
 */
export function urlToBreadcrumb(url: string): string {
  const segments = pathnameOf(url)
    .split("/")
    .filter(Boolean)
    .filter((segment) => segment !== "index" && !/^index\.\w+$/i.test(segment))
    .map((segment) => decodeSegment(segment))
    .filter(Boolean);

  return segments.join(BREADCRUMB_SEPARATOR);
}

/** The path portion of a site-relative or absolute URL, without query or hash. */
function pathnameOf(url: string): string {
  try {
    // The base only matters for relative inputs; it never appears in the result.
    return new URL(url, "http://searchsocket.invalid").pathname;
  } catch {
    return url.split(/[?#]/)[0] ?? "";
  }
}

function decodeSegment(segment: string): string {
  let decoded = segment;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    // Leave a malformed escape sequence as-is rather than throwing at render time.
  }

  return decoded
    .replace(/\.\w+$/, "")
    .replace(/[-_]+/g, " ")
    .trim()
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

/**
 * The section that explains why a page matched, or null when there is nothing
 * useful to add beside the title.
 */
export function resultSectionLabel(result: {
  title?: string;
  sectionTitle?: string;
}): string | null {
  const section = result.sectionTitle?.trim();
  if (!section) return null;
  if (section.toLowerCase() === (result.title ?? "").trim().toLowerCase()) return null;
  return section;
}

/**
 * Matching sections worth listing under a page result: deduplicated, never
 * repeating the page title or the section already shown as metadata.
 */
export function subResultsFor(result: SearchResult, max = 3): SearchResultChunk[] {
  if (max <= 0 || !result.chunks) return [];

  const seen = new Set<string>();
  const primary = resultSectionLabel(result);
  if (primary) seen.add(primary.toLowerCase());
  seen.add((result.title ?? "").trim().toLowerCase());

  const picked: SearchResultChunk[] = [];
  for (const chunk of result.chunks) {
    const section = chunk.sectionTitle?.trim();
    if (!section) continue;
    const key = section.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    picked.push(chunk);
    if (picked.length >= max) break;
  }

  return picked;
}

/** A chunk rendered as its own scroll-to-text destination on the parent page. */
export function chunkAsResult(result: SearchResult, chunk: SearchResultChunk): SearchResult {
  return {
    ...result,
    sectionTitle: chunk.sectionTitle,
    snippet: chunk.snippet,
    chunks: undefined,
  };
}

/**
 * "⌘K" on Apple platforms, "Ctrl K" everywhere else. Returns the non-Apple
 * label when there is no navigator, so server rendering is deterministic;
 * components should recompute after mount.
 */
export function platformShortcutLabel(): string {
  return isApplePlatform() ? "⌘K" : "Ctrl K";
}

export function isApplePlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  const platform =
    (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ??
    navigator.platform ??
    navigator.userAgent ??
    "";
  return /mac|iphone|ipad|ipod/i.test(platform);
}

/** Stable per-instance element IDs derived from one component base ID. */
export function optionId(baseId: string, index: number): string {
  return `${baseId}-option-${index}`;
}

/** Clamp an index into `[0, length)`, wrapping around, or -1 for an empty list. */
export function wrapIndex(index: number, length: number): number {
  if (length <= 0) return -1;
  return ((index % length) + length) % length;
}

/**
 * Match a keyboard event against a small shortcut spec: "mod+k" (Cmd on Apple,
 * Ctrl elsewhere), "ctrl+k", "meta+k", "shift+/" or a bare key like "/".
 *
 * An unmodified shortcut is ignored while the user is typing in a field, so a
 * bare "/" never steals a keystroke from a form.
 */
const MODIFIERS = new Set(["mod", "ctrl", "meta", "shift", "alt"]);

export function matchesShortcut(event: KeyboardEvent, spec: string): boolean {
  const parts = spec
    .toLowerCase()
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);

  const key = parts.pop();
  if (!key) return false;
  // A typo like "cmd+k" should never quietly degrade into a bare "k".
  if (parts.some((part) => !MODIFIERS.has(part))) return false;

  const wantMod = parts.includes("mod");
  const wantCtrl = parts.includes("ctrl");
  const wantMeta = parts.includes("meta");
  const wantShift = parts.includes("shift");
  const wantAlt = parts.includes("alt");

  if (event.key.toLowerCase() !== key) return false;
  if (wantShift !== event.shiftKey) return false;
  if (wantAlt !== event.altKey) return false;

  if (wantMod) {
    if (!event.metaKey && !event.ctrlKey) return false;
  } else {
    if (wantCtrl !== event.ctrlKey) return false;
    if (wantMeta !== event.metaKey) return false;
  }

  if (!wantMod && !wantCtrl && !wantMeta && isTypingTarget(event.target)) return false;

  return true;
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!target || typeof (target as Element).tagName !== "string") return false;
  const element = target as HTMLElement;
  const tag = element.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || element.isContentEditable;
}

/**
 * Focusable descendants of `root`, in tab order. The modal only renders while
 * open, so everything matched here is on screen — no visibility filtering is
 * needed, and leaving it out keeps the helper testable outside a real browser.
 */
export function focusableWithin(root: HTMLElement): HTMLElement[] {
  const selector = [
    "a[href]",
    "button:not([disabled])",
    "input:not([disabled]):not([type='hidden'])",
    "select:not([disabled])",
    "textarea:not([disabled])",
    "[tabindex]:not([tabindex='-1'])",
  ].join(",");

  return Array.from(root.querySelectorAll<HTMLElement>(selector)).filter(
    (element) => !element.hasAttribute("hidden") && element.getAttribute("aria-hidden") !== "true"
  );
}


/**
 * Reference-counted body scroll lock.
 *
 * A naive save/restore breaks with two open dialogs: the second saves the
 * already-locked value, so closing the first unlocks the page and closing the
 * second restores "hidden" for good. Only the first lock records the original
 * value, and only the last release puts it back.
 */
let scrollLocks = 0;
let previousOverflow: { value: string; priority: string } | null = null;

export function lockBodyScroll(): () => void {
  if (typeof document === "undefined") return () => {};

  if (scrollLocks === 0) {
    previousOverflow = {
      value: document.body.style.getPropertyValue("overflow"),
      priority: document.body.style.getPropertyPriority("overflow"),
    };
    document.body.style.setProperty("overflow", "hidden");
  }
  scrollLocks += 1;

  let released = false;
  return () => {
    if (released) return;
    released = true;
    scrollLocks -= 1;
    if (scrollLocks > 0) return;

    const previous = previousOverflow;
    previousOverflow = null;
    if (previous?.value) {
      document.body.style.setProperty("overflow", previous.value, previous.priority);
    } else {
      document.body.style.removeProperty("overflow");
    }
  };
}
