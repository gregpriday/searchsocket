import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { flushSync } from "svelte";
import SearchDialog from "../../src/templates/search-dialog/SearchDialog.svelte";
import SearchInput from "../../src/templates/search-input/SearchInput.svelte";
import { navigations, resetNavigations } from "../helpers/app-navigation";
import { box } from "./helpers/runes.svelte";
import {
  failWith,
  installDomStubs,
  installFetchStub,
  keydown,
  makeResult,
  mountComponent,
  respondWith,
  settle,
  unmountAll,
} from "./helpers/mount";

installDomStubs();

const RESULTS = [
  makeResult({ url: "/docs/getting-started", title: "Getting Started" }),
  makeResult({ url: "/docs/configuration", title: "Configuration", sectionTitle: "Environment" }),
  makeResult({ url: "/docs/deploy", title: "Deploying", sectionTitle: undefined }),
];

interface DialogHandles {
  open: { value: boolean };
  root: () => HTMLElement | null;
  input: () => HTMLInputElement;
  options: () => HTMLLIElement[];
}

function mountDialog(extra: Record<string, unknown> = {}, initialOpen = true): DialogHandles {
  const open = box(initialOpen);
  const { target } = mountComponent(SearchDialog, {
    get open() {
      return open.value;
    },
    set open(next: boolean) {
      open.value = next;
    },
    debounce: 0,
    ...extra,
  });

  return {
    open,
    root: () => target.querySelector<HTMLElement>(".ss-search"),
    input: () => target.querySelector<HTMLInputElement>(".ss-search__input")!,
    options: () => Array.from(target.querySelectorAll<HTMLLIElement>(".ss-search__option")),
  };
}

async function typeQuery(handles: DialogHandles, query: string, waitMs = 5): Promise<void> {
  const input = handles.input();
  input.value = query;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  flushSync();
  await settle(waitMs);
}

