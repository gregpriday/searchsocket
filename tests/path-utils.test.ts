import { describe, expect, it } from "vitest";
import {
  normalizeUrlPath,
  urlPathToMirrorRelative,
  staticHtmlFileToUrl,
  getUrlDepth,
  ensureLeadingSlash,
  joinUrl
} from "../src/utils/path";

describe("normalizeUrlPath", () => {
  it("ensures leading slash", () => {
    expect(normalizeUrlPath("docs/start")).toBe("/docs/start");
  });

  it("removes trailing slash", () => {
    expect(normalizeUrlPath("/docs/start/")).toBe("/docs/start");
  });

  it("keeps root path as /", () => {
    expect(normalizeUrlPath("/")).toBe("/");
  });

  it("collapses multiple slashes", () => {
    expect(normalizeUrlPath("//docs///start//")).toBe("/docs/start");
  });

  it("trims whitespace", () => {
    expect(normalizeUrlPath("  /docs  ")).toBe("/docs");
  });

  it("normalizes empty input to root", () => {
    expect(normalizeUrlPath("")).toBe("/");
  });
});

describe("urlPathToMirrorRelative", () => {
  it("converts root to index.md", () => {
    expect(urlPathToMirrorRelative("/")).toBe("index.md");
  });

  it("converts path to .md file", () => {
    expect(urlPathToMirrorRelative("/docs/getting-started")).toBe("docs/getting-started.md");
  });

  it("handles single segment", () => {
    expect(urlPathToMirrorRelative("/about")).toBe("about.md");
  });
});

describe("staticHtmlFileToUrl", () => {
  it("converts index.html to /", () => {
    expect(staticHtmlFileToUrl("/build/index.html", "/build")).toBe("/");
  });

  it("converts nested index.html", () => {
    expect(staticHtmlFileToUrl("/build/docs/start/index.html", "/build")).toBe("/docs/start");
  });

  it("converts non-index .html files", () => {
    expect(staticHtmlFileToUrl("/build/about.html", "/build")).toBe("/about");
  });
});

describe("getUrlDepth", () => {
  it("returns 0 for root", () => {
    expect(getUrlDepth("/")).toBe(0);
  });

  it("returns correct depth for nested paths", () => {
    expect(getUrlDepth("/docs")).toBe(1);
    expect(getUrlDepth("/docs/getting-started")).toBe(2);
    expect(getUrlDepth("/a/b/c/d")).toBe(4);
  });
});

describe("ensureLeadingSlash", () => {
  it("adds slash when missing", () => {
    expect(ensureLeadingSlash("docs")).toBe("/docs");
  });

  it("keeps existing slash", () => {
    expect(ensureLeadingSlash("/docs")).toBe("/docs");
  });
});

describe("joinUrl", () => {
  it("joins base and route", () => {
    expect(joinUrl("http://localhost:4173", "/docs")).toBe("http://localhost:4173/docs");
  });

  it("handles trailing slash on base", () => {
    expect(joinUrl("http://localhost:4173/", "/docs")).toBe("http://localhost:4173/docs");
  });

  it("adds a trailing slash when joining an empty route", () => {
    expect(joinUrl("https://example.com/docs", "")).toBe("https://example.com/docs/");
  });
});
