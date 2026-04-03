import { describe, expect, it } from "vitest";
import { createDefaultConfig } from "../src/config/defaults";
import { buildEmbeddingTitle, chunkPage } from "../src/indexing/chunker";
import type { Chunk, IndexedPage, Scope } from "../src/types";

const config = createDefaultConfig("test");
const scope: Scope = {
  projectId: "test",
  scopeName: "main",
  scopeId: "test:main"
};

function makePage(markdown: string, title = "Test Page"): IndexedPage {
  return {
    url: "/docs/test",
    title,
    scope: "main",
    routeFile: "src/routes/docs/test/+page.svelte",
    routeResolution: "exact",
    generatedAt: "2026-01-01T00:00:00.000Z",
    incomingLinks: 1,
    outgoingLinks: 0,
    depth: 2,
    tags: ["docs"],
    markdown
  };
}

describe("headingLevel propagation", () => {
  it("assigns correct heading level to chunks from different heading depths", () => {
    const noSummaryConfig = { ...config, chunking: { ...config.chunking, pageSummaryChunk: false } };
    const page = makePage("# Intro\n\nContent.\n\n## Details\n\nMore content.\n\n### Deep\n\nDeep content.\n");
    const chunks = chunkPage(page, noSummaryConfig, scope);

    const intro = chunks.find((c) => c.sectionTitle === "Intro");
    const details = chunks.find((c) => c.sectionTitle === "Details");
    const deep = chunks.find((c) => c.sectionTitle === "Deep");

    expect(intro?.headingLevel).toBe(1);
    expect(details?.headingLevel).toBe(2);
    expect(deep?.headingLevel).toBe(3);
  });

  it("summary chunk has no heading level", () => {
    const page = makePage("# Section\n\nContent here.\n");
    const chunks = chunkPage(page, config, scope);
    const summary = chunks[0]!;
    expect(summary.ordinal).toBe(0);
    expect(summary.headingLevel).toBeUndefined();
  });

  it("chunks from pages with no headings have no heading level", () => {
    const noHeadConfig = { ...config, chunking: { ...config.chunking, pageSummaryChunk: false } };
    const page = makePage("Just plain text without any headings.\n");
    const chunks = chunkPage(page, noHeadConfig, scope);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0]?.headingLevel).toBeUndefined();
  });
});

describe("buildEmbeddingTitle", () => {
  const baseChunk: Chunk = {
    chunkKey: "test-key",
    ordinal: 1,
    url: "/docs/test",
    path: "/docs/test",
    title: "Getting Started Guide",
    sectionTitle: "Installation",
    headingLevel: 1,
    headingPath: ["Installation"],
    chunkText: "Install the package with npm.",
    snippet: "Install the package with npm.",
    depth: 2,
    incomingLinks: 1,
    routeFile: "src/routes/docs/test/+page.svelte",
    tags: [],
    contentHash: "abc"
  };

  it("returns title with section for h1 chunks", () => {
    const result = buildEmbeddingTitle(baseChunk);
    expect(result).toBe("Getting Started Guide — Installation");
  });

  it("returns breadcrumb title for h2+ chunks with heading path", () => {
    const chunk: Chunk = {
      ...baseChunk,
      sectionTitle: "Prerequisites",
      headingLevel: 2,
      headingPath: ["Installation", "Prerequisites"]
    };
    const result = buildEmbeddingTitle(chunk);
    expect(result).toBe("Getting Started Guide — Installation > Prerequisites");
  });

  it("returns breadcrumb for h3 chunks with full path", () => {
    const chunk: Chunk = {
      ...baseChunk,
      sectionTitle: "Node.js",
      headingLevel: 3,
      headingPath: ["Installation", "Prerequisites", "Node.js"]
    };
    const result = buildEmbeddingTitle(chunk);
    expect(result).toBe("Getting Started Guide — Installation > Prerequisites > Node.js");
  });

  it("returns undefined for summary chunks (no section title)", () => {
    const chunk: Chunk = { ...baseChunk, sectionTitle: undefined, headingLevel: undefined, headingPath: [] };
    expect(buildEmbeddingTitle(chunk)).toBeUndefined();
  });

  it("returns undefined when headingLevel is undefined", () => {
    const chunk: Chunk = { ...baseChunk, headingLevel: undefined };
    expect(buildEmbeddingTitle(chunk)).toBeUndefined();
  });
});

describe("contentHash includes embedding title", () => {
  it("changing section heading changes contentHash when weightHeadings is on", () => {
    const page1 = makePage("# Installation\n\nInstall with npm.\n");
    const page2 = makePage("# Setup\n\nInstall with npm.\n");

    const chunks1 = chunkPage(page1, config, scope);
    const chunks2 = chunkPage(page2, config, scope);

    // Get the regular chunks (skip summary)
    const regular1 = chunks1.find((c) => c.sectionTitle === "Installation");
    const regular2 = chunks2.find((c) => c.sectionTitle === "Setup");

    expect(regular1).toBeDefined();
    expect(regular2).toBeDefined();
    expect(regular1!.contentHash).not.toBe(regular2!.contentHash);
  });

  it("contentHash differs with vs without weightHeadings for same content", () => {
    const withWeightConfig = {
      ...config,
      chunking: { ...config.chunking, weightHeadings: true, pageSummaryChunk: false }
    };
    const withoutWeightConfig = {
      ...config,
      chunking: { ...config.chunking, weightHeadings: false, pageSummaryChunk: false }
    };

    const page = makePage("# Installation\n\nInstall with npm.\n");

    const chunksOn = chunkPage(page, withWeightConfig, scope);
    const chunksOff = chunkPage(page, withoutWeightConfig, scope);

    // Same content but weightHeadings on/off produces different hashes
    // because the title is included in the hash when weightHeadings is on
    expect(chunksOn[0]!.contentHash).not.toBe(chunksOff[0]!.contentHash);
  });
});

describe("config defaults", () => {
  it("weightHeadings defaults to true", () => {
    const defaults = createDefaultConfig("test");
    expect(defaults.chunking.weightHeadings).toBe(true);
  });
});
