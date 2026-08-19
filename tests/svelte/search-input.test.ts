import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { flushSync } from "svelte";
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
  makeResult({ url: "/docs/configuration", title: "Configuration" }),
];

interface InputHandles {
  open: { value: boolean };
  value: { value: string };
  root: HTMLElement;
  input: () => HTMLInputElement;
  popup: () => HTMLElement | null;
  options: () => HTMLLIElement[];
}

function mountInput(extra: Record<string, unknown> = {}): InputHandles {
  const open = box(false);
  const value = box("");
  const { target } = mountComponent(SearchInput, {
    get open() {
      return open.value;
    },
    set open(next: boolean) {
      open.value = next;
    },
    get value() {
      return value.value;
    },
    set value(next: string) {
      value.value = next;
    },
    debounce: 0,
    ...extra,
  });

  return {
    open,
    value,
    root: target.querySelector<HTMLElement>(".ss-search")!,
    input: () => target.querySelector<HTMLInputElement>(".ss-search__input")!,
    popup: () => target.querySelector<HTMLElement>(".ss-search__popup"),
    options: () => Array.from(target.querySelectorAll<HTMLLIElement>(".ss-search__option")),
  };
}

async function typeQuery(handles: InputHandles, query: string): Promise<void> {
  const input = handles.input();
  input.focus();
  input.value = query;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  flushSync();
  await settle();
}

function focusOut(root: HTMLElement, relatedTarget: EventTarget | null): void {
  // jsdom's FocusEvent constructor accepts relatedTarget, but the property is
  // read-only afterwards — it has to be set at construction time.
  root.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget }));
  flushSync();
}

