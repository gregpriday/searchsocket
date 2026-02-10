import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanMirrorForScope, writeMirrorPage } from "../src/indexing/mirror";
import type { MirrorPage, Scope } from "../src/types";

describe("mirror write/clean lifecycle", () => {
  let cwd = "";
  let statePath = "";
  const scope: Scope = {
    projectId: "mirror-test",
    scopeName: "main",
    scopeId: "mirror-test:main"
  };

  const makePage = (overrides: Partial<MirrorPage> = {}): MirrorPage => ({
    url: "/docs/page",
    title: "Docs Page",
    scope: "main",
    routeFile: "src/routes/docs/page/+page.svelte",
    routeResolution: "exact",
    generatedAt: "2026-01-01T00:00:00.000Z",
    incomingLinks: 2,
    outgoingLinks: 1,
    depth: 2,
    tags: ["docs"],
    markdown: "# Docs\n\nBody text.\n",
    ...overrides
  });

  beforeEach(async () => {
    cwd = await fs.mkdtemp(path.join(os.tmpdir(), "searchsocket-mirror-"));
    statePath = path.join(cwd, ".searchsocket");
  });

  afterEach(async () => {
    if (cwd) {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  it("skips rewriting when only frontmatter generatedAt changes", async () => {
    await writeMirrorPage(
      statePath,
      scope,
      makePage({
        generatedAt: "2026-01-01T00:00:00.000Z"
      })
    );

    await writeMirrorPage(
      statePath,
      scope,
      makePage({
        generatedAt: "2026-01-02T00:00:00.000Z"
      })
    );

    const mirrorFile = path.join(statePath, "pages", scope.scopeName, "docs/page.md");
    const raw = await fs.readFile(mirrorFile, "utf8");
    expect(raw).toContain('generatedAt: "2026-01-01T00:00:00.000Z"');
    expect(raw).not.toContain('generatedAt: "2026-01-02T00:00:00.000Z"');
  });

  it("rewrites when markdown body changes on lines that start with generatedAt", async () => {
    const fixedGeneratedAt = "2026-01-01T00:00:00.000Z";

    await writeMirrorPage(
      statePath,
      scope,
      makePage({
        generatedAt: fixedGeneratedAt,
        markdown: "# Debug\n\ngeneratedAt: body-old\n"
      })
    );

    await writeMirrorPage(
      statePath,
      scope,
      makePage({
        generatedAt: fixedGeneratedAt,
        markdown: "# Debug\n\ngeneratedAt: body-new\n"
      })
    );

    const mirrorFile = path.join(statePath, "pages", scope.scopeName, "docs/page.md");
    const raw = await fs.readFile(mirrorFile, "utf8");
    expect(raw).toContain("generatedAt: body-new");
    expect(raw).not.toContain("generatedAt: body-old");
  });

  it("cleans and recreates the scope mirror directory", async () => {
    await writeMirrorPage(statePath, scope, makePage({ url: "/" }));
    await writeMirrorPage(statePath, scope, makePage({ url: "/docs/other" }));

    await cleanMirrorForScope(statePath, scope);

    const scopeDir = path.join(statePath, "pages", scope.scopeName);
    const entries = await fs.readdir(scopeDir);
    expect(entries).toEqual([]);
  });
});
