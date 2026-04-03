import { describe, expect, it } from "vitest";
import {
  normalizeText,
  normalizeMarkdown,
  sanitizeScopeName,
  toSnippet,
  safeJsonParse,
  extractFirstParagraph,
  queryAwareExcerpt
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

describe("queryAwareExcerpt", () => {
  it("centers excerpt on keyword cluster in the middle of text", () => {
    const prefix = "Lorem ipsum dolor sit amet. ".repeat(10); // ~280 chars
    const target = "The authentication middleware handles user sessions securely.";
    const suffix = " Consectetur adipiscing elit. ".repeat(10);
    const markdown = prefix + target + suffix;

    const result = queryAwareExcerpt(markdown, "authentication middleware");
    expect(result).toContain("authentication middleware");
    expect(result.startsWith("…")).toBe(true);
    expect(result.endsWith("…")).toBe(true);
  });

  it("returns full text without ellipsis when text is shorter than maxLen", () => {
    const short = "A short piece of text about authentication.";
    const result = queryAwareExcerpt(short, "authentication");
    expect(result).toBe("A short piece of text about authentication.");
    expect(result).not.toContain("…");
  });

  it("falls back to toSnippet when no query terms match", () => {
    const text = "The quick brown fox jumps over the lazy dog. ".repeat(10);
    const result = queryAwareExcerpt(text, "xylophone quantum");
    const fallback = toSnippet(text);
    expect(result).toBe(fallback);
  });

  it("falls back to toSnippet for empty query", () => {
    const text = "Some long text content. ".repeat(20);
    const result = queryAwareExcerpt(text, "");
    const fallback = toSnippet(text);
    expect(result).toBe(fallback);
  });

  it("filters out single-character query tokens", () => {
    const prefix = "Other content here. ".repeat(10);
    const text = prefix + "The big red balloon floated away." + " More content. ".repeat(10);
    const result = queryAwareExcerpt(text, "a balloon");
    // "a" is filtered out (length < 2), only "balloon" is used
    expect(result).toContain("balloon");
  });

  it("handles regex metacharacters in query terms", () => {
    const text = "We support C++ and Java programming. ".repeat(8);
    expect(() => queryAwareExcerpt(text, "c++")).not.toThrow();
    const result = queryAwareExcerpt(text, "c++");
    expect(result).toContain("C++");
  });

  it("handles query with parentheses", () => {
    const text = "The auth(middleware) function validates tokens. ".repeat(8);
    expect(() => queryAwareExcerpt(text, "auth(middleware)")).not.toThrow();
    const result = queryAwareExcerpt(text, "auth(middleware)");
    expect(result).toContain("auth(middleware)");
  });

  it("prefers regions with multiple distinct terms over single repeated term", () => {
    // Place "deploy" far from "kubernetes", then have them close together later
    const parts = [
      "deploy ".repeat(20),                          // many deploys at start
      "filler content here. ".repeat(10),
      "kubernetes deploy cluster orchestration. ",    // both terms together
      "more filler. ".repeat(10)
    ];
    const text = parts.join("");
    const result = queryAwareExcerpt(text, "kubernetes deploy", 100);
    expect(result).toContain("kubernetes");
    expect(result).toContain("deploy");
  });

  it("no leading ellipsis when excerpt starts at beginning", () => {
    const text = "authentication is the first word here. " + "padding content. ".repeat(20);
    const result = queryAwareExcerpt(text, "authentication");
    expect(result.startsWith("…")).toBe(false);
    expect(result).toContain("authentication");
  });

  it("no trailing ellipsis when excerpt reaches end of text", () => {
    const text = "padding content. ".repeat(20) + "this is the final authentication check.";
    const result = queryAwareExcerpt(text, "authentication");
    expect(result.endsWith("…")).toBe(false);
    expect(result).toContain("authentication");
  });

  it("strips markdown before scanning for keywords", () => {
    const md = "# Heading\n\n```js\nconst x = 1;\n```\n\nThe **important** keyword is here. " + "filler. ".repeat(30);
    const result = queryAwareExcerpt(md, "important keyword");
    expect(result).toContain("important");
    expect(result).toContain("keyword");
    expect(result).not.toContain("```");
    expect(result).not.toContain("**");
  });

  it("returns empty string for empty markdown", () => {
    expect(queryAwareExcerpt("", "test")).toBe("");
  });

  it("respects custom maxLen parameter", () => {
    const text = "word ".repeat(100);
    const result = queryAwareExcerpt(text, "word", 50);
    // Allow some tolerance for word-boundary snapping and ellipsis
    expect(result.length).toBeLessThanOrEqual(70);
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
