import { describe, expect, it } from "vitest";
import { buildResultUrl } from "../src/client";
import type { SearchResult } from "../src/types";

function makeResult(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    url: "/docs/getting-started",
    title: "Getting Started",
    snippet: "Welcome to the docs",
    score: 0.95,
    routeFile: "src/routes/docs/getting-started/+page.svelte",
    ...overrides
  };
}

describe("buildResultUrl", () => {
  it("returns url unchanged when sectionTitle is absent", () => {
    const result = makeResult();
    expect(buildResultUrl(result)).toBe("/docs/getting-started");
  });

  it("returns url unchanged when sectionTitle is undefined", () => {
    const result = makeResult({ sectionTitle: undefined });
    expect(buildResultUrl(result)).toBe("/docs/getting-started");
  });

  it("appends _ss param and text fragment when sectionTitle is present", () => {
    const result = makeResult({ sectionTitle: "Installation" });
    const url = buildResultUrl(result);
    expect(url).toContain("_ss=Installation");
    expect(url).toContain("#:~:text=Installation");
  });

  it("encodes special characters in sectionTitle", () => {
    const result = makeResult({ sectionTitle: "Quick Start & Setup" });
    const url = buildResultUrl(result);
    expect(url).toContain("_ss=Quick+Start+%26+Setup");
    expect(url).toContain(":~:text=Quick%20Start%20%26%20Setup");
  });

  it("preserves existing query params", () => {
    const result = makeResult({
      url: "/docs/intro?version=2",
      sectionTitle: "Overview"
    });
    const url = buildResultUrl(result);
    expect(url).toContain("version=2");
    expect(url).toContain("_ss=Overview");
  });

  it("preserves existing hash and appends text fragment", () => {
    const result = makeResult({
      url: "/docs/intro#existing",
      sectionTitle: "Overview"
    });
    const url = buildResultUrl(result);
    expect(url).toContain("#existing");
    expect(url).toContain(":~:text=Overview");
    expect(url).toContain("_ss=Overview");
  });

  it("handles absolute URLs", () => {
    const result = makeResult({
      url: "https://example.com/docs/intro",
      sectionTitle: "Setup"
    });
    const url = buildResultUrl(result);
    expect(url).toContain("https://example.com/docs/intro");
    expect(url).toContain("_ss=Setup");
    expect(url).toContain(":~:text=Setup");
  });

  it("handles absolute URL with existing query params", () => {
    const result = makeResult({
      url: "https://example.com/docs?v=3",
      sectionTitle: "Config"
    });
    const url = buildResultUrl(result);
    expect(url).toContain("v=3");
    expect(url).toContain("_ss=Config");
    expect(url.startsWith("https://example.com")).toBe(true);
  });

  it("handles root path", () => {
    const result = makeResult({
      url: "/",
      sectionTitle: "Welcome"
    });
    const url = buildResultUrl(result);
    expect(url).toContain("/?_ss=Welcome");
  });

  it("handles sectionTitle with unicode characters", () => {
    const result = makeResult({
      url: "/docs/i18n",
      sectionTitle: "Überblick 日本語"
    });
    const url = buildResultUrl(result);
    expect(url).toContain("_ss=");
    // Decode the _ss param from the query portion
    const hashIdx = url.indexOf("#");
    const queryPart = hashIdx >= 0 ? url.slice(0, hashIdx) : url;
    const parsed = new URL(queryPart, "http://placeholder");
    expect(parsed.searchParams.get("_ss")).toBe("Überblick 日本語");
  });

  it("preserves relative URL form without leading slash", () => {
    const result = makeResult({
      url: "docs/intro",
      sectionTitle: "Setup"
    });
    const url = buildResultUrl(result);
    expect(url.startsWith("docs/intro?")).toBe(true);
    expect(url).toContain("_ss=Setup");
  });

  it("replaces existing _ss param instead of duplicating", () => {
    const result = makeResult({
      url: "/docs/intro?_ss=Old",
      sectionTitle: "New"
    });
    const url = buildResultUrl(result);
    expect(url).toContain("_ss=New");
    expect(url).not.toContain("_ss=Old");
  });
});
