import { describe, expect, it } from "vitest";
import { createDefaultConfig } from "../src/config/defaults";
import { extractFromHtml } from "../src/indexing/extractor";

const config = createDefaultConfig("searchsocket-test");

describe("extractFromHtml", () => {
  it("extracts main content and removes boilerplate/ignored blocks", () => {
    const html = `
      <html>
        <head><title>Doc Title</title></head>
        <body>
          <header>Header Nav</header>
          <main>
            <h1>Doc Title</h1>
            <p>First paragraph.</p>
            <div data-search-ignore>Should not index</div>
            <nav>Inline nav</nav>
            <p>Second paragraph.</p>
            <a href="/docs/next">Next</a>
          </main>
          <footer>Footer</footer>
        </body>
      </html>
    `;

    const extracted = extractFromHtml("/docs/start", html, config);
    expect(extracted).not.toBeNull();
    expect(extracted?.title).toBe("Doc Title");
    expect(extracted?.markdown).toContain("First paragraph");
    expect(extracted?.markdown).toContain("Second paragraph");
    expect(extracted?.markdown).not.toContain("Should not index");
    expect(extracted?.outgoingLinks).toContain("/docs/next");
  });

  it("skips noindex pages", () => {
    const html = `
      <html>
        <head>
          <meta name="robots" content="noindex" />
        </head>
        <body>
          <main><p>Hidden</p></main>
        </body>
      </html>
    `;

    const extracted = extractFromHtml("/hidden", html, config);
    expect(extracted).toBeNull();
  });
});
