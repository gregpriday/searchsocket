import { describe, expect, it } from "vitest";
import {
  normalizeText,
  normalizeMarkdown,
  sanitizeScopeName,
  toSnippet,
  safeJsonParse,
  extractFirstParagraph
} from "../src/utils/text";

describe("normalizeText", () => {
  it("collapses whitespace", () => {
    expect(normalizeText("hello   world")).toBe("hello world");
  });

  it("trims leading/trailing", () => {
    expect(normalizeText("  hello  ")).toBe("hello");
  });

  it("normalizes CRLF", () => {
    expect(normalizeText("a\r\nb")).toBe("a b");
  });
});

describe("normalizeMarkdown", () => {
  it("trims trailing whitespace per line", () => {
    expect(normalizeMarkdown("hello   \nworld   ")).toBe("hello\nworld\n");
  });

  it("ends with newline", () => {
    expect(normalizeMarkdown("hello")).toBe("hello\n");
  });
});

describe("sanitizeScopeName", () => {
  it("lowercases and replaces special chars", () => {
    expect(sanitizeScopeName("Feature/My-Branch")).toBe("feature-my-branch");
  });

  it("strips leading/trailing hyphens", () => {
    expect(sanitizeScopeName("--main--")).toBe("main");
  });

  it("truncates to 80 chars", () => {
    const long = "a".repeat(100);
    expect(sanitizeScopeName(long).length).toBe(80);
  });
});

describe("toSnippet", () => {
  it("strips markdown formatting", () => {
    const snippet = toSnippet("# Hello\n\nThis is **bold** text.");
    expect(snippet).not.toContain("#");
    expect(snippet).not.toContain("*");
    expect(snippet).toContain("Hello");
    expect(snippet).toContain("bold");
  });

  it("strips code blocks", () => {
    const snippet = toSnippet("text\n```js\nconst x = 1;\n```\nafter");
    expect(snippet).not.toContain("const x");
    expect(snippet).toContain("text");
    expect(snippet).toContain("after");
  });

  it("truncates to maxLen", () => {
    const long = "word ".repeat(100);
    const snippet = toSnippet(long, 50);
    expect(snippet.length).toBeLessThanOrEqual(50);
  });
});

describe("extractFirstParagraph", () => {
  it("extracts paragraph after heading", () => {
    const md = "# Title\n\nThis is the first paragraph.\n\nSecond paragraph.";
    expect(extractFirstParagraph(md)).toBe("This is the first paragraph.");
  });

  it("skips code fences", () => {
    const md = "```js\nconst x = 1;\n```\n\nActual paragraph here.";
    expect(extractFirstParagraph(md)).toBe("Actual paragraph here.");
  });

  it("handles multi-line paragraphs", () => {
    const md = "# Title\n\nLine one\nline two\nline three.\n\nNext paragraph.";
    expect(extractFirstParagraph(md)).toBe("Line one line two line three.");
  });

  it("returns empty string for all-headings input", () => {
    const md = "# H1\n## H2\n### H3";
    expect(extractFirstParagraph(md)).toBe("");
  });

  it("returns empty string for empty input", () => {
    expect(extractFirstParagraph("")).toBe("");
  });

  it("extracts paragraph when no heading precedes it", () => {
    const md = "Just a plain paragraph.\n\nAnother one.";
    expect(extractFirstParagraph(md)).toBe("Just a plain paragraph.");
  });
});

describe("safeJsonParse", () => {
  it("parses valid JSON", () => {
    expect(safeJsonParse<string[]>('["a","b"]', [])).toEqual(["a", "b"]);
  });

  it("returns fallback for invalid JSON", () => {
    expect(safeJsonParse<string[]>("not json", ["fallback"])).toEqual(["fallback"]);
  });
});
