import { describe, expect, it } from "vitest";
import { createDefaultConfig } from "../src/config/defaults";
import { buildEmbeddingText, buildSummaryChunkText, chunkPage } from "../src/indexing/chunker";
import type { Chunk, IndexedPage, Scope } from "../src/types";

const config = createDefaultConfig("searchsocket-test");
const scope: Scope = {
  projectId: "searchsocket-test",
  scopeName: "main",
  scopeId: "searchsocket-test:main"
};

describe("chunkPage", () => {
  it("creates stable chunk keys and keeps fenced code together", () => {
    const page: IndexedPage = {
      url: "/docs/code",
      title: "Code",
      scope: "main",
      routeFile: "src/routes/docs/code/+page.svelte",
      routeResolution: "exact",
      generatedAt: "2026-01-01T00:00:00.000Z",
      incomingLinks: 1,
      outgoingLinks: 0,
      depth: 2,
      tags: ["docs"],
      markdown: `
# Intro
This paragraph repeats to exceed chunk limits. This paragraph repeats to exceed chunk limits.

## Example
\`\`\`ts
const x = 1;
const y = 2;
console.log(x + y);
\`\`\`

Another long section content here.
`
    };

    const first = chunkPage(page, config, scope);
    const second = chunkPage(page, config, scope);

    expect(first.length).toBeGreaterThan(0);
    expect(first.map((chunk) => chunk.chunkKey)).toEqual(second.map((chunk) => chunk.chunkKey));
    expect(first.some((chunk) => chunk.chunkText.includes("```ts"))).toBe(true);
  });
});

describe("buildEmbeddingText", () => {
  const baseChunk: Chunk = {
    chunkKey: "test-key",
    ordinal: 0,
    url: "/docs/github",
    path: "/docs/github",
    title: "GitHub Integration - Canopy Docs",
    sectionTitle: undefined,
    headingPath: [],
    chunkText: "Setup instructions for connecting your repo.",
    snippet: "Setup instructions for connecting your repo.",
    depth: 2,
    incomingLinks: 1,
    routeFile: "src/routes/docs/github/+page.svelte",
    tags: [],
    contentHash: "abc123"
  };

  it("returns chunkText unchanged when prependTitle is false", () => {
    const result = buildEmbeddingText(baseChunk, false);
    expect(result).toBe(baseChunk.chunkText);
  });

  it("prepends 'Title\\n\\n' when there is no section title", () => {
    const result = buildEmbeddingText(baseChunk, true);
    expect(result).toBe(
      `GitHub Integration - Canopy Docs\n\nSetup instructions for connecting your repo.`
    );
  });

  it("prepends 'Title — Section\\n\\n' when section title exists", () => {
    const chunk: Chunk = { ...baseChunk, sectionTitle: "Repo Stats" };
    const result = buildEmbeddingText(chunk, true);
    expect(result).toBe(
      `GitHub Integration - Canopy Docs — Repo Stats\n\nSetup instructions for connecting your repo.`
    );
  });
});

describe("contentHash reflects embedding text", () => {
  it("contentHash changes when title changes with prependTitle enabled", () => {
    const page: IndexedPage = {
      url: "/docs/github",
      title: "GitHub Integration",
      scope: "main",
      routeFile: "src/routes/docs/github/+page.svelte",
      routeResolution: "exact",
      generatedAt: "2026-01-01T00:00:00.000Z",
      incomingLinks: 0,
      outgoingLinks: 0,
      depth: 2,
      tags: [],
      markdown: "Some content about connecting repos."
    };

    const chunksA = chunkPage(page, config, scope);

    const renamedPage: IndexedPage = { ...page, title: "GH Integration" };
    const chunksB = chunkPage(renamedPage, config, scope);

    expect(chunksA.length).toBeGreaterThan(0);
    expect(chunksB.length).toBeGreaterThan(0);
    expect(chunksA[0]!.contentHash).not.toBe(chunksB[0]!.contentHash);
  });

  it("contentHash is the same regardless of title when prependTitle is disabled", () => {
    const noPrependConfig = {
      ...config,
      chunking: { ...config.chunking, prependTitle: false, pageSummaryChunk: false }
    };

    const page: IndexedPage = {
      url: "/docs/github",
      title: "GitHub Integration",
      scope: "main",
      routeFile: "src/routes/docs/github/+page.svelte",
      routeResolution: "exact",
      generatedAt: "2026-01-01T00:00:00.000Z",
      incomingLinks: 0,
      outgoingLinks: 0,
      depth: 2,
      tags: [],
      markdown: "Some content about connecting repos."
    };

    const chunksA = chunkPage(page, noPrependConfig, scope);

    const renamedPage: IndexedPage = { ...page, title: "GH Integration" };
    const chunksB = chunkPage(renamedPage, noPrependConfig, scope);

    expect(chunksA.length).toBeGreaterThan(0);
    expect(chunksB.length).toBeGreaterThan(0);
    expect(chunksA[0]!.contentHash).toBe(chunksB[0]!.contentHash);
  });
});

