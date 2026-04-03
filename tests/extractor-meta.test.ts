import { describe, expect, it } from "vitest";
import { extractFromHtml, extractFromMarkdown } from "../src/indexing/extractor";
import { createDefaultConfig } from "../src/config/defaults";

const config = createDefaultConfig("test-project");

describe("extractFromHtml — structured metadata", () => {
  const wrap = (head: string, body: string) =>
    `<html><head>${head}</head><body><main>${body}</main></body></html>`;

  it("extracts typed metadata from searchsocket: meta tags", () => {
    const html = wrap(
      `<meta name="searchsocket:version" content="2.5" data-type="number">
       <meta name="searchsocket:category" content="auth" data-type="string">
       <meta name="searchsocket:deprecated" content="false" data-type="boolean">
       <meta name="searchsocket:frameworks" content="svelte,react" data-type="string[]">`,
      `<h1>Test Page</h1><p>Some content here for extraction.</p>`
    );
    const result = extractFromHtml("/docs/test", html, config);
    expect(result).not.toBeNull();
    expect(result!.meta).toEqual({
      version: 2.5,
      category: "auth",
      deprecated: false,
      frameworks: ["svelte", "react"]
    });
  });

  it("skips invalid meta key names", () => {
    const html = wrap(
      `<meta name="searchsocket:good_key" content="yes" data-type="string">
       <meta name="searchsocket:bad-key" content="no" data-type="string">`,
      `<h1>Page</h1><p>Content</p>`
    );
    const result = extractFromHtml("/test", html, config);
    expect(result!.meta).toEqual({ good_key: "yes" });
  });

  it("returns undefined meta when no searchsocket: tags present", () => {
    const html = wrap(
      `<meta name="searchsocket-weight" content="1.5">`,
      `<h1>Page</h1><p>Content</p>`
    );
    const result = extractFromHtml("/test", html, config);
    expect(result!.meta).toBeUndefined();
    expect(result!.weight).toBe(1.5);
  });

  it("returns null when searchsocket:noindex meta tag is present", () => {
    const html = wrap(
      `<meta name="searchsocket:noindex" content="true">`,
      `<h1>Page</h1><p>Content</p>`
    );
    const result = extractFromHtml("/test", html, config);
    expect(result).toBeNull();
  });

  it("merges searchsocket:tags meta tag into page tags", () => {
    const html = wrap(
      `<meta name="searchsocket:tags" content="guide,tutorial" data-type="string[]">`,
      `<h1>Page</h1><p>Content</p>`
    );
    const result = extractFromHtml("/docs/test", html, config);
    expect(result!.tags).toContain("guide");
    expect(result!.tags).toContain("tutorial");
    expect(result!.tags).toContain("docs"); // auto-derived from URL
  });

  it("does not include reserved keys (noindex, tags) in meta", () => {
    const html = wrap(
      `<meta name="searchsocket:tags" content="guide" data-type="string[]">
       <meta name="searchsocket:version" content="2" data-type="number">`,
      `<h1>Page</h1><p>Content</p>`
    );
    const result = extractFromHtml("/test", html, config);
    expect(result!.meta).toEqual({ version: 2 });
    expect(result!.meta).not.toHaveProperty("tags");
  });

  it("coexists with weight meta tag", () => {
    const html = wrap(
      `<meta name="searchsocket-weight" content="2.0">
       <meta name="searchsocket:version" content="3" data-type="number">`,
      `<h1>Page</h1><p>Content</p>`
    );
    const result = extractFromHtml("/test", html, config);
    expect(result!.weight).toBe(2.0);
    expect(result!.meta).toEqual({ version: 3 });
  });
});

describe("extractFromMarkdown — structured metadata", () => {
  it("extracts metadata from searchsocket.meta frontmatter", () => {
    const md = `---
title: Auth Guide
searchsocket:
  meta:
    version: 2
    category: auth
    deprecated: false
---

# Auth Guide

Content about authentication.`;
    const result = extractFromMarkdown("/docs/auth", md);
    expect(result).not.toBeNull();
    expect(result!.meta).toEqual({
      version: 2,
      category: "auth",
      deprecated: false
    });
  });

  it("handles string arrays in frontmatter meta", () => {
    const md = `---
title: Frameworks
searchsocket:
  meta:
    frameworks:
      - svelte
      - react
---

# Frameworks

Content about frameworks.`;
    const result = extractFromMarkdown("/docs/frameworks", md);
    expect(result!.meta).toEqual({
      frameworks: ["svelte", "react"]
    });
  });

  it("returns undefined meta when searchsocket.meta is absent", () => {
    const md = `---
title: Simple
searchsocket:
  weight: 1.5
---

# Simple

Just some content.`;
    const result = extractFromMarkdown("/docs/simple", md);
    expect(result!.meta).toBeUndefined();
    expect(result!.weight).toBe(1.5);
  });

  it("skips invalid keys in frontmatter meta", () => {
    const md = `---
title: Test
searchsocket:
  meta:
    good_key: valid
    bad-key: invalid
---

# Test Page

Content here.`;
    const result = extractFromMarkdown("/test", md);
    expect(result!.meta).toEqual({ good_key: "valid" });
  });
});
