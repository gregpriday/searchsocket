import { describe, expect, it } from "vitest";
import { createDefaultConfig } from "../src/config/defaults";
import { extractFromHtml, extractFromMarkdown, normalizeAnchorText } from "../src/indexing/extractor";

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
    expect(extracted?.outgoingLinks.some(l => l.url === "/docs/next")).toBe(true);
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

describe("normalizeAnchorText", () => {
  it("lowercases and trims text", () => {
    expect(normalizeAnchorText("  Installation Guide  ")).toBe("installation guide");
  });

  it("collapses whitespace", () => {
    expect(normalizeAnchorText("get   started   now")).toBe("get started now");
  });

  it("filters anchors shorter than 3 chars", () => {
    expect(normalizeAnchorText("go")).toBe("");
    expect(normalizeAnchorText("ab")).toBe("");
  });

  it("keeps anchors of exactly 3 chars", () => {
    expect(normalizeAnchorText("api")).toBe("api");
  });

  it("filters stop anchors", () => {
    expect(normalizeAnchorText("here")).toBe("");
    expect(normalizeAnchorText("Click Here")).toBe("");
    expect(normalizeAnchorText("read more")).toBe("");
    expect(normalizeAnchorText("link")).toBe("");
    expect(normalizeAnchorText("this")).toBe("");
    expect(normalizeAnchorText("more")).toBe("");
  });

  it("does not filter non-exact stop anchor matches", () => {
    expect(normalizeAnchorText("click here for more info")).toBe("click here for more info");
    expect(normalizeAnchorText("read more about authentication")).toBe("read more about authentication");
  });

  it("truncates at 100 chars", () => {
    const long = "a".repeat(120);
    expect(normalizeAnchorText(long).length).toBe(100);
  });
});

describe("anchor text extraction", () => {
  it("captures anchor text alongside URL", () => {
    const html = `<html><body><main><h1>Title</h1><a href="/docs/install">Installation Guide</a></main></body></html>`;
    const extracted = extractFromHtml("/test", html, config);
    const link = extracted?.outgoingLinks.find(l => l.url === "/docs/install");
    expect(link).toBeDefined();
    expect(link!.anchorText).toBe("installation guide");
  });

  it("falls back to img alt for image-only links", () => {
    const html = `<html><body><main><h1>Title</h1><a href="/docs/guide"><img src="x.png" alt="Setup Guide for Beginners"/></a></main></body></html>`;
    const extracted = extractFromHtml("/test", html, config);
    const link = extracted?.outgoingLinks.find(l => l.url === "/docs/guide");
    expect(link).toBeDefined();
    expect(link!.anchorText).toBe("setup guide for beginners");
  });

  it("returns empty anchorText for image link with garbage alt", () => {
    const html = `<html><body><main><h1>Title</h1><a href="/docs/guide"><img src="x.png" alt="logo"/></a></main></body></html>`;
    const extracted = extractFromHtml("/test", html, config);
    const link = extracted?.outgoingLinks.find(l => l.url === "/docs/guide");
    expect(link).toBeDefined();
    expect(link!.anchorText).toBe("");
  });

  it("deduplicates same url+anchorText pairs", () => {
    const html = `<html><body><main>
      <h1>Title</h1>
      <a href="/docs/api">API Reference</a>
      <a href="/docs/api">API Reference</a>
    </main></body></html>`;
    const extracted = extractFromHtml("/test", html, config);
    const apiLinks = extracted?.outgoingLinks.filter(l => l.url === "/docs/api");
    expect(apiLinks?.length).toBe(1);
  });

  it("keeps different anchors to same URL as separate entries", () => {
    const html = `<html><body><main>
      <h1>Title</h1>
      <a href="/docs/api">API Reference</a>
      <a href="/docs/api">REST Endpoints</a>
    </main></body></html>`;
    const extracted = extractFromHtml("/test", html, config);
    const apiLinks = extracted?.outgoingLinks.filter(l => l.url === "/docs/api");
    expect(apiLinks?.length).toBe(2);
  });

  it("extractFromMarkdown returns empty outgoingLinks array", () => {
    const md = `---\ntitle: Test\n---\n\n# Hello\n\nContent.`;
    const extracted = extractFromMarkdown("/test", md);
    expect(extracted?.outgoingLinks).toEqual([]);
  });
});