describe("SearchInput template", () => {
  beforeEach(() => {
    resetNavigations();
    installFetchStub();
    respondWith(RESULTS);
  });

  afterEach(() => {
    unmountAll();
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  describe("popup visibility", () => {
    it("stays closed while the query is empty", () => {
      const handles = mountInput();
      handles.input().focus();
      handles.input().dispatchEvent(new FocusEvent("focus"));
      flushSync();

      expect(handles.popup()).toBeNull();
      expect(handles.input().getAttribute("aria-expanded")).toBe("false");
    });

    it("opens on focus with a query and reports aria-expanded", async () => {
      const handles = mountInput();
      await typeQuery(handles, "install");

      expect(handles.popup()).not.toBeNull();
      expect(handles.input().getAttribute("aria-expanded")).toBe("true");
      expect(handles.options()).toHaveLength(2);
    });

    it("stays expanded for the empty-result popup", async () => {
      respondWith([]);
      const handles = mountInput();
      await typeQuery(handles, "websocket");

      expect(handles.popup()).not.toBeNull();
      expect(handles.input().getAttribute("aria-expanded")).toBe("true");
      expect(handles.popup()?.textContent).toContain("No results for");
    });

    it("stays expanded while results are still loading", async () => {
      const handles = mountInput({ debounce: 40 });
      const input = handles.input();
      input.focus();
      input.value = "install";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      flushSync();

      // Mid-debounce: nothing has arrived yet, but the popup is on screen.
      expect(handles.popup()).not.toBeNull();
      expect(input.getAttribute("aria-expanded")).toBe("true");
      expect(handles.popup()?.textContent).toContain("Searching");

      await settle(80);
    });

    it("stays expanded for the error popup", async () => {
      failWith();
      const handles = mountInput();
      await typeQuery(handles, "install");

      expect(handles.input().getAttribute("aria-expanded")).toBe("true");
      expect(handles.popup()?.querySelector('[role="alert"]')).not.toBeNull();
    });

    it("points aria-controls at the popup listbox", async () => {
      const handles = mountInput();
      await typeQuery(handles, "install");

      const listboxId = handles.input().getAttribute("aria-controls")!;
      expect(document.getElementById(listboxId)?.getAttribute("role")).toBe("listbox");
    });

    it("honours the placement prop", async () => {
      const handles = mountInput({ placement: "bottom-end" });
      await typeQuery(handles, "install");
      expect(handles.popup()?.dataset.placement).toBe("bottom-end");
    });
  });

  describe("identity", () => {
    it("keeps ids unique across instances", async () => {
      const a = mountInput();
      const b = mountInput();
      expect(a.input().id).toBeTruthy();
      expect(a.input().id).not.toBe(b.input().id);

      // Capture each while it holds focus — focusing the second closes the
      // first's popup, which correctly drops its aria-controls.
      await typeQuery(a, "install");
      const controlsA = a.input().getAttribute("aria-controls");

      await typeQuery(b, "install");
      const controlsB = b.input().getAttribute("aria-controls");

      expect(controlsA).toBeTruthy();
      expect(controlsB).toBeTruthy();
      expect(controlsA).not.toBe(controlsB);
    });

    it("drops dangling ARIA references while the popup is closed", async () => {
      const handles = mountInput();
      await typeQuery(handles, "install");
      expect(handles.input().getAttribute("aria-controls")).toBeTruthy();

      keydown(handles.input(), { key: "Escape" });

      // There is no listbox in the DOM now, so neither reference may resolve.
      expect(handles.input().getAttribute("aria-controls")).toBeNull();
      expect(handles.input().getAttribute("aria-activedescendant")).toBeNull();
    });

    it("does not open a blank popup below minQueryLength", async () => {
      const handles = mountInput({ minQueryLength: 3 });
      await typeQuery(handles, "ab");

      expect(handles.popup()).toBeNull();
      expect(handles.input().getAttribute("aria-expanded")).toBe("false");

      await typeQuery(handles, "abc");
      expect(handles.popup()).not.toBeNull();
    });

    it("reopens a closed popup with ArrowUp as well as ArrowDown", async () => {
      const handles = mountInput();
      await typeQuery(handles, "install");
      keydown(handles.input(), { key: "Escape" });
      expect(handles.popup()).toBeNull();

      keydown(handles.input(), { key: "ArrowUp" });
      expect(handles.popup()).not.toBeNull();
    });

    it("labels the input", () => {
      const handles = mountInput({ label: "Search the docs" });
      const label = document.querySelector(`label[for="${handles.input().id}"]`);
      expect(label?.textContent?.trim()).toBe("Search the docs");
    });
  });

  describe("selection", () => {
    it("keeps focus in the input on pointerdown, then selects on click", async () => {
      const handles = mountInput();
      await typeQuery(handles, "install");

      const option = handles.options()[1]!;
      const down = new PointerEvent("pointerdown", {
        bubbles: true,
        cancelable: true,
        button: 0,
        pointerType: "mouse",
      });
      option.dispatchEvent(down);

      // The prevented default is what stops focusout from closing the popup
      // before the click lands — selection has not happened yet.
      expect(down.defaultPrevented).toBe(true);
      expect(navigations).toHaveLength(0);

      option.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
      await settle();

      expect(navigations[0]).toContain("/docs/configuration");
      expect(handles.open.value).toBe(false);
    });

    it("does not navigate on a secondary-button press", async () => {
      const handles = mountInput();
      await typeQuery(handles, "install");

      const option = handles.options()[0]!;
      const down = new PointerEvent("pointerdown", {
        bubbles: true,
        cancelable: true,
        button: 2,
        pointerType: "mouse",
      });
      option.dispatchEvent(down);
      option.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 2 }));
      await settle();

      expect(down.defaultPrevented).toBe(false);
      expect(navigations).toHaveLength(0);
    });

    it("lets a touch drag scroll instead of navigating on contact", async () => {
      const handles = mountInput();
      await typeQuery(handles, "install");

      const down = new PointerEvent("pointerdown", {
        bubbles: true,
        cancelable: true,
        button: 0,
        pointerType: "touch",
      });
      handles.options()[0]!.dispatchEvent(down);
      await settle();

      expect(down.defaultPrevented).toBe(false);
      expect(navigations).toHaveLength(0);
    });

    it("navigates on Enter and clears the field", async () => {
      const handles = mountInput();
      await typeQuery(handles, "install");

      keydown(handles.input(), { key: "Enter" });
      await settle();

      expect(navigations).toHaveLength(1);
      expect(handles.value.value).toBe("");
    });

    it("keeps the query when clearOnNavigate is off", async () => {
      const handles = mountInput({ clearOnNavigate: false });
      await typeQuery(handles, "install");

      keydown(handles.input(), { key: "Enter" });
      await settle();

      expect(handles.value.value).toBe("install");
    });

    it("ignores Enter during composition", async () => {
      const handles = mountInput();
      await typeQuery(handles, "install");

      handles.input().dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      flushSync();
      keydown(handles.input(), { key: "Enter" });
      await settle();

      expect(navigations).toHaveLength(0);
    });
  });

  describe("keyboard", () => {
    it("moves through results with the arrow keys", async () => {
      const handles = mountInput();
      await typeQuery(handles, "install");

      expect(handles.options()[0]!.dataset.active).toBe("true");

      keydown(handles.input(), { key: "ArrowDown" });
      expect(handles.options()[1]!.dataset.active).toBe("true");

      keydown(handles.input(), { key: "End" });
      expect(handles.options()[1]!.dataset.active).toBe("true");

      keydown(handles.input(), { key: "Home" });
      expect(handles.options()[0]!.dataset.active).toBe("true");
    });

    it("reopens a closed popup with ArrowDown", async () => {
      const handles = mountInput();
      await typeQuery(handles, "install");

      keydown(handles.input(), { key: "Escape" });
      expect(handles.popup()).toBeNull();

      keydown(handles.input(), { key: "ArrowDown" });
      expect(handles.popup()).not.toBeNull();
    });

    it("closes on the first Escape but keeps query and focus", async () => {
      const handles = mountInput();
      await typeQuery(handles, "install");
      expect(document.activeElement).toBe(handles.input());

      keydown(handles.input(), { key: "Escape" });

      expect(handles.popup()).toBeNull();
      expect(handles.value.value).toBe("install");
      expect(document.activeElement).toBe(handles.input());
    });

    it("clears the query on a second Escape", async () => {
      const handles = mountInput();
      await typeQuery(handles, "install");

      keydown(handles.input(), { key: "Escape" });
      keydown(handles.input(), { key: "Escape" });
      await settle();

      expect(handles.value.value).toBe("");
      expect(document.activeElement).toBe(handles.input());
    });
  });

  describe("focus out", () => {
    it("closes when focus moves outside the component", async () => {
      const outside = document.createElement("button");
      document.body.appendChild(outside);

      const handles = mountInput();
      await typeQuery(handles, "install");

      focusOut(handles.root, outside);

      expect(handles.open.value).toBe(false);
    });

    it("stays open when focus moves within the component", async () => {
      const handles = mountInput();
      await typeQuery(handles, "install");

      const clear = document.querySelector<HTMLButtonElement>(".ss-search__clear")!;
      focusOut(handles.root, clear);

      expect(handles.open.value).toBe(true);
    });
  });

  describe("binding and theming", () => {
    it("renders a seeded value on first paint, not only after an effect", () => {
      const { target } = mountComponent(SearchInput, { value: "deployment", debounce: 0 });
      expect(target.querySelector<HTMLInputElement>(".ss-search__input")!.value).toBe(
        "deployment"
      );
    });

    it("accepts an externally set value", async () => {
      const handles = mountInput();
      handles.value.value = "deployment";
      flushSync();
      await settle();

      expect(handles.input().value).toBe("deployment");
    });

    it("clears through the clear button", async () => {
      const handles = mountInput();
      await typeQuery(handles, "install");

      document
        .querySelector<HTMLButtonElement>(".ss-search__clear")!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await settle();

      expect(handles.value.value).toBe("");
      expect(document.activeElement).toBe(handles.input());
    });

    it("forwards theme, density, class and style", () => {
      const handles = mountInput({
        theme: "light",
        density: "compact",
        class: "nav-search",
        style: "--ss-search-radius: 4px",
      });

      expect(handles.root.dataset.theme).toBe("light");
      expect(handles.root.dataset.density).toBe("compact");
      expect(handles.root.classList.contains("nav-search")).toBe(true);
      expect(handles.root.getAttribute("style")).toContain("--ss-search-radius");
    });
  });
});
