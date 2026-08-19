import { describe, it, expect, afterEach } from "vitest";
import {
  chunkAsResult,
  focusableWithin,
  highlightParts,
  lockBodyScroll,
  matchesShortcut,
  normalizeQuery,
  optionId,
  resultSectionLabel,
  subResultsFor,
  urlToBreadcrumb,
  wrapIndex,
} from "../../src/templates/_shared/search-ui";
import type { SearchResult } from "../../src/types";

function result(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    url: "/docs/getting-started",
    title: "Getting Started",
    snippet: "snippet",
    score: 0.5,
    ...overrides,
  };
}

describe("highlightParts", () => {
  it("marks each query term", () => {
    expect(highlightParts("Deploy the deployment guide", "deploy")).toEqual([
      { text: "Deploy", match: true },
      { text: " the ", match: false },
      { text: "deploy", match: true },
      { text: "ment guide", match: false },
    ]);
  });

  it("handles multiple terms", () => {
    const parts = highlightParts("install with pnpm", "install pnpm");
    expect(parts.filter((part) => part.match).map((part) => part.text)).toEqual([
      "install",
      "pnpm",
    ]);
  });

  it("treats regex metacharacters literally", () => {
    expect(() => highlightParts("a (b) c", "(b)")).not.toThrow();
    const parts = highlightParts("a (b) c", "(b)");
    expect(parts.some((part) => part.match && part.text === "(b)")).toBe(true);
  });

  it("returns the whole string for a blank query", () => {
    expect(highlightParts("anything", "   ")).toEqual([{ text: "anything", match: false }]);
  });
});

describe("normalizeQuery", () => {
  it("trims and collapses whitespace", () => {
    expect(normalizeQuery("  deploy   guide ")).toBe("deploy guide");
  });
});

describe("urlToBreadcrumb", () => {
  it("humanizes path segments", () => {
    expect(urlToBreadcrumb("/docs/getting-started")).toBe("Docs / Getting Started");
  });

  it("strips query strings, hashes and extensions", () => {
    expect(urlToBreadcrumb("/docs/deploy.html?x=1#frag")).toBe("Docs / Deploy");
  });

  it("drops index segments", () => {
    expect(urlToBreadcrumb("/docs/index")).toBe("Docs");
  });

  it("returns an empty string for the site root", () => {
    expect(urlToBreadcrumb("/")).toBe("");
    expect(urlToBreadcrumb("https://example.com")).toBe("");
  });

  it("uses only the path of an absolute URL", () => {
    // Without this, the scheme and host become breadcrumb segments:
    // "Https: / Example.com / Docs".
    expect(urlToBreadcrumb("https://example.com/docs/getting-started")).toBe(
      "Docs / Getting Started"
    );
  });

  it("decodes escaped segments and survives malformed ones", () => {
    expect(urlToBreadcrumb("/docs/getting%20started")).toBe("Docs / Getting Started");
    expect(() => urlToBreadcrumb("/docs/%E0%A4%A")).not.toThrow();
  });
});

describe("resultSectionLabel", () => {
  it("returns the section when it adds information", () => {
    expect(resultSectionLabel({ title: "Getting Started", sectionTitle: "Installation" })).toBe(
      "Installation"
    );
  });

  it("returns null when the section repeats the title", () => {
    expect(resultSectionLabel({ title: "Install", sectionTitle: " install " })).toBeNull();
  });

  it("returns null when there is no section", () => {
    expect(resultSectionLabel({ title: "Install" })).toBeNull();
  });
});

describe("subResultsFor", () => {
  const base = result({
    title: "Getting Started",
    sectionTitle: "Installation",
    chunks: [
      { sectionTitle: "Installation", snippet: "a", headingPath: [], score: 0.9 },
      { sectionTitle: "Getting Started", snippet: "b", headingPath: [], score: 0.8 },
      { sectionTitle: "Requirements", snippet: "c", headingPath: [], score: 0.7 },
      { sectionTitle: "requirements", snippet: "d", headingPath: [], score: 0.6 },
      { snippet: "e", headingPath: [], score: 0.5 },
      { sectionTitle: "Next steps", snippet: "f", headingPath: [], score: 0.4 },
    ],
  });

  it("skips the page title, the shown section, duplicates and untitled chunks", () => {
    expect(subResultsFor(base).map((chunk) => chunk.sectionTitle)).toEqual([
      "Requirements",
      "Next steps",
    ]);
  });

  it("respects the cap", () => {
    expect(subResultsFor(base, 1)).toHaveLength(1);
    expect(subResultsFor(base, 0)).toHaveLength(0);
  });

  it("returns nothing when there are no chunks", () => {
    expect(subResultsFor(result())).toEqual([]);
  });
});

describe("chunkAsResult", () => {
  it("retargets the result at the chunk without carrying nested chunks", () => {
    const chunk = { sectionTitle: "Requirements", snippet: "Node 22", headingPath: [], score: 0.7 };
    const retargeted = chunkAsResult(result({ chunks: [chunk] }), chunk);

    expect(retargeted.sectionTitle).toBe("Requirements");
    expect(retargeted.snippet).toBe("Node 22");
    expect(retargeted.chunks).toBeUndefined();
    expect(retargeted.url).toBe("/docs/getting-started");
  });
});

