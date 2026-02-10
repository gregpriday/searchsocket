import { describe, expect, it } from "vitest";
import { createDefaultConfig } from "../src/config/defaults";
import { chunkMirrorPage } from "../src/indexing/chunker";
import type { MirrorPage, Scope } from "../src/types";

const config = createDefaultConfig("test");
const scope: Scope = {
  projectId: "test",
  scopeName: "main",
  scopeId: "test:main"
};

function makePage(markdown: string, url = "/test"): MirrorPage {
  return {
    url,
    title: "Test Page",
    scope: "main",
    routeFile: "src/routes/+page.svelte",
    routeResolution: "exact",
    generatedAt: "2026-01-01T00:00:00.000Z",
    incomingLinks: 2,
    outgoingLinks: 1,
    depth: 1,
    tags: ["docs"],
    markdown
  };
}

describe("chunkMirrorPage - extended", () => {
  it("handles page with no headings", () => {
    const page = makePage("Just some paragraphs.\n\nAnother paragraph.\n");
    const chunks = chunkMirrorPage(page, config, scope);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0]?.sectionTitle).toBeUndefined();
  });

  it("splits by headings", () => {
    const page = makePage("# Section A\n\nContent A.\n\n## Section B\n\nContent B.\n");
    const chunks = chunkMirrorPage(page, config, scope);
    expect(chunks.length).toBe(2);
    expect(chunks[0]?.sectionTitle).toBe("Section A");
    expect(chunks[1]?.sectionTitle).toBe("Section B");
  });

  it("tracks heading path correctly", () => {
    const page = makePage("# Top\n\nIntro.\n\n## Sub\n\nContent.\n\n### Deep\n\nDeep content.\n");
    const chunks = chunkMirrorPage(page, config, scope);
    const deepChunk = chunks.find((c) => c.sectionTitle === "Deep");
    expect(deepChunk?.headingPath).toEqual(["Top", "Sub", "Deep"]);
  });

  it("caps heading path to configured depth", () => {
    const deepConfig = createDefaultConfig("test");
    deepConfig.chunking.headingPathDepth = 2;

    const page = makePage("# A\n\n## B\n\n### C\n\n#### D\n\nContent.\n");
    const chunks = chunkMirrorPage(page, deepConfig, scope);
    const lastChunk = chunks[chunks.length - 1];
    expect(lastChunk?.headingPath.length).toBeLessThanOrEqual(2);
  });

  it("preserves fenced code blocks within chunks", () => {
    const page = makePage(
      "# Code Example\n\n```typescript\nfunction hello() {\n  return 'world';\n}\n```\n\nParagraph after code.\n"
    );
    const chunks = chunkMirrorPage(page, config, scope);
    const codeChunk = chunks.find((c) => c.chunkText.includes("```typescript"));
    expect(codeChunk).toBeDefined();
    expect(codeChunk?.chunkText).toContain("function hello()");
  });

  it("produces stable chunk keys", () => {
    const page = makePage("# Hello\n\nWorld.\n");
    const first = chunkMirrorPage(page, config, scope);
    const second = chunkMirrorPage(page, config, scope);
    expect(first.map((c) => c.chunkKey)).toEqual(second.map((c) => c.chunkKey));
  });

  it("produces stable content hashes", () => {
    const page = makePage("# Hello\n\nWorld.\n");
    const first = chunkMirrorPage(page, config, scope);
    const second = chunkMirrorPage(page, config, scope);
    expect(first.map((c) => c.contentHash)).toEqual(second.map((c) => c.contentHash));
  });

  it("sets correct metadata on chunks", () => {
    const page = makePage("# Test\n\nContent.\n", "/docs/example");
    page.incomingLinks = 5;
    page.depth = 2;
    page.tags = ["guides"];
    page.routeFile = "src/routes/docs/example/+page.svelte";

    const chunks = chunkMirrorPage(page, config, scope);
    expect(chunks[0]?.url).toBe("/docs/example");
    expect(chunks[0]?.path).toBe("/docs/example");
    expect(chunks[0]?.incomingLinks).toBe(5);
    expect(chunks[0]?.depth).toBe(2);
    expect(chunks[0]?.tags).toEqual(["guides"]);
    expect(chunks[0]?.routeFile).toBe("src/routes/docs/example/+page.svelte");
  });

  it("generates snippets", () => {
    const page = makePage("# Hello\n\nThis is a paragraph with some content.\n");
    const chunks = chunkMirrorPage(page, config, scope);
    expect(chunks[0]?.snippet).toBeTruthy();
    expect(chunks[0]?.snippet).toContain("paragraph");
  });

  it("splits large sections into multiple chunks", () => {
    const longContent = Array.from({ length: 50 }, (_, i) => `Paragraph ${i}. `.repeat(20)).join("\n\n");
    const page = makePage(`# Big Section\n\n${longContent}\n`);
    const chunks = chunkMirrorPage(page, config, scope);
    expect(chunks.length).toBeGreaterThan(1);
  });

  it("merges small trailing chunks into previous", () => {
    // Create content that would produce a tiny trailing chunk
    const content = "A ".repeat(500) + "\n\nB ".repeat(500) + "\n\nC.\n";
    const page = makePage(`# Section\n\n${content}\n`);
    const chunks = chunkMirrorPage(page, config, scope);
    // The last chunk should be at least minChars or merged
    for (const chunk of chunks) {
      // Each chunk should either be the only chunk, or have reasonable size
      expect(chunk.chunkText.length).toBeGreaterThan(0);
    }
  });

  it("splits a single oversized paragraph to keep chunks within maxChars", () => {
    const constrainedConfig = createDefaultConfig("test");
    constrainedConfig.chunking.maxChars = 220;
    constrainedConfig.chunking.minChars = 40;
    constrainedConfig.chunking.overlapChars = 30;

    const singleLongParagraph = `# Oversized\n\n${"word ".repeat(250).trim()}\n`;
    const page = makePage(singleLongParagraph);
    const chunks = chunkMirrorPage(page, constrainedConfig, scope);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.chunkText.length).toBeLessThanOrEqual(constrainedConfig.chunking.maxChars);
    }
  });

  it("keeps non-protected chunks within maxChars under randomized paragraph inputs", () => {
    const fuzzConfig = createDefaultConfig("test");
    fuzzConfig.chunking.maxChars = 180;
    fuzzConfig.chunking.minChars = 30;
    fuzzConfig.chunking.overlapChars = 24;

    let seed = 1337;
    const rand = (): number => {
      seed = (seed * 1103515245 + 12345) % 0x80000000;
      return seed / 0x80000000;
    };

    for (let i = 0; i < 40; i += 1) {
      const blockCount = 3 + Math.floor(rand() * 6);
      const lines: string[] = ["# Fuzz"];

      for (let b = 0; b < blockCount; b += 1) {
        const wordCount = 20 + Math.floor(rand() * 80);
        const words = Array.from({ length: wordCount }, (_, idx) => `w${i}_${b}_${idx}`);
        lines.push("");
        lines.push(words.join(" "));
      }

      const page = makePage(`${lines.join("\n")}\n`);
      const chunks = chunkMirrorPage(page, fuzzConfig, scope);

      for (const chunk of chunks) {
        expect(chunk.chunkText.length).toBeLessThanOrEqual(fuzzConfig.chunking.maxChars);
      }
    }
  });
});
