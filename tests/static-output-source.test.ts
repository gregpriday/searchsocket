import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDefaultConfig } from "../src/config/defaults";
import { loadStaticOutputPages } from "../src/indexing/sources/static-output";

describe("loadStaticOutputPages", () => {
  let cwd = "";

  beforeEach(async () => {
    cwd = await fs.mkdtemp(path.join(os.tmpdir(), "searchsocket-static-output-"));
  });

  afterEach(async () => {
    if (cwd) {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  it("maps static html files to canonical URL paths", async () => {
    await fs.mkdir(path.join(cwd, "build", "docs"), { recursive: true });
    await fs.writeFile(path.join(cwd, "build", "index.html"), "<main>home</main>", "utf8");
    await fs.writeFile(path.join(cwd, "build", "docs", "index.html"), "<main>docs</main>", "utf8");
    await fs.writeFile(path.join(cwd, "build", "docs", "api.html"), "<main>api</main>", "utf8");

    const config = createDefaultConfig("static-output");
    config.source.mode = "static-output";
    config.source.staticOutputDir = "build";

    const pages = await loadStaticOutputPages(cwd, config);
    const byUrl = new Map(pages.map((page) => [page.url, page]));

    expect(byUrl.get("/")?.sourcePath).toBe("build/index.html");
    expect(byUrl.get("/docs")?.sourcePath).toBe("build/docs/index.html");
    expect(byUrl.get("/docs/api")?.sourcePath).toBe("build/docs/api.html");
  });

  it("returns no pages when maxPages is zero", async () => {
    await fs.mkdir(path.join(cwd, "build"), { recursive: true });
    await fs.writeFile(path.join(cwd, "build", "index.html"), "<main>home</main>", "utf8");

    const config = createDefaultConfig("static-output");
    config.source.mode = "static-output";
    config.source.staticOutputDir = "build";

    const pages = await loadStaticOutputPages(cwd, config, 0);
    expect(pages).toEqual([]);
  });

  it("treats negative maxPages as zero instead of slicing from the end", async () => {
    await fs.mkdir(path.join(cwd, "build"), { recursive: true });
    await fs.writeFile(path.join(cwd, "build", "index.html"), "<main>home</main>", "utf8");
    await fs.writeFile(path.join(cwd, "build", "docs.html"), "<main>docs</main>", "utf8");

    const config = createDefaultConfig("static-output");
    config.source.mode = "static-output";
    config.source.staticOutputDir = "build";

    const pages = await loadStaticOutputPages(cwd, config, -1);
    expect(pages).toEqual([]);
  });
});
