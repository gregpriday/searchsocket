// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
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
    searchsocketScrollToText({ to: null });
  });

  it("is a no-op when no scroll params are present", () => {
    searchsocketScrollToText(makeNavigation());
  });

  it("is a no-op when _sskt is whitespace only", () => {
    const h1 = makeHeading("h1", "Should Not Scroll");
    document.body.appendChild(h1);

    searchsocketScrollToText(makeNavigation({ _sskt: "   " }));

    expect(h1.scrollIntoView).not.toHaveBeenCalled();
  });

  it("scrolls to an exact heading text match via _ssk", () => {
    const h2 = makeHeading("h2", "Installation");
    document.body.appendChild(makeHeading("h1", "Docs"));
    document.body.appendChild(h2);

    searchsocketScrollToText(makeNavigation({ _ssk: "Installation" }));

    expect(h2.scrollIntoView).toHaveBeenCalledWith({
      behavior: "smooth",
      block: "start"
    });
  });

  it("matches case-insensitively", () => {
    const h3 = makeHeading("h3", "Quick Start Guide");
    document.body.appendChild(h3);

    searchsocketScrollToText(makeNavigation({ _ssk: "quick start guide" }));

    expect(h3.scrollIntoView).toHaveBeenCalled();
  });

  it("normalizes whitespace when matching", () => {
    const h2 = makeHeading("h2", "Getting   Started");
    document.body.appendChild(h2);

    searchsocketScrollToText(makeNavigation({ _ssk: "Getting Started" }));

    expect(h2.scrollIntoView).toHaveBeenCalled();
  });

  it("finds a body text match and highlights the relevant substring", () => {
    const p = document.createElement("p");
    p.textContent = "This paragraph mentions the Installation process for local development.";
    p.scrollIntoView = vi.fn();
    document.body.appendChild(p);

    searchsocketScrollToText(makeNavigation({ _sskt: "Installation process" }));

    expect(p.scrollIntoView).toHaveBeenCalledWith({
      behavior: "smooth",
      block: "start"
    });

    const marker = p.querySelector(".ssk-highlight");
    expect(marker).not.toBeNull();
    expect(marker?.textContent?.toLowerCase()).toContain("installation process");
  });

  it("prefers _sskt over _ssk when both are present", () => {
    const h2 = makeHeading("h2", "Configuration");
    document.body.appendChild(h2);

    const p = document.createElement("p");
    p.textContent = "Install SearchSocket with pnpm add searchsocket.";
    p.scrollIntoView = vi.fn();
    document.body.appendChild(p);

    searchsocketScrollToText(
      makeNavigation({
        _ssk: "Configuration",
        _sskt: "pnpm add searchsocket"
      })
    );

    expect(p.scrollIntoView).toHaveBeenCalled();
    expect(h2.scrollIntoView).not.toHaveBeenCalled();
  });

  it("does nothing when no match exists", () => {
    const h1 = makeHeading("h1", "Unrelated Title");
    document.body.appendChild(h1);

    searchsocketScrollToText(makeNavigation({ _sskt: "Nonexistent Section" }));

    expect(h1.scrollIntoView).not.toHaveBeenCalled();
  });

  it("handles all heading levels (h1-h6)", () => {
    for (const level of [1, 2, 3, 4, 5, 6]) {
      document.body.innerHTML = "";
      const heading = makeHeading(`h${level}`, "Target Heading");
      document.body.appendChild(heading);

      searchsocketScrollToText(makeNavigation({ _ssk: "Target Heading" }));

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

    const h2 = makeHeading("h2", "Visible heading");
    document.body.appendChild(h2);

    searchsocketScrollToText(makeNavigation({ _sskt: "installation" }));

    expect(h2.scrollIntoView).not.toHaveBeenCalled();
  });

  // --- Cross-node matching tests ---

  it("matches text that spans across child elements", () => {
    const p = document.createElement("p");
    p.scrollIntoView = vi.fn();
    p.appendChild(document.createTextNode("Install "));
    const strong = document.createElement("strong");
    strong.textContent = "SearchSocket";
    p.appendChild(strong);
    p.appendChild(document.createTextNode(" with pnpm"));
    document.body.appendChild(p);

    searchsocketScrollToText(makeNavigation({ _sskt: "Install SearchSocket" }));

    expect(p.scrollIntoView).toHaveBeenCalled();
    // Cross-node: either a highlight span or the ancestor element is highlighted
    const hasHighlight =
      p.querySelector(".ssk-highlight") !== null || p.classList.contains("ssk-highlight");
    expect(hasHighlight).toBe(true);
  });

  it("matches text split across multiple inline elements", () => {
    const p = document.createElement("p");
    p.scrollIntoView = vi.fn();

    const em = document.createElement("em");
    em.textContent = "Getting";
    p.appendChild(em);
    p.appendChild(document.createTextNode(" "));
    const strong = document.createElement("strong");
    strong.textContent = "Started";
    p.appendChild(strong);
    p.appendChild(document.createTextNode(" guide"));
    document.body.appendChild(p);

    searchsocketScrollToText(makeNavigation({ _sskt: "Getting Started" }));

    expect(p.scrollIntoView).toHaveBeenCalled();
  });

  it("matches adjacent elements with no whitespace separator via lenient fallback", () => {
    const p = document.createElement("p");
    p.scrollIntoView = vi.fn();

    const span1 = document.createElement("span");
    span1.textContent = "Deploy";
    p.appendChild(span1);
    const span2 = document.createElement("span");
    span2.textContent = "SearchSocket";
    p.appendChild(span2);
    document.body.appendChild(p);

    searchsocketScrollToText(makeNavigation({ _sskt: "Deploy SearchSocket" }));

    expect(p.scrollIntoView).toHaveBeenCalled();
  });

  it("handles deeply nested text nodes", () => {
    const div = document.createElement("div");
    div.scrollIntoView = vi.fn();

    const p = document.createElement("p");
    const span = document.createElement("span");
    const em = document.createElement("em");
    em.textContent = "deeply nested target";
    span.appendChild(em);
    p.appendChild(span);
    div.appendChild(p);
    document.body.appendChild(div);

    searchsocketScrollToText(makeNavigation({ _sskt: "deeply nested target" }));

    // The match is within a single text node inside <em>, so surroundContents works
    const marker = div.querySelector(".ssk-highlight");
    expect(marker).not.toBeNull();
    expect(marker?.textContent?.toLowerCase()).toContain("deeply nested target");
  });
});