describe("matchesShortcut", () => {
  const event = (init: KeyboardEventInit & { target?: EventTarget }): KeyboardEvent => {
    const created = new KeyboardEvent("keydown", init);
    if (init.target) Object.defineProperty(created, "target", { value: init.target });
    return created;
  };

  it("accepts either modifier for mod", () => {
    expect(matchesShortcut(event({ key: "k", metaKey: true }), "mod+k")).toBe(true);
    expect(matchesShortcut(event({ key: "K", ctrlKey: true }), "mod+k")).toBe(true);
    expect(matchesShortcut(event({ key: "k" }), "mod+k")).toBe(false);
  });

  it("distinguishes ctrl from meta when named explicitly", () => {
    expect(matchesShortcut(event({ key: "k", ctrlKey: true }), "ctrl+k")).toBe(true);
    expect(matchesShortcut(event({ key: "k", metaKey: true }), "ctrl+k")).toBe(false);
  });

  it("requires shift and alt to match exactly", () => {
    expect(matchesShortcut(event({ key: "/", shiftKey: true }), "shift+/")).toBe(true);
    expect(matchesShortcut(event({ key: "/", shiftKey: true }), "/")).toBe(false);
    expect(matchesShortcut(event({ key: "k", metaKey: true, altKey: true }), "mod+k")).toBe(false);
  });

  it("ignores an unmodified shortcut typed into a field", () => {
    const input = document.createElement("input");
    expect(matchesShortcut(event({ key: "/", target: input }), "/")).toBe(false);
    expect(matchesShortcut(event({ key: "/" }), "/")).toBe(true);
  });

  it("rejects a spec with an unknown modifier rather than degrading to the bare key", () => {
    // "cmd" is not a token we understand; treating this as a plain "k" would
    // fire the shortcut on every keystroke of the letter k.
    expect(matchesShortcut(event({ key: "k" }), "cmd+k")).toBe(false);
    expect(matchesShortcut(event({ key: "k", metaKey: true }), "cmd+k")).toBe(false);
  });

  it("rejects degenerate specs", () => {
    for (const spec of ["", "+", "++", "mod+"]) {
      expect(matchesShortcut(event({ key: "k", metaKey: true }), spec), spec).toBe(false);
    }
  });

  it("still fires a modified shortcut from inside a field", () => {
    const input = document.createElement("input");
    expect(matchesShortcut(event({ key: "k", metaKey: true, target: input }), "mod+k")).toBe(true);
  });
});

describe("focusableWithin", () => {
  it("returns focusable descendants in tab order", () => {
    const root = document.createElement("div");
    root.innerHTML = `
      <input id="a" />
      <button id="b"></button>
      <button id="c" disabled></button>
      <span id="d" tabindex="-1"></span>
      <a id="e" href="/x"></a>
    `;
    expect(focusableWithin(root).map((element) => element.id)).toEqual(["a", "b", "e"]);
  });
});

describe("ids", () => {
  it("derives option ids from a base", () => {
    expect(optionId("ss-dialog-1", 3)).toBe("ss-dialog-1-option-3");
  });
});

describe("wrapIndex", () => {
  it("wraps in both directions", () => {
    expect(wrapIndex(3, 3)).toBe(0);
    expect(wrapIndex(-1, 3)).toBe(2);
    expect(wrapIndex(1, 3)).toBe(1);
  });

  it("returns -1 for an empty list", () => {
    expect(wrapIndex(0, 0)).toBe(-1);
  });
});

describe("lockBodyScroll", () => {
  afterEach(() => {
    document.body.removeAttribute("style");
  });

  it("restores the exact previous value, including a priority", () => {
    document.body.style.setProperty("overflow", "auto", "important");

    const release = lockBodyScroll();
    expect(document.body.style.getPropertyValue("overflow")).toBe("hidden");

    release();
    expect(document.body.style.getPropertyValue("overflow")).toBe("auto");
    expect(document.body.style.getPropertyPriority("overflow")).toBe("important");
  });

  it("removes the property entirely when there was none", () => {
    const release = lockBodyScroll();
    release();
    expect(document.body.getAttribute("style") ?? "").not.toContain("overflow");
  });

  it("reference counts, so a second lock does not unlock early", () => {
    document.body.style.overflow = "auto";

    const first = lockBodyScroll();
    const second = lockBodyScroll();
    expect(document.body.style.overflow).toBe("hidden");

    first();
    // A naive save/restore would unlock here while the second holder is active.
    expect(document.body.style.overflow).toBe("hidden");

    second();
    expect(document.body.style.overflow).toBe("auto");
  });

  it("ignores a repeated release", () => {
    document.body.style.overflow = "auto";

    const first = lockBodyScroll();
    const second = lockBodyScroll();
    first();
    first();

    expect(document.body.style.overflow).toBe("hidden");
    second();
    expect(document.body.style.overflow).toBe("auto");
  });
});
