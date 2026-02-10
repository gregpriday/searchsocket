import { describe, expect, it } from "vitest";
import { createDefaultConfig } from "../src/config/defaults";
import { extractFromHtml, extractFromMarkdown } from "../src/indexing/extractor";

const config = createDefaultConfig("test");

describe("extractFromHtml - extended", () => {
  it("falls back to body when main element is missing", () => {
    const html = `
      <html>
        <head><title>No Main</title></head>
        <body>
          <p>Body content here.</p>
        </body>
      </html>
    `;

    const extracted = extractFromHtml("/test", html, config);
    expect(extracted).not.toBeNull();
    expect(extracted?.markdown).toContain("Body content here");
  });

  it("removes sidebar and toc selectors", () => {
    const html = `
      <html>
        <head><title>Test</title></head>
        <body>
          <main>
            <p>Main content.</p>
            <div class="sidebar">Sidebar content</div>
            <div class="toc">Table of contents</div>
            <div class="breadcrumbs">Home > Docs</div>
          </main>
        </body>
      </html>
    `;

    const extracted = extractFromHtml("/test", html, config);
    expect(extracted?.markdown).toContain("Main content");
    expect(extracted?.markdown).not.toContain("Sidebar content");
    expect(extracted?.markdown).not.toContain("Table of contents");
    expect(extracted?.markdown).not.toContain("Home > Docs");
  });

  it("skips page with data-search-noindex attribute", () => {
    const html = `
      <html>
        <head><title>Hidden</title></head>
        <body>
          <main data-search-noindex>
            <p>Hidden content.</p>
          </main>
        </body>
      </html>
    `;

    const extracted = extractFromHtml("/hidden", html, config);
    expect(extracted).toBeNull();
  });

  it("returns null for empty content", () => {
    const html = `
      <html>
        <head><title>Empty</title></head>
        <body><main></main></body>
      </html>
    `;

    const extracted = extractFromHtml("/empty", html, config);
    expect(extracted).toBeNull();
  });

  it("normalizes outgoing links", () => {
    const html = `
      <html>
        <head><title>Links</title></head>
        <body>
          <main>
            <p>Content</p>
            <a href="/docs/a">Link A</a>
            <a href="/docs/b/">Link B</a>
            <a href="https://example.com/docs/c">Link C</a>
            <a href="/docs/d?ref=nav#install">Link D</a>
            <a href="guides/e?foo=bar">Link E</a>
            <a href="#anchor">Anchor</a>
            <a href="mailto:test@example.com">Email</a>
          </main>
        </body>
      </html>
    `;

    const extracted = extractFromHtml("/test", html, config);
    expect(extracted?.outgoingLinks).toContain("/docs/a");
    expect(extracted?.outgoingLinks).toContain("/docs/b");
    expect(extracted?.outgoingLinks).toContain("/docs/c");
    expect(extracted?.outgoingLinks).toContain("/docs/d");
    expect(extracted?.outgoingLinks).toContain("/guides/e");
    expect(extracted?.outgoingLinks).not.toContain("/docs/d?ref=nav#install");
    // Should not include anchor or mailto
    expect(extracted?.outgoingLinks).not.toContain("#anchor");
  });

  it("resolves relative outgoing links against the current page path", () => {
    const html = `
      <html>
        <head><title>Docs</title></head>
        <body>
          <main>
            <a href="advanced">Advanced</a>
            <a href="./faq">FAQ</a>
          </main>
        </body>
      </html>
    `;

    const extracted = extractFromHtml("/docs/getting-started", html, config);
    expect(extracted?.outgoingLinks).toContain("/docs/advanced");
    expect(extracted?.outgoingLinks).toContain("/docs/faq");
  });

  it("extracts tags from first path segment", () => {
    const extracted = extractFromHtml(
      "/docs/getting-started",
      '<html><head><title>T</title></head><body><main><p>Content</p></main></body></html>',
      config
    );
    expect(extracted?.tags).toEqual(["docs"]);
  });

  it("preserves code blocks in markdown output", () => {
    const html = `
      <html>
        <head><title>Code</title></head>
        <body>
          <main>
            <pre><code class="language-js">const x = 1;</code></pre>
          </main>
        </body>
      </html>
    `;

    const extracted = extractFromHtml("/code", html, config);
    expect(extracted?.markdown).toContain("const x = 1;");
  });
});

describe("extractFromMarkdown", () => {
  it("returns normalized markdown", () => {
    const extracted = extractFromMarkdown("/docs/test", "# Hello\n\nWorld\n");
    expect(extracted).not.toBeNull();
    expect(extracted?.title).toBe("/docs/test");
    expect(extracted?.markdown).toContain("# Hello");
  });

  it("uses provided title", () => {
    const extracted = extractFromMarkdown("/test", "content", "Custom Title");
    expect(extracted?.title).toBe("Custom Title");
  });

  it("returns null for empty markdown", () => {
    const extracted = extractFromMarkdown("/test", "   ");
    expect(extracted).toBeNull();
  });

  it("does not treat noindex comments inside fenced code blocks as page directives", () => {
    const extracted = extractFromMarkdown(
      "/docs/code-sample",
      "```html\n<!-- noindex -->\n```\n\nVisible docs content."
    );
    expect(extracted).not.toBeNull();
    expect(extracted?.markdown).toContain("Visible docs content.");
  });
});
