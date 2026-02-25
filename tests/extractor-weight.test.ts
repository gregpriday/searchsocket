import { describe, expect, it } from "vitest";
import { createDefaultConfig } from "../src/config/defaults";
import { extractFromHtml, extractFromMarkdown } from "../src/indexing/extractor";

const config = createDefaultConfig("searchsocket-test");

describe("extractFromHtml - searchsocket-weight meta tag", () => {
  it("returns null when weight is 0 (skip indexing)", () => {
    const html = `
      <html>
        <head>
          <title>Archive</title>
          <meta name="searchsocket-weight" content="0" />
        </head>
        <body><main><p>Old archive page</p></main></body>
      </html>
    `;
    expect(extractFromHtml("/archive", html, config)).toBeNull();
  });

  it("attaches weight to ExtractedPage when non-zero", () => {
    const html = `
      <html>
        <head>
          <title>Low Priority</title>
          <meta name="searchsocket-weight" content="0.5" />
        </head>
        <body><main><p>Some content</p></main></body>
      </html>
    `;
    const extracted = extractFromHtml("/low-priority", html, config);
    expect(extracted).not.toBeNull();
    expect(extracted!.weight).toBe(0.5);
  });

  it("attaches boost weight when greater than 1", () => {
    const html = `
      <html>
        <head>
          <title>Important</title>
          <meta name="searchsocket-weight" content="1.5" />
        </head>
        <body><main><p>Very important content</p></main></body>
      </html>
    `;
    const extracted = extractFromHtml("/important", html, config);
    expect(extracted).not.toBeNull();
    expect(extracted!.weight).toBe(1.5);
  });

  it("weight is undefined when meta tag is absent", () => {
    const html = `
      <html>
        <head><title>Normal</title></head>
        <body><main><p>Normal page</p></main></body>
      </html>
    `;
    const extracted = extractFromHtml("/normal", html, config);
    expect(extracted).not.toBeNull();
    expect(extracted!.weight).toBeUndefined();
  });

  it("ignores invalid (non-numeric) weight values", () => {
    const html = `
      <html>
        <head>
          <title>Bad Weight</title>
          <meta name="searchsocket-weight" content="abc" />
        </head>
        <body><main><p>Content</p></main></body>
      </html>
    `;
    const extracted = extractFromHtml("/bad-weight", html, config);
    expect(extracted).not.toBeNull();
    expect(extracted!.weight).toBeUndefined();
  });

  it("ignores negative weight values", () => {
    const html = `
      <html>
        <head>
          <title>Negative</title>
          <meta name="searchsocket-weight" content="-1" />
        </head>
        <body><main><p>Content</p></main></body>
      </html>
    `;
    const extracted = extractFromHtml("/negative", html, config);
    expect(extracted).not.toBeNull();
    expect(extracted!.weight).toBeUndefined();
  });
});

describe("extractFromMarkdown - weight from frontmatter", () => {
  it("returns null when searchsocket.weight is 0", () => {
    const markdown = `---
title: Archive
searchsocket:
  weight: 0
---
Old archive content.
`;
    expect(extractFromMarkdown("/archive", markdown)).toBeNull();
  });

  it("attaches weight when searchsocket.weight is set", () => {
    const markdown = `---
title: Low Priority
searchsocket:
  weight: 0.3
---
Some content.
`;
    const extracted = extractFromMarkdown("/low-priority", markdown);
    expect(extracted).not.toBeNull();
    expect(extracted!.weight).toBe(0.3);
  });

  it("weight is undefined when not specified in frontmatter", () => {
    const markdown = `---
title: Normal
---
Normal content.
`;
    const extracted = extractFromMarkdown("/normal", markdown);
    expect(extracted).not.toBeNull();
    expect(extracted!.weight).toBeUndefined();
  });

  it("reads searchsocketWeight frontmatter key", () => {
    const markdown = `---
title: Alt Key
searchsocketWeight: 0.7
---
Content here.
`;
    const extracted = extractFromMarkdown("/alt-key", markdown);
    expect(extracted).not.toBeNull();
    expect(extracted!.weight).toBe(0.7);
  });
});
