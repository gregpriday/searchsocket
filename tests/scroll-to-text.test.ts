// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { searchsocketScrollToText } from "../src/sveltekit/scroll-to-text";
import type { AfterNavigateParam } from "../src/sveltekit/scroll-to-text";

function makeNavigation(searchParams?: Record<string, string>): AfterNavigateParam {
  const url = new URL("http://localhost/page");
  if (searchParams) {
    for (const [key, value] of Object.entries(searchParams)) {
      url.searchParams.set(key, value);
    }
  }
  return { to: { url } };
}

function makeHeading(tag: string, text: string): HTMLElement {
  const el = document.createElement(tag);
  el.textContent = text;
  el.scrollIntoView = vi.fn();
  return el;
}

describe("searchsocketScrollToText", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("is a no-op when navigation.to is null", () => {
    // Should not throw
    searchsocketScrollToText({ to: null });
  });

  it("is a no-op when _ss param is absent", () => {
    searchsocketScrollToText(makeNavigation());
    // Nothing to assert, just ensure no error
  });

  it("is a no-op when _ss param is empty string", () => {
    searchsocketScrollToText(makeNavigation({ _ss: "" }));
  });

  it("is a no-op when _ss param is whitespace only", () => {
    const h1 = makeHeading("h1", "Should Not Scroll");
    document.body.appendChild(h1);

    searchsocketScrollToText(makeNavigation({ _ss: "   " }));

    expect(h1.scrollIntoView).not.toHaveBeenCalled();
  });

  it("scrolls to an exact heading match", () => {
    const h2 = makeHeading("h2", "Installation");
    document.body.appendChild(makeHeading("h1", "Docs"));
    document.body.appendChild(h2);

    searchsocketScrollToText(makeNavigation({ _ss: "Installation" }));

    expect(h2.scrollIntoView).toHaveBeenCalledWith({
      behavior: "smooth",
      block: "start"
    });
  });

  it("matches case-insensitively", () => {
    const h3 = makeHeading("h3", "Quick Start Guide");
    document.body.appendChild(h3);

    searchsocketScrollToText(makeNavigation({ _ss: "quick start guide" }));

    expect(h3.scrollIntoView).toHaveBeenCalled();
  });

  it("matches when heading contains the section title (partial match)", () => {
    const h2 = makeHeading("h2", "1. Installation Steps");
    document.body.appendChild(h2);

    searchsocketScrollToText(makeNavigation({ _ss: "Installation Steps" }));

    expect(h2.scrollIntoView).toHaveBeenCalled();
  });

  it("scrolls to the first matching heading when multiple match", () => {
    const h2a = makeHeading("h2", "Setup");
    const h2b = makeHeading("h2", "Setup");
    document.body.appendChild(h2a);
    document.body.appendChild(h2b);

    searchsocketScrollToText(makeNavigation({ _ss: "Setup" }));

    expect(h2a.scrollIntoView).toHaveBeenCalled();
    expect(h2b.scrollIntoView).not.toHaveBeenCalled();
  });

  it("normalizes whitespace when matching", () => {
    const h2 = makeHeading("h2", "Getting   Started");
    document.body.appendChild(h2);

    searchsocketScrollToText(makeNavigation({ _ss: "Getting Started" }));

    expect(h2.scrollIntoView).toHaveBeenCalled();
  });

  it("falls back to text node search when no heading matches", () => {
    const p = document.createElement("p");
    p.textContent = "This paragraph mentions the Installation process.";
    p.scrollIntoView = vi.fn();
    document.body.appendChild(p);

    searchsocketScrollToText(makeNavigation({ _ss: "Installation" }));

    expect(p.scrollIntoView).toHaveBeenCalledWith({
      behavior: "smooth",
      block: "start"
    });
  });

  it("does nothing when no match at all", () => {
    document.body.appendChild(makeHeading("h1", "Unrelated Title"));

    // Should not throw
    searchsocketScrollToText(makeNavigation({ _ss: "Nonexistent Section" }));
  });

  it("handles all heading levels (h1-h6)", () => {
    for (const level of [1, 2, 3, 4, 5, 6]) {
      document.body.innerHTML = "";
      const heading = makeHeading(`h${level}`, "Target Heading");
      document.body.appendChild(heading);

      searchsocketScrollToText(makeNavigation({ _ss: "Target Heading" }));

      expect(heading.scrollIntoView).toHaveBeenCalled();
    }
  });

  it("ignores text inside script and style elements", () => {
    const script = document.createElement("script");
    script.textContent = "const installation = true;";
    document.body.appendChild(script);

    const style = document.createElement("style");
    style.textContent = ".installation { color: red; }";
    document.body.appendChild(style);

    // Should not scroll to script/style content
    searchsocketScrollToText(makeNavigation({ _ss: "installation" }));
    // No error, no scroll — just a silent no-op
  });

  it("prefers heading match over text node match", () => {
    const p = document.createElement("p");
    p.textContent = "Configuration details here";
    p.scrollIntoView = vi.fn();
    document.body.appendChild(p);

    const h2 = makeHeading("h2", "Configuration");
    document.body.appendChild(h2);

    searchsocketScrollToText(makeNavigation({ _ss: "Configuration" }));

    // h2 should be scrolled to, not the paragraph
    expect(h2.scrollIntoView).toHaveBeenCalled();
    expect(p.scrollIntoView).not.toHaveBeenCalled();
  });
});
