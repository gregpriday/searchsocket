import { describe, expect, it } from "vitest";
import { createDefaultConfig } from "../src/config/defaults";
import { chunkMirrorPage } from "../src/indexing/chunker";
import type { MirrorPage, Scope } from "../src/types";

const config = createDefaultConfig("sitescribe-test");
const scope: Scope = {
  projectId: "sitescribe-test",
  scopeName: "main",
  scopeId: "sitescribe-test:main"
};

describe("chunkMirrorPage", () => {
  it("creates stable chunk keys and keeps fenced code together", () => {
    const page: MirrorPage = {
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

    const first = chunkMirrorPage(page, config, scope);
    const second = chunkMirrorPage(page, config, scope);

    expect(first.length).toBeGreaterThan(0);
    expect(first.map((chunk) => chunk.chunkKey)).toEqual(second.map((chunk) => chunk.chunkKey));
    expect(first.some((chunk) => chunk.chunkText.includes("```ts"))).toBe(true);
  });
});
