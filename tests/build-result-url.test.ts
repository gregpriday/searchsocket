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
  it("uses snippet text target when sectionTitle is absent", () => {
    const result = makeResult();
    const url = buildResultUrl(result);
    expect(url).toContain("_sskt=Welcome+to+the+docs");
    expect(url).not.toContain("_ssk=");
  });

  it("returns url unchanged when no text target is available", () => {
    const result = makeResult({ sectionTitle: undefined, snippet: "   " });
    expect(buildResultUrl(result)).toBe("/docs/getting-started");
  });

  it("appends _ssk/_sskt params and text fragment when sectionTitle is present", () => {
    const result = makeResult({ sectionTitle: "Installation" });
    const url = buildResultUrl(result);
    expect(url).toContain("_ssk=Installation");
    expect(url).toContain("_sskt=Installation");
    expect(url).toContain("#:~:text=Installation");
  });

  it("encodes special characters in sectionTitle", () => {
    const result = makeResult({ sectionTitle: "Quick Start & Setup" });
    const url = buildResultUrl(result);
    expect(url).toContain("_ssk=Quick+Start+%26+Setup");
    expect(url).toContain("_sskt=Quick+Start+%26+Setup");
    expect(url).toContain(":~:text=Quick%20Start%20%26%20Setup");
  });

  it("preserves existing query params", () => {
    const result = makeResult({
      url: "/docs/intro?version=2",
      sectionTitle: "Overview"
    });
    const url = buildResultUrl(result);
    expect(url).toContain("version=2");
    expect(url).toContain("_ssk=Overview");
    expect(url).toContain("_sskt=Overview");
  });

  it("preserves existing hash and appends text fragment", () => {
    const result = makeResult({
      url: "/docs/intro#existing",
      sectionTitle: "Overview"
    });
    const url = buildResultUrl(result);
    expect(url).toContain("#existing");
    expect(url).toContain(":~:text=Overview");
    expect(url).toContain("_ssk=Overview");
    expect(url).toContain("_sskt=Overview");
  });

  it("handles absolute URLs", () => {
    const result = makeResult({
      url: "https://example.com/docs/intro",
      sectionTitle: "Setup"
    });
    const url = buildResultUrl(result);
    expect(url).toContain("https://example.com/docs/intro");
    expect(url).toContain("_ssk=Setup");
    expect(url).toContain("_sskt=Setup");
    expect(url).toContain(":~:text=Setup");
  });

  it("handles absolute URL with existing query params", () => {
    const result = makeResult({
      url: "https://example.com/docs?v=3",
      sectionTitle: "Config"
    });
    const url = buildResultUrl(result);
    expect(url).toContain("v=3");
    expect(url).toContain("_ssk=Config");
    expect(url).toContain("_sskt=Config");
    expect(url.startsWith("https://example.com")).toBe(true);
  });

  it("handles root path", () => {
    const result = makeResult({
      url: "/",
      sectionTitle: "Welcome",
      snippet: "Landing page intro"
    });
    const url = buildResultUrl(result);
    expect(url).toContain("/?_ssk=Welcome");
    expect(url).toContain("_sskt=Welcome");
  });

  it("handles sectionTitle with unicode characters", () => {
    const result = makeResult({
      url: "/docs/i18n",
      sectionTitle: "Überblick 日本語"
    });
    const url = buildResultUrl(result);
    expect(url).toContain("_ssk=");
    expect(url).toContain("_sskt=");
    // Decode the _ssk/_sskt params from the query portion
    const hashIdx = url.indexOf("#");
    const queryPart = hashIdx >= 0 ? url.slice(0, hashIdx) : url;
    const parsed = new URL(queryPart, "http://placeholder");
    expect(parsed.searchParams.get("_ssk")).toBe("Überblick 日本語");
    expect(parsed.searchParams.get("_sskt")).toBe("Überblick 日本語");
  });

  it("preserves relative URL form without leading slash", () => {
    const result = makeResult({
      url: "docs/intro",
      sectionTitle: "Setup"
    });
    const url = buildResultUrl(result);
    expect(url.startsWith("docs/intro?")).toBe(true);
    expect(url).toContain("_ssk=Setup");
    expect(url).toContain("_sskt=Setup");
  });

  it("replaces existing scroll params instead of duplicating", () => {
    const result = makeResult({
      url: "/docs/intro?_ssk=Older&_sskt=Old+Target",
      sectionTitle: "New"
    });
    const url = buildResultUrl(result);
    expect(url).toContain("_ssk=New");
    expect(url).toContain("_sskt=New");
    expect(url).not.toContain("_ssk=Older");
    expect(url).not.toContain("_sskt=Old+Target");
  });

  it("uses snippet text for _sskt when snippet aligns with section title", () => {
    const result = makeResult({
      sectionTitle: "Installation",
      snippet: "Installation guide and setup steps for macOS and Linux users."
    });
    const url = buildResultUrl(result);
    expect(url).toContain("_ssk=Installation");
    expect(url).toContain("_sskt=Installation+guide+and+setup+steps+for+macOS+and+Linux+users.");
    expect(url).toContain(":~:text=Installation%20guide%20and%20setup%20steps%20for%20macOS%20and%20Linux%20users.");
  });
});
