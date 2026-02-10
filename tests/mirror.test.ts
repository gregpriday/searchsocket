import { describe, expect, it } from "vitest";
import { buildMirrorMarkdown } from "../src/indexing/mirror";
import type { MirrorPage } from "../src/types";

describe("buildMirrorMarkdown", () => {
  it("produces valid frontmatter + markdown body", () => {
    const page: MirrorPage = {
      url: "/docs/getting-started",
      title: "Getting Started",
      scope: "main",
      routeFile: "src/routes/docs/getting-started/+page.svelte",
      routeResolution: "exact",
      generatedAt: "2026-01-01T00:00:00.000Z",
      incomingLinks: 5,
      outgoingLinks: 3,
      depth: 2,
      tags: ["docs"],
      markdown: "# Getting Started\n\nWelcome to the docs.\n"
    };

    const output = buildMirrorMarkdown(page);

    expect(output).toContain("---");
    expect(output).toContain('url: "/docs/getting-started"');
    expect(output).toContain('title: "Getting Started"');
    expect(output).toContain('scope: "main"');
    expect(output).toContain('routeFile: "src/routes/docs/getting-started/+page.svelte"');
    expect(output).toContain("incomingLinks: 5");
    expect(output).toContain("outgoingLinks: 3");
    expect(output).toContain("depth: 2");
    expect(output).toContain('tags: ["docs"]');
    expect(output).toContain("# Getting Started");
    expect(output).toContain("Welcome to the docs.");
  });

  it("escapes quotes in title", () => {
    const page: MirrorPage = {
      url: "/test",
      title: 'Say "Hello"',
      scope: "main",
      routeFile: "src/routes/+page.svelte",
      routeResolution: "best-effort",
      generatedAt: "2026-01-01T00:00:00.000Z",
      incomingLinks: 0,
      outgoingLinks: 0,
      depth: 0,
      tags: [],
      markdown: "content\n"
    };

    const output = buildMirrorMarkdown(page);
    expect(output).toContain('title: "Say \\"Hello\\""');
  });
});
