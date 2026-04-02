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

describe("image preprocessing", () => {
  it("replaces img with data-search-description text", () => {
    const html = `<html><body><main><p>Before</p><img src="x.png" data-search-description="Product checkout flow"/><p>After</p></main></body></html>`;
    const extracted = extractFromHtml("/test", html, config);
    expect(extracted?.markdown).toContain("Product checkout flow");
    expect(extracted?.markdown).not.toMatch(/!\[.*\]\(.*\)/);
    expect(extracted?.markdown).not.toContain("x.png");
  });

  it("reads data-search-description from closest figure when not on img", () => {
    const html = `<html><body><main><figure data-search-description="Dashboard overview"><img src="dash.png" alt="screenshot"/></figure></main></body></html>`;
    const extracted = extractFromHtml("/test", html, config);
    expect(extracted?.markdown).toContain("Dashboard overview");
    expect(extracted?.markdown).not.toContain("dash.png");
  });

  it("prefers img attr over figure attr for data-search-description", () => {
    const html = `<html><body><main><figure data-search-description="Figure desc"><img src="x.png" data-search-description="Img desc"/></figure></main></body></html>`;
    const extracted = extractFromHtml("/test", html, config);
    expect(extracted?.markdown).toContain("Img desc");
    expect(extracted?.markdown).not.toContain("Figure desc");
  });

  it("combines meaningful alt with figcaption without duplication", () => {
    const html = `<html><body><main><figure><img src="chart.png" alt="Revenue chart for Q4"/><figcaption>Quarterly revenue breakdown</figcaption></figure></main></body></html>`;
    const extracted = extractFromHtml("/test", html, config);
    expect(extracted?.markdown).toContain("Revenue chart for Q4");
    expect(extracted?.markdown).toContain("Quarterly revenue breakdown");
    expect(extracted?.markdown).not.toContain("chart.png");
    // Figcaption text should appear only once (inside the combined replacement), not duplicated
    const count = extracted!.markdown.split("Quarterly revenue breakdown").length - 1;
    expect(count).toBe(1);
  });

  it("uses meaningful alt alone when no figcaption", () => {
    const html = `<html><body><main><img src="photo.jpg" alt="Team celebrating product launch"/></main></body></html>`;
    const extracted = extractFromHtml("/test", html, config);
    expect(extracted?.markdown).toContain("Team celebrating product launch");
    expect(extracted?.markdown).not.toContain("photo.jpg");
  });

  it("removes img with empty alt (decorative)", () => {
    const html = `<html><body><main><p>Content here</p><img src="spacer.gif" alt=""/></main></body></html>`;
    const extracted = extractFromHtml("/test", html, config);
    expect(extracted?.markdown).not.toContain("spacer.gif");
    expect(extracted?.markdown).not.toMatch(/!\[/);
  });

  it("removes img with garbage alt text", () => {
    const html = `<html><body><main><p>Content</p><img src="hero.png" alt="image"/></main></body></html>`;
    const extracted = extractFromHtml("/test", html, config);
    expect(extracted?.markdown).not.toContain("hero.png");
    expect(extracted?.markdown).not.toMatch(/!\[/);
  });

  it("removes img with filename-like alt", () => {
    const html = `<html><body><main><p>Content</p><img src="/assets/hero-v2.jpg" alt="hero-v2.jpg"/></main></body></html>`;
    const extracted = extractFromHtml("/test", html, config);
    expect(extracted?.markdown).not.toContain("hero-v2.jpg");
    expect(extracted?.markdown).not.toMatch(/!\[/);
  });

  it("removes img with short alt (< 5 chars)", () => {
    const html = `<html><body><main><p>Content</p><img src="x.png" alt="btn"/></main></body></html>`;
    const extracted = extractFromHtml("/test", html, config);
    expect(extracted?.markdown).not.toContain("btn");
    expect(extracted?.markdown).not.toMatch(/!\[/);
  });

  it("handles picture wrapper — replaces entire picture element", () => {
    const html = `<html><body><main><picture><source srcset="x.webp" type="image/webp"/><img src="x.png" data-search-description="Workflow diagram"/></picture></main></body></html>`;
    const extracted = extractFromHtml("/test", html, config);
    expect(extracted?.markdown).toContain("Workflow diagram");
    expect(extracted?.markdown).not.toContain("x.png");
    expect(extracted?.markdown).not.toContain("x.webp");
  });

  it("supports custom imageDescAttr config", () => {
    const customConfig = {
      ...config,
      extract: { ...config.extract, imageDescAttr: "data-alt-search" }
    };
    const html = `<html><body><main><img src="x.png" data-alt-search="Custom desc"/></main></body></html>`;
    const extracted = extractFromHtml("/test", html, customConfig);
    expect(extracted?.markdown).toContain("Custom desc");
    expect(extracted?.markdown).not.toContain("x.png");
  });

  it("uses figcaption alone when alt is not meaningful", () => {
    const html = `<html><body><main><figure><img src="x.png" alt="image"/><figcaption>A detailed explanation</figcaption></figure></main></body></html>`;
    const extracted = extractFromHtml("/test", html, config);
    expect(extracted?.markdown).toContain("A detailed explanation");
    expect(extracted?.markdown).not.toMatch(/!\[/);
  });

  it("handles picture inside figure with figcaption without duplication", () => {
    const html = `<html><body><main><figure><picture><source srcset="x.webp"/><img src="x.png" alt="Architecture diagram overview"/></picture><figcaption>System architecture</figcaption></figure></main></body></html>`;
    const extracted = extractFromHtml("/test", html, config);
    expect(extracted?.markdown).toContain("Architecture diagram overview");
    expect(extracted?.markdown).toContain("System architecture");
    const count = extracted!.markdown.split("System architecture").length - 1;
    expect(count).toBe(1);
  });

  it("suppresses figcaption when data-search-description is present", () => {
    const html = `<html><body><main><figure><img src="x.png" data-search-description="Explicit description"/><figcaption>Caption text</figcaption></figure></main></body></html>`;
    const extracted = extractFromHtml("/test", html, config);
    expect(extracted?.markdown).toContain("Explicit description");
    expect(extracted?.markdown).not.toContain("Caption text");
  });

  it("handles whitespace-only data-search-description by falling through", () => {
    const html = `<html><body><main><img src="x.png" data-search-description="   " alt="Valid alt text here"/></main></body></html>`;
    const extracted = extractFromHtml("/test", html, config);
    expect(extracted?.markdown).toContain("Valid alt text here");
  });

  it("handles HTML special chars in description text", () => {
    const html = `<html><body><main><img src="x.png" data-search-description="Compare A &lt; B &amp; C > D"/></main></body></html>`;
    const extracted = extractFromHtml("/test", html, config);
    expect(extracted?.markdown).toContain("Compare A < B & C > D");
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
