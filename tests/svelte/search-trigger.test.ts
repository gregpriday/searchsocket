import { describe, it, expect, afterEach } from "vitest";
import { flushSync } from "svelte";
import SearchTrigger from "../../src/templates/search-trigger/SearchTrigger.svelte";
import { box } from "./helpers/runes.svelte";
import { mountComponent, unmountAll } from "./helpers/mount";

function mountTrigger(extra: Record<string, unknown> = {}) {
  const open = box(false);
  const { target } = mountComponent(SearchTrigger, {
    get open() {
      return open.value;
    },
    set open(next: boolean) {
      open.value = next;
    },
    ...extra,
  });

  return {
    open,
    root: target.querySelector<HTMLElement>(".ss-search")!,
    button: target.querySelector<HTMLButtonElement>(".ss-search__trigger")!,
  };
}

describe("SearchTrigger template", () => {
  afterEach(() => {
    unmountAll();
    document.body.innerHTML = "";
  });

  it("opens the dialog it is bound to", () => {
    const handles = mountTrigger();
    handles.button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    flushSync();
    expect(handles.open.value).toBe(true);
  });

  it("is a real button with an accessible name", () => {
    const handles = mountTrigger({ ariaLabel: "Open documentation search" });
    expect(handles.button.tagName).toBe("BUTTON");
    // type="button" keeps it from submitting a surrounding form.
    expect(handles.button.getAttribute("type")).toBe("button");
    expect(handles.button.getAttribute("aria-label")).toBe("Open documentation search");
  });

  it("shows a label and shortcut hint by default", () => {
    const handles = mountTrigger({ label: "Search docs" });
    expect(handles.button.querySelector(".ss-search__trigger-label")?.textContent).toBe(
      "Search docs"
    );
    expect(handles.button.querySelector(".ss-search__kbd")?.textContent).toMatch(/⌘K|Ctrl K/);
  });

  it("hides the shortcut hint when asked", () => {
    const handles = mountTrigger({ showShortcut: false });
    expect(handles.button.querySelector(".ss-search__kbd")).toBeNull();
  });

  it("drops the label and hint in icon-only mode but keeps the name", () => {
    const handles = mountTrigger({ iconOnly: true });

    expect(handles.button.dataset.iconOnly).toBe("true");
    expect(handles.button.querySelector(".ss-search__trigger-label")).toBeNull();
    expect(handles.button.querySelector(".ss-search__kbd")).toBeNull();
    expect(handles.button.getAttribute("aria-label")).toBeTruthy();
  });

  it("hides its decorative icon from assistive technology", () => {
    const handles = mountTrigger();
    expect(handles.button.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("forwards theme, class and style", () => {
    const handles = mountTrigger({
      theme: "dark",
      class: "nav-trigger",
      style: "--ss-search-accent: #0f766e",
    });

    expect(handles.root.dataset.theme).toBe("dark");
    expect(handles.root.classList.contains("nav-trigger")).toBe(true);
    expect(handles.root.getAttribute("style")).toContain("--ss-search-accent");
  });
});
