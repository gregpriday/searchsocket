import { describe, expect, it } from "vitest";
import { createDefaultConfig } from "../src/config/defaults";
import { extractFromHtml, extractFromMarkdown } from "../src/indexing/extractor";

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

  it("prefers og:title over all other title sources", () => {
    const html = `
      <html>
        <head>
          <title>Introducing Canopy - Canopy Blog</title>
          <meta property="og:title" content="Introducing Canopy" />
          <meta name="twitter:title" content="Introducing Canopy on Twitter" />
        </head>
        <body><main><h1>Introducing Canopy</h1><p>Content</p></main></body>
      </html>
    `;
    const extracted = extractFromHtml("/blog/introducing-canopy", html, config);
    expect(extracted?.title).toBe("Introducing Canopy");
  });

  it("falls back to h1 when og:title is missing", () => {
    const html = `
      <html>
        <head><title>Page Title - My Site</title></head>
        <body><main><h1>Page Title</h1><p>Content</p></main></body>
      </html>
    `;
    const extracted = extractFromHtml("/test", html, config);
    expect(extracted?.title).toBe("Page Title");
  });

  it("falls back to twitter:title when og:title and h1 are missing", () => {
    const html = `
      <html>
        <head>
          <title>Page - My Site</title>
          <meta name="twitter:title" content="Clean Page Title" />
        </head>
        <body><main><p>Content without heading</p></main></body>
      </html>
    `;
    const extracted = extractFromHtml("/test", html, config);
    expect(extracted?.title).toBe("Clean Page Title");
  });

  it("falls back to title tag when og:title, h1, and twitter:title are missing", () => {
    const html = `
      <html>
        <head><title>Page Title</title></head>
        <body><main><p>Content</p></main></body>
      </html>
    `;
    const extracted = extractFromHtml("/test", html, config);
    expect(extracted?.title).toBe("Page Title");
  });

  it("extracts meta description", () => {
    const html = `
      <html>
        <head>
          <title>Page</title>
          <meta name="description" content="A great page about things." />
        </head>
        <body><main><p>Content</p></main></body>
      </html>
    `;
    const extracted = extractFromHtml("/test", html, config);
    expect(extracted?.description).toBe("A great page about things.");
  });

  it("falls back to og:description", () => {
    const html = `
      <html>
        <head>
          <title>Page</title>
          <meta property="og:description" content="OG description here." />
        </head>
        <body><main><p>Content</p></main></body>
      </html>
    `;
    const extracted = extractFromHtml("/test", html, config);
    expect(extracted?.description).toBe("OG description here.");
  });

  it("prefers meta description over og:description", () => {
    const html = `
      <html>
        <head>
          <title>Page</title>
          <meta name="description" content="Meta desc." />
          <meta property="og:description" content="OG desc." />
        </head>
        <body><main><p>Content</p></main></body>
      </html>
    `;
    const extracted = extractFromHtml("/test", html, config);
    expect(extracted?.description).toBe("Meta desc.");
  });

  it("extracts and splits meta keywords", () => {
    const html = `
      <html>
        <head>
          <title>Page</title>
          <meta name="keywords" content="security, authentication, OWASP" />
        </head>
        <body><main><p>Content</p></main></body>
      </html>
    `;
    const extracted = extractFromHtml("/test", html, config);
    expect(extracted?.keywords).toEqual(["security", "authentication", "OWASP"]);
  });

  it("returns undefined for missing description and keywords", () => {
    const html = `
      <html>
        <head><title>Page</title></head>
        <body><main><p>Content</p></main></body>
      </html>
    `;
    const extracted = extractFromHtml("/test", html, config);
    expect(extracted?.description).toBeUndefined();
    expect(extracted?.keywords).toBeUndefined();
  });
});

describe("extractFromMarkdown description/keywords", () => {
  it("extracts description from frontmatter", () => {
    const md = `---
title: Test
description: A markdown page description.
---

# Hello

Content here.`;
    const extracted = extractFromMarkdown("/test", md);
    expect(extracted?.description).toBe("A markdown page description.");
  });

  it("extracts keywords array from frontmatter", () => {
    const md = `---
title: Test
keywords:
  - auth
  - security
---

Content.`;
    const extracted = extractFromMarkdown("/test", md);
    expect(extracted?.keywords).toEqual(["auth", "security"]);
  });

  it("extracts keywords comma-separated string from frontmatter", () => {
    const md = `---
title: Test
keywords: auth, security, OWASP
---

Content.`;
    const extracted = extractFromMarkdown("/test", md);
    expect(extracted?.keywords).toEqual(["auth", "security", "OWASP"]);
  });

  it("returns undefined for missing frontmatter fields", () => {
    const md = `---
title: Test
---

Content.`;
    const extracted = extractFromMarkdown("/test", md);
    expect(extracted?.description).toBeUndefined();
    expect(extracted?.keywords).toBeUndefined();
  });
});