describe("SearchDialog template", () => {
  let fetchMock: ReturnType<typeof installFetchStub>;

  beforeEach(() => {
    resetNavigations();
    fetchMock = installFetchStub();
    respondWith(RESULTS);
  });

  afterEach(() => {
    unmountAll();
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
    document.body.style.overflow = "";
  });

  describe("shortcut", () => {
    it("opens on the mod+k shortcut", () => {
      const handles = mountDialog({}, false);
      expect(handles.root()).toBeNull();

      const event = keydown(document, { key: "k", metaKey: true });
      expect(event.defaultPrevented).toBe(true);
      expect(handles.open.value).toBe(true);
    });

    it("ignores the shortcut when disabled", () => {
      const handles = mountDialog({ shortcut: false }, false);
      keydown(document, { key: "k", metaKey: true });
      expect(handles.open.value).toBe(false);
    });

    it("does not close an already-open dialog", () => {
      const handles = mountDialog({}, true);
      keydown(document, { key: "k", ctrlKey: true });
      expect(handles.open.value).toBe(true);
    });

    it("lets only one dialog claim a single press", () => {
      const first = mountDialog({}, false);
      const second = mountDialog({}, false);

      keydown(document, { key: "k", metaKey: true });

      const opened = [first.open.value, second.open.value].filter(Boolean);
      expect(opened).toHaveLength(1);
    });

    it("accepts a custom binding", () => {
      const handles = mountDialog({ shortcut: "ctrl+/" }, false);
      keydown(document, { key: "k", metaKey: true });
      expect(handles.open.value).toBe(false);

      keydown(document, { key: "/", ctrlKey: true });
      expect(handles.open.value).toBe(true);
    });
  });

  describe("focus management", () => {
    it("focuses the input on open and restores focus on close", () => {
      const trigger = document.createElement("button");
      document.body.appendChild(trigger);
      trigger.focus();
      expect(document.activeElement).toBe(trigger);

      const handles = mountDialog({}, false);
      handles.open.value = true;
      flushSync();

      expect(document.activeElement).toBe(handles.input());

      handles.open.value = false;
      flushSync();

      expect(document.activeElement).toBe(trigger);
    });

    it("restores the previous body overflow rather than clearing it", () => {
      document.body.style.overflow = "clip";

      const handles = mountDialog({}, false);
      handles.open.value = true;
      flushSync();
      expect(document.body.style.overflow).toBe("hidden");

      handles.open.value = false;
      flushSync();
      expect(document.body.style.overflow).toBe("clip");
    });

    it("cycles Tab and Shift+Tab inside the dialog", async () => {
      const handles = mountDialog();
      // A query gives the dialog a Clear button, so there is a real cycle to
      // test rather than a single element that is both first and last.
      await typeQuery(handles, "install");

      const dialog = document.querySelector<HTMLElement>(".ss-search__dialog")!;
      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>("input, button, [tabindex]:not([tabindex='-1'])")
      );
      expect(focusable.length).toBeGreaterThan(1);

      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;

      last.focus();
      const forward = keydown(last, { key: "Tab" });
      expect(forward.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(first);

      const backward = keydown(first, { key: "Tab", shiftKey: true });
      expect(backward.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(last);
    });

    it("pulls focus back when something outside the modal takes it", () => {
      const outside = document.createElement("button");
      document.body.appendChild(outside);

      const handles = mountDialog();
      expect(document.activeElement).toBe(handles.input());

      // A Tab pressed after focus escapes would never reach the dialog's own
      // keydown handler, so containment cannot rely on that handler alone.
      outside.focus();
      outside.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
      flushSync();

      const dialog = document.querySelector<HTMLElement>(".ss-search__dialog")!;
      expect(dialog.contains(document.activeElement)).toBe(true);
    });

    it("keeps the body locked until the last open dialog closes", () => {
      document.body.style.overflow = "auto";

      const first = mountDialog({}, true);
      const second = mountDialog({}, true);
      expect(document.body.style.overflow).toBe("hidden");

      first.open.value = false;
      flushSync();
      // The second dialog is still open, so the page must stay locked.
      expect(document.body.style.overflow).toBe("hidden");

      second.open.value = false;
      flushSync();
      expect(document.body.style.overflow).toBe("auto");
    });
  });

  describe("identity", () => {
    it("gives each instance unique element ids", () => {
      const a = mountDialog();
      const b = mountDialog();

      const idA = a.input().id;
      const idB = b.input().id;
      expect(idA).toBeTruthy();
      expect(idA).not.toBe(idB);

      expect(a.input().getAttribute("aria-controls")).not.toBe(
        b.input().getAttribute("aria-controls")
      );
    });

    it("does not collide with an inline input on the same page", async () => {
      const dialog = mountDialog();
      const { target } = mountComponent(SearchInput, { debounce: 0 });

      const dialogInput = dialog.input();
      const inlineInput = target.querySelector<HTMLInputElement>(".ss-search__input")!;

      expect(dialogInput.id).not.toBe(inlineInput.id);

      // The real hazard is duplicate ids across the whole document, not just
      // across two instances of one component.
      const ids = Array.from(document.querySelectorAll<HTMLElement>("[id]")).map((el) => el.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it("uses an explicit id when given", () => {
      const handles = mountDialog({ id: "docs-search" });
      expect(handles.input().id).toBe("docs-search-input");
      expect(handles.input().getAttribute("aria-controls")).toBe("docs-search-listbox");
    });

    it("labels the input and the dialog", () => {
      const handles = mountDialog({ label: "Search documentation" });
      const dialog = document.querySelector(".ss-search__dialog")!;
      expect(dialog.getAttribute("aria-label")).toBe("Search documentation");

      const label = document.querySelector(`label[for="${handles.input().id}"]`);
      expect(label?.textContent?.trim()).toBe("Search documentation");
    });
  });

  describe("keyboard navigation", () => {
    it("selects the first result automatically and moves with arrows", async () => {
      const handles = mountDialog();
      await typeQuery(handles, "install");

      expect(handles.options()).toHaveLength(3);
      expect(handles.input().getAttribute("aria-activedescendant")).toMatch(/-option-0$/);

      const input = handles.input();
      keydown(input, { key: "ArrowDown" });
      expect(input.getAttribute("aria-activedescendant")).toMatch(/-option-1$/);

      keydown(input, { key: "ArrowUp" });
      keydown(input, { key: "ArrowUp" });
      expect(input.getAttribute("aria-activedescendant")).toMatch(/-option-2$/);

      keydown(input, { key: "Home" });
      expect(handles.options()[0]!.dataset.active).toBe("true");

      keydown(input, { key: "End" });
      expect(handles.options()[2]!.dataset.active).toBe("true");
    });

    it("leaves nothing selected when autoSelectFirst is off", async () => {
      const handles = mountDialog({ autoSelectFirst: false });
      await typeQuery(handles, "install");

      expect(handles.input().getAttribute("aria-activedescendant")).toBeNull();

      keydown(handles.input(), { key: "ArrowUp" });
      expect(handles.options()[2]!.dataset.active).toBe("true");
    });

    it("scrolls the newly active option into view", async () => {
      const spy = vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(() => {});
      const handles = mountDialog();
      await typeQuery(handles, "install");

      // Auto-selecting the first result already scrolled; clear that call so the
      // assertion is about ArrowDown and not about mounting.
      spy.mockClear();
      keydown(handles.input(), { key: "ArrowDown" });

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith({ block: "nearest" });
      expect(spy.mock.contexts[0]).toBe(handles.options()[1]);
      spy.mockRestore();
    });

    it("navigates on Enter", async () => {
      const handles = mountDialog();
      await typeQuery(handles, "install");

      keydown(handles.input(), { key: "Enter" });
      await settle();

      expect(navigations).toHaveLength(1);
      expect(navigations[0]).toContain("/docs/getting-started");
      expect(handles.open.value).toBe(false);
    });

    it("ignores Enter while an IME composition is active", async () => {
      const handles = mountDialog();
      await typeQuery(handles, "install");

      handles.input().dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      flushSync();

      keydown(handles.input(), { key: "Enter" });
      await settle();
      expect(navigations).toHaveLength(0);

      handles.input().dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
      flushSync();

      keydown(handles.input(), { key: "Enter" });
      await settle();
      expect(navigations).toHaveLength(1);
    });

    it("also ignores Enter reported as isComposing", async () => {
      const handles = mountDialog();
      await typeQuery(handles, "install");

      keydown(handles.input(), { key: "Enter", isComposing: true } as KeyboardEventInit);
      await settle();
      expect(navigations).toHaveLength(0);
    });

    it("does not hijack Enter pressed on a dialog button", async () => {
      const handles = mountDialog();
      await typeQuery(handles, "install");

      const clear = document.querySelector<HTMLButtonElement>(".ss-search__clear")!;
      clear.focus();
      const event = keydown(clear, { key: "Enter" });
      await settle();

      // The browser turns this into a click on the button; the dialog must not
      // have swallowed it to navigate to the active result.
      expect(event.defaultPrevented).toBe(false);
      expect(navigations).toHaveLength(0);
      expect(handles.open.value).toBe(true);
    });

    it("does not hijack Enter pressed on the retry button", async () => {
      failWith();
      const handles = mountDialog();
      await typeQuery(handles, "install");

      const retry = document.querySelector<HTMLButtonElement>(".ss-search__button")!;
      retry.focus();
      const event = keydown(retry, { key: "Enter" });

      expect(event.defaultPrevented).toBe(false);
      expect(navigations).toHaveLength(0);
    });

    it("closes on Escape from anywhere in the dialog", async () => {
      const handles = mountDialog();
      await typeQuery(handles, "install");

      const clear = document.querySelector<HTMLButtonElement>(".ss-search__clear")!;
      clear.focus();
      keydown(clear, { key: "Escape" });

      expect(handles.open.value).toBe(false);
    });

    it("closes on Escape", () => {
      const handles = mountDialog();
      keydown(handles.input(), { key: "Escape" });
      expect(handles.open.value).toBe(false);
    });
  });

  describe("pointer and clear", () => {
    it("navigates when a result is clicked", async () => {
      const handles = mountDialog();
      await typeQuery(handles, "install");

      handles.options()[1]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await settle();

      expect(navigations[0]).toContain("/docs/configuration");
    });

    it("closes on a backdrop click by default", async () => {
      const handles = mountDialog();
      const backdrop = document.querySelector<HTMLElement>(".ss-search__backdrop")!;
      backdrop.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      flushSync();
      expect(handles.open.value).toBe(false);
    });

    it("ignores clicks that merely bubble from the dialog", () => {
      const handles = mountDialog();
      const dialog = document.querySelector<HTMLElement>(".ss-search__dialog")!;
      dialog.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      flushSync();
      expect(handles.open.value).toBe(true);
    });

    it("honours closeOnBackdrop={false}", () => {
      const handles = mountDialog({ closeOnBackdrop: false });
      document
        .querySelector<HTMLElement>(".ss-search__backdrop")!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
      flushSync();
      expect(handles.open.value).toBe(true);
    });

    it("clears the query and refocuses the input", async () => {
      const handles = mountDialog();
      await typeQuery(handles, "install");

      const clear = document.querySelector<HTMLButtonElement>(".ss-search__clear")!;
      clear.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await settle();

      expect(handles.input().value).toBe("");
      expect(document.activeElement).toBe(handles.input());
      expect(handles.open.value).toBe(true);
    });
  });

  describe("result presentation", () => {
    it("shows section title and breadcrumb", async () => {
      const handles = mountDialog();
      await typeQuery(handles, "install");

      const first = handles.options()[0]!;
      expect(first.querySelector(".ss-search__result-section")?.textContent).toBe("Installation");
      expect(first.querySelector(".ss-search__result-breadcrumb")?.textContent).toBe(
        "Docs / Getting Started"
      );
    });

    it("omits the section when it matches the page title", async () => {
      respondWith([makeResult({ title: "Installation", sectionTitle: "Installation" })]);
      const handles = mountDialog();
      await typeQuery(handles, "install");

      expect(document.querySelector(".ss-search__result-section")).toBeNull();
    });

    it("hides metadata when the display props are off", async () => {
      const handles = mountDialog({
        showBreadcrumbs: false,
        showSectionTitle: false,
        showSnippets: false,
      });
      await typeQuery(handles, "install");

      expect(document.querySelector(".ss-search__result-breadcrumb")).toBeNull();
      expect(document.querySelector(".ss-search__result-section")).toBeNull();
      expect(document.querySelector(".ss-search__result-snippet")).toBeNull();
    });

    it("marks retained results against the query that produced them", async () => {
      const handles = mountDialog({ debounce: 30 });
      await typeQuery(handles, "Getting", 60);
      expect(document.querySelector(".ss-search__result-title mark")?.textContent).toBe("Getting");

      // Start a second query but do not let it settle. The previous rows stay on
      // screen; marking them against the new query would highlight text that
      // never matched.
      const input = handles.input();
      input.value = "Configuration";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      flushSync();

      expect(handles.options().length).toBeGreaterThan(0);
      const marks = Array.from(document.querySelectorAll(".ss-search__result-title mark")).map(
        (mark) => mark.textContent
      );
      expect(marks).toContain("Getting");
      expect(marks).not.toContain("Configuration");

      await settle(60);
    });

    it("highlights matches without injecting HTML", async () => {
      const handles = mountDialog();
      await typeQuery(handles, "Getting");

      const mark = document.querySelector(".ss-search__result-title mark");
      expect(mark?.textContent).toBe("Getting");
    });

    it("hides the footer when asked", async () => {
      const handles = mountDialog({ showFooter: false });
      await typeQuery(handles, "install");
      expect(document.querySelector(".ss-search__footer")).toBeNull();
    });

    it("counts results in the footer", async () => {
      const handles = mountDialog();
      await typeQuery(handles, "install");
      expect(document.querySelector(".ss-search__count")?.textContent?.trim()).toBe("3 results");
    });
  });

  describe("states", () => {
    it("starts idle", () => {
      const handles = mountDialog();
      expect(handles.root()?.dataset.state).toBe("idle");
      expect(document.querySelector(".ss-search__state--idle")).not.toBeNull();
    });

    it("reports an empty result set against the query that produced it", async () => {
      respondWith([]);
      const handles = mountDialog();
      await typeQuery(handles, "websocket");

      expect(handles.root()?.dataset.state).toBe("empty");
      expect(document.querySelector(".ss-search__state-title")?.textContent).toContain("websocket");
    });

    it("offers a retry on error", async () => {
      failWith();
      const handles = mountDialog();
      await typeQuery(handles, "install");

      expect(handles.root()?.dataset.state).toBe("error");
      const alert = document.querySelector('[role="alert"]');
      expect(alert?.textContent).toContain("temporarily unavailable");
      expect(fetchMock).toHaveBeenCalledTimes(1);

      respondWith(RESULTS);
      document
        .querySelector<HTMLButtonElement>(".ss-search__button")!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await settle();

      expect(handles.root()?.dataset.state).toBe("success");
      expect(handles.options()).toHaveLength(3);
    });

    it("announces the result count politely", async () => {
      const handles = mountDialog();
      await typeQuery(handles, "install");

      const status = document.querySelector('[role="status"]');
      expect(status?.getAttribute("aria-live")).toBe("polite");
      expect(status?.textContent).toContain("3 results");
    });
  });

  describe("theming", () => {
    it("forwards theme, density, class and style to the root", () => {
      const handles = mountDialog({
        theme: "dark",
        density: "compact",
        class: "docs-search",
        style: "--ss-search-accent: #0f766e",
      });

      const root = handles.root()!;
      expect(root.dataset.theme).toBe("dark");
      expect(root.dataset.density).toBe("compact");
      expect(root.classList.contains("docs-search")).toBe(true);
      expect(root.getAttribute("style")).toContain("--ss-search-accent");
    });

    it("inherits the host theme by default", () => {
      const handles = mountDialog();
      expect(handles.root()?.dataset.theme).toBe("inherit");
    });
  });

  describe("search options", () => {
    it("passes the configured search parameters through", async () => {
      const handles = mountDialog({
        topK: 12,
        pathPrefix: "/docs",
        tags: ["guide"],
        maxSubResults: 2,
        groupBy: "chunk",
      });
      await typeQuery(handles, "install");

      const body = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body));
      expect(body).toMatchObject({
        q: "install",
        topK: 12,
        pathPrefix: "/docs",
        tags: ["guide"],
        maxSubResults: 2,
        groupBy: "chunk",
      });
    });

    it("re-runs the search when the scope prop changes", async () => {
      const prefix = box("/docs");
      const open = box(true);
      const { target } = mountComponent(SearchDialog, {
        get open() {
          return open.value;
        },
        set open(next: boolean) {
          open.value = next;
        },
        debounce: 0,
        get pathPrefix() {
          return prefix.value;
        },
      });

      const input = target.querySelector<HTMLInputElement>(".ss-search__input")!;
      input.value = "install";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      flushSync();
      await settle();
      expect(fetchMock).toHaveBeenCalledTimes(1);

      prefix.value = "/blog";
      flushSync();
      await settle();

      expect(fetchMock).toHaveBeenCalledTimes(2);
      const body = JSON.parse(String(fetchMock.mock.calls[1]![1]!.body));
      expect(body.pathPrefix).toBe("/blog");
    });

    it("lets onSelect cancel navigation", async () => {
      const onSelect = vi.fn(() => false);
      const handles = mountDialog({ onSelect });
      await typeQuery(handles, "install");

      keydown(handles.input(), { key: "Enter" });
      await settle();

      expect(onSelect).toHaveBeenCalledTimes(1);
      expect(navigations).toHaveLength(0);
      expect(handles.open.value).toBe(true);
    });

    it("reports a navigation failure instead of leaking a rejection", async () => {
      const onSelectError = vi.fn();
      const navigate = vi.fn().mockRejectedValue(new Error("route missing"));
      const handles = mountDialog({ navigate, onSelectError });
      await typeQuery(handles, "install");

      keydown(handles.input(), { key: "Enter" });
      await settle();

      expect(onSelectError).toHaveBeenCalledTimes(1);
      expect((onSelectError.mock.calls[0]![0] as Error).message).toBe("route missing");
    });

    it("navigates once even if activated repeatedly while onSelect is pending", async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const onSelect = vi.fn(() => gate);
      const handles = mountDialog({ onSelect });
      await typeQuery(handles, "install");

      keydown(handles.input(), { key: "Enter" });
      keydown(handles.input(), { key: "Enter" });
      keydown(handles.input(), { key: "Enter" });

      release();
      await settle();

      expect(onSelect).toHaveBeenCalledTimes(1);
      expect(navigations).toHaveLength(1);
    });

    it("uses a custom navigate callback", async () => {
      const navigate = vi.fn();
      const handles = mountDialog({ navigate });
      await typeQuery(handles, "install");

      keydown(handles.input(), { key: "Enter" });
      await settle();

      expect(navigate).toHaveBeenCalledTimes(1);
      expect(String(navigate.mock.calls[0]![0])).toContain("/docs/getting-started");
      expect(navigations).toHaveLength(0);
    });

    it("keeps the query on close unless clearOnClose is set", async () => {
      const handles = mountDialog();
      await typeQuery(handles, "install");

      handles.open.value = false;
      flushSync();
      handles.open.value = true;
      flushSync();

      expect(handles.input().value).toBe("install");
    });

    it("clears the query on close when clearOnClose is set", async () => {
      const handles = mountDialog({ clearOnClose: true });
      await typeQuery(handles, "install");

      handles.open.value = false;
      flushSync();
      handles.open.value = true;
      flushSync();

      expect(handles.input().value).toBe("");
    });
  });
});