describe("summary chunk", () => {
  const basePage: IndexedPage = {
    url: "/docs/security",
    title: "Security Guide",
    scope: "main",
    routeFile: "src/routes/docs/security/+page.svelte",
    routeResolution: "exact",
    generatedAt: "2026-01-01T00:00:00.000Z",
    incomingLinks: 2,
    outgoingLinks: 1,
    depth: 2,
    tags: ["docs"],
    markdown: "# Security\n\nThis guide covers security best practices.\n\nMore content here."
  };

  it("generates summary chunk at ordinal 0 with correct content", () => {
    const chunks = chunkPage(basePage, config, scope);
    const summary = chunks[0]!;
    expect(summary.ordinal).toBe(0);
    expect(summary.chunkText).toContain("Security Guide");
    expect(summary.chunkText).toContain("docs / security");
    expect(summary.chunkText).toContain("This guide covers security best practices.");
    expect(summary.sectionTitle).toBeUndefined();
    expect(summary.headingPath).toEqual([]);
  });

  it("shifts regular chunk ordinals by 1", () => {
    const chunks = chunkPage(basePage, config, scope);
    expect(chunks.length).toBeGreaterThan(1);
    // First regular chunk should have ordinal 1
    expect(chunks[1]!.ordinal).toBe(1);
  });

  it("does not generate summary chunk when pageSummaryChunk is false", () => {
    const noSummaryConfig = {
      ...config,
      chunking: { ...config.chunking, pageSummaryChunk: false }
    };
    const chunks = chunkPage(basePage, noSummaryConfig, scope);
    // First chunk should be ordinal 0 (regular chunk)
    expect(chunks[0]!.ordinal).toBe(0);
    // No chunk should have __summary__ in its key derivation
    expect(chunks.every((c) => !c.chunkText.startsWith("Security Guide\n\ndocs / security"))).toBe(true);
  });

  it("produces stable chunkKey across runs", () => {
    const first = chunkPage(basePage, config, scope);
    const second = chunkPage(basePage, config, scope);
    expect(first[0]!.chunkKey).toBe(second[0]!.chunkKey);
  });

  it("regular chunk keys unchanged when summary is toggled", () => {
    const withSummary = chunkPage(basePage, config, scope);
    const noSummaryConfig = {
      ...config,
      chunking: { ...config.chunking, pageSummaryChunk: false }
    };
    const withoutSummary = chunkPage(basePage, noSummaryConfig, scope);

    // Regular chunk keys should be identical
    const regularKeysWithSummary = withSummary.slice(1).map((c) => c.chunkKey);
    const regularKeysWithoutSummary = withoutSummary.map((c) => c.chunkKey);
    expect(regularKeysWithSummary).toEqual(regularKeysWithoutSummary);
  });

  it("root page omits humanized path", () => {
    const rootPage: IndexedPage = {
      ...basePage,
      url: "/",
      depth: 0
    };
    const chunks = chunkPage(rootPage, config, scope);
    const summaryText = chunks[0]!.chunkText;
    // Should not have an empty line for the path segment
    expect(summaryText).not.toContain("\n\n\n");
    expect(summaryText.startsWith("Security Guide")).toBe(true);
  });

  it("uses description instead of first paragraph when available", () => {
    const pageWithDesc: IndexedPage = {
      ...basePage,
      description: "A comprehensive security overview."
    };
    const chunks = chunkPage(pageWithDesc, config, scope);
    const summaryText = chunks[0]!.chunkText;
    expect(summaryText).toContain("A comprehensive security overview.");
    expect(summaryText).not.toContain("This guide covers security best practices.");
  });

  it("includes keywords in summary text", () => {
    const pageWithKeywords: IndexedPage = {
      ...basePage,
      keywords: ["auth", "encryption", "OWASP"]
    };
    const chunks = chunkPage(pageWithKeywords, config, scope);
    const summaryText = chunks[0]!.chunkText;
    expect(summaryText).toContain("auth, encryption, OWASP");
  });
});

describe("buildSummaryChunkText", () => {
  it("includes title, path, and first paragraph", () => {
    const page: IndexedPage = {
      url: "/docs/getting-started",
      title: "Getting Started",
      scope: "main",
      routeFile: "",
      routeResolution: "exact",
      generatedAt: "",
      incomingLinks: 0,
      outgoingLinks: 0,
      depth: 2,
      tags: [],
      markdown: "# Intro\n\nWelcome to the guide.\n\nMore stuff."
    };
    const text = buildSummaryChunkText(page);
    expect(text).toBe("Getting Started\n\ndocs / getting started\n\nWelcome to the guide.");
  });

  it("uses description over first paragraph", () => {
    const page: IndexedPage = {
      url: "/docs/api",
      title: "API Reference",
      scope: "main",
      routeFile: "",
      routeResolution: "exact",
      generatedAt: "",
      incomingLinks: 0,
      outgoingLinks: 0,
      depth: 2,
      tags: [],
      markdown: "# API\n\nSome content.",
      description: "Complete API reference docs."
    };
    const text = buildSummaryChunkText(page);
    expect(text).toContain("Complete API reference docs.");
    expect(text).not.toContain("Some content.");
  });

  it("appends keywords", () => {
    const page: IndexedPage = {
      url: "/security",
      title: "Security",
      scope: "main",
      routeFile: "",
      routeResolution: "exact",
      generatedAt: "",
      incomingLinks: 0,
      outgoingLinks: 0,
      depth: 1,
      tags: [],
      markdown: "Secure your app.",
      keywords: ["auth", "SSL"]
    };
    const text = buildSummaryChunkText(page);
    expect(text).toContain("auth, SSL");
  });

  it("omits path for root page", () => {
    const page: IndexedPage = {
      url: "/",
      title: "Home",
      scope: "main",
      routeFile: "",
      routeResolution: "exact",
      generatedAt: "",
      incomingLinks: 0,
      outgoingLinks: 0,
      depth: 0,
      tags: [],
      markdown: "Welcome home."
    };
    const text = buildSummaryChunkText(page);
    expect(text).toBe("Home\n\nWelcome home.");
  });
});
