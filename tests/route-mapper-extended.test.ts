import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildRoutePatterns, mapUrlToRoute } from "../src/indexing/route-mapper";

const tempDirs: string[] = [];

async function makeTempProject(files: string[]): Promise<string> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "searchsocket-routes-ext-"));
  tempDirs.push(tempDir);

  for (const file of files) {
    const target = path.join(tempDir, file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, "<main>route</main>\n", "utf8");
  }

  return tempDir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("route mapper - layout groups", () => {
  it("ignores layout group segments in URL matching", async () => {
    const cwd = await makeTempProject([
      "src/routes/(app)/dashboard/+page.svelte",
      "src/routes/(app)/settings/+page.svelte",
      "src/routes/(marketing)/+page.svelte"
    ]);

    const patterns = await buildRoutePatterns(cwd);

    expect(mapUrlToRoute("/dashboard", patterns).routeFile).toBe(
      "src/routes/(app)/dashboard/+page.svelte"
    );
    expect(mapUrlToRoute("/settings", patterns).routeFile).toBe(
      "src/routes/(app)/settings/+page.svelte"
    );
    expect(mapUrlToRoute("/", patterns).routeFile).toBe(
      "src/routes/(marketing)/+page.svelte"
    );
  });
});

describe("route mapper - dynamic params", () => {
  it("matches [slug] dynamic segments", async () => {
    const cwd = await makeTempProject([
      "src/routes/blog/+page.svelte",
      "src/routes/blog/[slug]/+page.svelte"
    ]);

    const patterns = await buildRoutePatterns(cwd);

    expect(mapUrlToRoute("/blog", patterns).routeFile).toBe("src/routes/blog/+page.svelte");
    expect(mapUrlToRoute("/blog/my-post", patterns).routeFile).toBe(
      "src/routes/blog/[slug]/+page.svelte"
    );
  });

  it("prefers static over dynamic segments", async () => {
    const cwd = await makeTempProject([
      "src/routes/blog/[slug]/+page.svelte",
      "src/routes/blog/featured/+page.svelte"
    ]);

    const patterns = await buildRoutePatterns(cwd);

    expect(mapUrlToRoute("/blog/featured", patterns).routeFile).toBe(
      "src/routes/blog/featured/+page.svelte"
    );
    expect(mapUrlToRoute("/blog/other", patterns).routeFile).toBe(
      "src/routes/blog/[slug]/+page.svelte"
    );
  });
});

describe("route mapper - rest params", () => {
  it("matches [...rest] catch-all segments", async () => {
    const cwd = await makeTempProject([
      "src/routes/+page.svelte",
      "src/routes/docs/[...rest]/+page.svelte"
    ]);

    const patterns = await buildRoutePatterns(cwd);

    expect(mapUrlToRoute("/docs/a/b/c", patterns).routeFile).toBe(
      "src/routes/docs/[...rest]/+page.svelte"
    );
    expect(mapUrlToRoute("/docs/getting-started", patterns).routeFile).toBe(
      "src/routes/docs/[...rest]/+page.svelte"
    );
  });
});

describe("route mapper - optional params", () => {
  it("matches [[optional]] segments", async () => {
    const cwd = await makeTempProject([
      "src/routes/lang/[[locale]]/+page.svelte"
    ]);

    const patterns = await buildRoutePatterns(cwd);

    expect(mapUrlToRoute("/lang", patterns).routeFile).toBe(
      "src/routes/lang/[[locale]]/+page.svelte"
    );
    expect(mapUrlToRoute("/lang/en", patterns).routeFile).toBe(
      "src/routes/lang/[[locale]]/+page.svelte"
    );
  });
});

describe("route mapper - resolution types", () => {
  it("returns exact for matched routes", async () => {
    const cwd = await makeTempProject(["src/routes/about/+page.svelte"]);
    const patterns = await buildRoutePatterns(cwd);

    const result = mapUrlToRoute("/about", patterns);
    expect(result.routeResolution).toBe("exact");
  });

  it("returns best-effort for unmatched routes", async () => {
    const cwd = await makeTempProject(["src/routes/+page.svelte"]);
    const patterns = await buildRoutePatterns(cwd);

    const result = mapUrlToRoute("/unknown/path", patterns);
    expect(result.routeResolution).toBe("best-effort");
    expect(result.routeFile).toBe("src/routes/+page.svelte");
  });

  it("returns best-effort fallback even without root route", async () => {
    const cwd = await makeTempProject(["src/routes/about/+page.svelte"]);
    const patterns = await buildRoutePatterns(cwd);

    const result = mapUrlToRoute("/nonexistent", patterns);
    expect(result.routeResolution).toBe("best-effort");
  });
});

describe("route mapper - deeply nested", () => {
  it("handles deeply nested routes", async () => {
    const cwd = await makeTempProject([
      "src/routes/+page.svelte",
      "src/routes/docs/+page.svelte",
      "src/routes/docs/guides/+page.svelte",
      "src/routes/docs/guides/advanced/+page.svelte"
    ]);

    const patterns = await buildRoutePatterns(cwd);

    expect(mapUrlToRoute("/docs/guides/advanced", patterns).routeFile).toBe(
      "src/routes/docs/guides/advanced/+page.svelte"
    );
    expect(mapUrlToRoute("/docs/guides", patterns).routeFile).toBe(
      "src/routes/docs/guides/+page.svelte"
    );
  });
});
