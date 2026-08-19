import { describe, it, expect, afterEach } from "vitest";
import SearchResults from "../../src/templates/search-results/SearchResults.svelte";
import { makeResult, mountComponent, unmountAll } from "./helpers/mount";

const RESULTS = [
  makeResult({
    url: "/docs/getting-started",
    title: "Getting Started",
    sectionTitle: "Installation",
    chunks: [
      { sectionTitle: "Installation", snippet: "Install with pnpm", headingPath: [], score: 0.9 },
      { sectionTitle: "Requirements", snippet: "Node 22 or newer", headingPath: [], score: 0.8 },
      { sectionTitle: "Requirements", snippet: "duplicate section", headingPath: [], score: 0.7 },
      { sectionTitle: "Next steps", snippet: "Index your site", headingPath: [], score: 0.6 },
    ],
  }),
  makeResult({ url: "/blog/launch", title: "Launch", sectionTitle: undefined, chunks: [] }),
];

function mountResults(props: Record<string, unknown> = {}) {
  const { target } = mountComponent(SearchResults, { results: RESULTS, query: "install", ...props });
  return {
    root: target.querySelector<HTMLElement>(".ss-search")!,
    target,
  };
}

describe("SearchResults template", () => {
  afterEach(() => {
    unmountAll();
    document.body.innerHTML = "";
  });

  it("renders a link per result with section and breadcrumb", () => {
    const { target } = mountResults();

    const links = target.querySelectorAll(".ss-search__link");
    expect(links).toHaveLength(2);

    const first = links[0]!;
    expect(first.querySelector(".ss-search__result-section")?.textContent).toBe("Installation");
    expect(first.querySelector(".ss-search__result-breadcrumb")?.textContent).toBe(
      "Docs / Getting Started"
    );
    expect(first.getAttribute("href")).toContain("_ssk=Installation");
  });

  it("highlights the query with mark elements", () => {
    const { target } = mountResults({ query: "Getting" });
    expect(target.querySelector(".ss-search__result-title mark")?.textContent).toBe("Getting");
  });

  it("links sub-results to their own scroll-to-text destination", () => {
    const { target } = mountResults();

    const subLinks = Array.from(
      target.querySelectorAll<HTMLAnchorElement>(".ss-search__subresult-link")
    );
    expect(subLinks.map((link) => link.textContent?.trim())).toEqual([
      "Requirements",
      "Next steps",
    ]);
    expect(subLinks[0]!.getAttribute("href")).toContain("_ssk=Requirements");
    expect(subLinks[0]!.getAttribute("href")).toContain("/docs/getting-started");
  });

  it("caps sub-results and can hide them entirely", () => {
    const capped = mountResults({ maxVisibleSubResults: 1 });
    expect(capped.target.querySelectorAll(".ss-search__subresult-link")).toHaveLength(1);

    const hidden = mountResults({ showSubResults: false });
    expect(hidden.target.querySelectorAll(".ss-search__subresult-link")).toHaveLength(0);
  });

  it("respects the display toggles", () => {
    const { target } = mountResults({
      showSnippets: false,
      showBreadcrumbs: false,
      showSectionTitle: false,
    });

    expect(target.querySelector(".ss-search__result-snippet")).toBeNull();
    expect(target.querySelector(".ss-search__result-breadcrumb")).toBeNull();
    expect(target.querySelector(".ss-search__result-section")).toBeNull();
  });

  it("shows a count when asked", () => {
    const { target } = mountResults({ showCount: true });
    expect(target.querySelector(".ss-search__results-count")?.textContent).toContain("2 results");
  });

  it("renders the empty state against the query", () => {
    const { target, root } = mountResults({ results: [], query: "websocket" });
    expect(root.dataset.state).toBe("empty");
    expect(target.querySelector(".ss-search__state-title")?.textContent).toContain("websocket");
  });

  it("renders nothing but the root when idle", () => {
    const { target, root } = mountResults({ results: [], query: "" });
    expect(root.dataset.state).toBe("idle");
    expect(target.querySelector(".ss-search__state")).toBeNull();
  });

  it("renders the loading state without results", () => {
    const { target, root } = mountResults({ results: [], query: "install", loading: true });
    expect(root.dataset.state).toBe("loading");
    expect(target.textContent).toContain("Searching");
  });

  it("renders an alert on error", () => {
    const { target, root } = mountResults({ error: new Error("nope"), results: [] });
    expect(root.dataset.state).toBe("error");
    expect(target.querySelector('[role="alert"]')?.textContent).toContain(
      "temporarily unavailable"
    );
  });

  it("forwards theme, density, variant, class and style", () => {
    const { root } = mountResults({
      theme: "dark",
      density: "compact",
      variant: "cards",
      class: "page-search",
      style: "--ss-search-accent: #0f766e",
    });

    expect(root.dataset.theme).toBe("dark");
    expect(root.dataset.density).toBe("compact");
    expect(root.dataset.variant).toBe("cards");
    expect(root.classList.contains("page-search")).toBe(true);
    expect(root.getAttribute("style")).toContain("--ss-search-accent");
  });

  it("keeps result rows free of nested interactive elements", () => {
    const { target } = mountResults();
    for (const row of Array.from(
      target.querySelectorAll(".ss-search__link .ss-search__result")
    )) {
      expect(row.querySelector("a, button, input")).toBeNull();
    }
  });
});
