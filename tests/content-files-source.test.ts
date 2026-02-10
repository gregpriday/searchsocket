import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDefaultConfig } from "../src/config/defaults";
import { loadContentFilesPages } from "../src/indexing/sources/content-files";

const tempDirs: string[] = [];

async function makeFixture(): Promise<string> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "searchsocket-content-files-"));
  tempDirs.push(cwd);

  await fs.mkdir(path.join(cwd, "src", "routes", "docs", "[slug]"), { recursive: true });
  await fs.mkdir(path.join(cwd, "src", "routes", "docs", "[...rest]"), { recursive: true });
  await fs.mkdir(path.join(cwd, "src", "routes", "docs", "[[optional]]"), { recursive: true });
  await fs.mkdir(path.join(cwd, "src", "routes", "(marketing)", "pricing"), { recursive: true });
  await fs.mkdir(path.join(cwd, "content", "guides", "intro"), { recursive: true });

  await fs.writeFile(path.join(cwd, "src", "routes", "+page.svelte"), "<main>Home</main>", "utf8");
  await fs.writeFile(
    path.join(cwd, "src", "routes", "docs", "[slug]", "+page.svelte"),
    "<main>Doc slug page</main>",
    "utf8"
  );
  await fs.writeFile(
    path.join(cwd, "src", "routes", "docs", "[...rest]", "+page.svelte"),
    "<main>Doc rest page</main>",
    "utf8"
  );
  await fs.writeFile(
    path.join(cwd, "src", "routes", "docs", "[[optional]]", "+page.svelte"),
    "<main>Doc optional page</main>",
    "utf8"
  );
  await fs.writeFile(
    path.join(cwd, "src", "routes", "(marketing)", "pricing", "+page.svelte"),
    "<main>Pricing</main>",
    "utf8"
  );
  await fs.writeFile(path.join(cwd, "content", "guides", "intro", "index.md"), "# Intro\n", "utf8");

  return cwd;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("loadContentFilesPages", () => {
  it("maps Svelte route files to URL paths when baseDir is project root", async () => {
    const cwd = await makeFixture();
    const config = createDefaultConfig("searchsocket-content-test");
    config.source.mode = "content-files";
    config.source.contentFiles = {
      globs: ["src/routes/**/+page.svelte"],
      baseDir: cwd
    };

    const pages = await loadContentFilesPages(cwd, config);
    const urls = new Set(pages.map((page) => page.url));

    expect(urls.has("/")).toBe(true);
    expect(urls.has("/docs/param")).toBe(true);
    expect(urls.has("/docs/splat")).toBe(true);
    expect(urls.has("/docs/optional")).toBe(true);
    expect(urls.has("/pricing")).toBe(true);
    expect(urls.has("/src/routes")).toBe(false);
  });

  it("maps root +page.svelte to / when baseDir is src/routes", async () => {
    const cwd = await makeFixture();
    const config = createDefaultConfig("searchsocket-content-test");
    config.source.mode = "content-files";
    config.source.contentFiles = {
      globs: ["**/+page.svelte"],
      baseDir: path.join(cwd, "src", "routes")
    };

    const pages = await loadContentFilesPages(cwd, config);
    const urls = new Set(pages.map((page) => page.url));

    expect(urls.has("/")).toBe(true);
    expect(urls.has("/+page.svelte")).toBe(false);
  });

  it("maps markdown index files to clean route URLs", async () => {
    const cwd = await makeFixture();
    const config = createDefaultConfig("searchsocket-content-test");
    config.source.mode = "content-files";
    config.source.contentFiles = {
      globs: ["content/**/*.md"],
      baseDir: cwd
    };

    const pages = await loadContentFilesPages(cwd, config);
    const urls = new Set(pages.map((page) => page.url));

    expect(urls.has("/content/guides/intro")).toBe(true);
    expect(urls.has("/content/guides/intro/index")).toBe(false);
  });

  it("treats negative maxPages as zero", async () => {
    const cwd = await makeFixture();
    const config = createDefaultConfig("searchsocket-content-test");
    config.source.mode = "content-files";
    config.source.contentFiles = {
      globs: ["src/routes/**/+page.svelte"],
      baseDir: cwd
    };

    const pages = await loadContentFilesPages(cwd, config, -1);
    expect(pages).toEqual([]);
  });

  it("floors fractional maxPages values", async () => {
    const cwd = await makeFixture();
    const config = createDefaultConfig("searchsocket-content-test");
    config.source.mode = "content-files";
    config.source.contentFiles = {
      globs: ["src/routes/**/+page.svelte"],
      baseDir: cwd
    };

    const pages = await loadContentFilesPages(cwd, config, 2.9);
    expect(pages).toHaveLength(2);
  });
});
