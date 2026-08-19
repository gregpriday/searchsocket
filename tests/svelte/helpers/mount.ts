import { flushSync, mount, unmount } from "svelte";
import { vi } from "vitest";
import type { SearchResponse, SearchResult } from "../../../src/types";

export interface MountedComponent {
  target: HTMLElement;
  instance: Record<string, unknown>;
  destroy: () => void;
}

const mounted: MountedComponent[] = [];

export function mountComponent(
  component: Parameters<typeof mount>[0],
  props: Record<string, unknown> = {}
): MountedComponent {
  const target = document.createElement("div");
  document.body.appendChild(target);

  const instance = mount(component, { target, props }) as Record<string, unknown>;
  flushSync();

  const entry: MountedComponent = {
    target,
    instance,
    destroy() {
      void unmount(instance);
      target.remove();
    },
  };
  mounted.push(entry);
  return entry;
}

export function unmountAll(): void {
  while (mounted.length > 0) {
    mounted.pop()!.destroy();
  }
}

/** Let the debounce timer fire and any resulting promises resolve. */
export async function settle(ms = 5): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
  await Promise.resolve();
  flushSync();
}

export function makeResult(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    url: "/docs/getting-started",
    title: "Getting Started",
    sectionTitle: "Installation",
    snippet: "Install SearchSocket with pnpm and configure Upstash.",
    score: 0.9,
    ...overrides,
  };
}

type FetchBehavior = { kind: "results"; results: SearchResult[] } | { kind: "failure"; message: string };

let behavior: FetchBehavior = { kind: "results", results: [] };

/**
 * One stable `fetch` stub for the whole test. `createSearch()` captures the
 * global at creation time, so swapping `globalThis.fetch` after a component
 * mounts would never reach the store — the behavior has to change behind a
 * single function instead.
 */
export function installFetchStub(): ReturnType<typeof vi.fn> {
  behavior = { kind: "results", results: [] };
  const impl = vi.fn(async () => {
    if (behavior.kind === "failure") throw new Error(behavior.message);
    const payload: SearchResponse = {
      q: "test",
      scope: "",
      results: behavior.results,
      meta: { timingsMs: { search: 1, total: 2 } },
    };
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", impl);
  return impl;
}

export function respondWith(results: SearchResult[]): void {
  behavior = { kind: "results", results };
}

export function failWith(message = "boom"): void {
  behavior = { kind: "failure", message };
}

/** jsdom implements neither of these, and the components call both. */
export function installDomStubs(): void {
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = vi.fn();
  }
}

export function keydown(target: EventTarget, init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  flushSync();
  return event;
}
