import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectBuildOutput } from "../src/indexing/sources/build/detect-output";
import { loadPrerenderedPages } from "../src/indexing/sources/build/prerendered-fallback";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "searchsocket-detect-"));
  tempDirs.push(dir);
  return dir;
}

async function writeFile(root: string, relPath: string, content = ""): Promise<string> {
  const full = path.join(root, relPath);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content, "utf8");
  return full;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

describe("detectBuildOutput", () => {
  it("returns null when no known adapter output is present", async () => {
    const dir = await makeTempDir();
    expect(await detectBuildOutput(dir)).toBeNull();
  });

  it("detects Vercel output via .vercel/output/config.json", async () => {
    const dir = await makeTempDir();
    await writeFile(dir, ".vercel/output/config.json", "{}");
    await writeFile(dir, ".vercel/output/static/index.html", "<html></html>");

    const result = await detectBuildOutput(dir);
    expect(result?.adapter).toBe("vercel");
    expect(result?.relativePath).toBe(".vercel/output/static");
  });

  it("detects Cloudflare output via _worker.js marker", async () => {
    const dir = await makeTempDir();
    await writeFile(dir, ".svelte-kit/cloudflare/_worker.js", "");
    await writeFile(dir, ".svelte-kit/cloudflare/index.html", "<html></html>");

    const result = await detectBuildOutput(dir);
    expect(result?.adapter).toBe("cloudflare");
    expect(result?.relativePath).toBe(".svelte-kit/cloudflare");
  });

  it("detects node adapter via build/handler.js", async () => {
    const dir = await makeTempDir();
    await writeFile(dir, "build/handler.js", "");
    await writeFile(dir, "build/prerendered/index.html", "<html></html>");

    const result = await detectBuildOutput(dir);
    expect(result?.adapter).toBe("node");
    expect(result?.relativePath).toBe("build/prerendered");
  });

  it("detects Netlify output via .netlify/server marker", async () => {
    const dir = await makeTempDir();
    await writeFile(dir, ".netlify/server/index.js", "");
    await writeFile(dir, "build/index.html", "<html></html>");

    const result = await detectBuildOutput(dir);
    expect(result?.adapter).toBe("netlify");
    expect(result?.relativePath).toBe("build");
  });

  it("falls back to adapter-static when only build/index.html exists", async () => {
    const dir = await makeTempDir();
    await writeFile(dir, "build/index.html", "<html></html>");

    const result = await detectBuildOutput(dir);
    expect(result?.adapter).toBe("static");
  });

  it("prefers Vercel over static when both markers are present", async () => {
    const dir = await makeTempDir();
    await writeFile(dir, ".vercel/output/config.json", "{}");
    await writeFile(dir, ".vercel/output/static/index.html", "");
    await writeFile(dir, "build/index.html", "");

    const result = await detectBuildOutput(dir);
    expect(result?.adapter).toBe("vercel");
  });

  it("respects a custom static dir for the fallback", async () => {
    const dir = await makeTempDir();
    await writeFile(dir, "dist/index.html", "<html></html>");

    const result = await detectBuildOutput(dir, "dist");
    expect(result?.adapter).toBe("static");
    expect(result?.relativePath).toBe("dist");
  });
});

describe("loadPrerenderedPages", () => {
  it("reads HTML files and ignores framework system files", async () => {
    const dir = await makeTempDir();
    const out = path.join(dir, ".vercel/output/static");

    await writeFile(out, "index.html", "<html>home</html>");
    await writeFile(out, "about.html", "<html>about</html>");
    await writeFile(out, "blog/post.html", "<html>post</html>");

    // System files — all must be ignored.
    await writeFile(out, "200.html", "spa-fallback");
    await writeFile(out, "404.html", "not-found");
    await writeFile(out, "fallback.html", "fallback");
    await writeFile(out, "_app/version.json", "{}");
    await writeFile(out, "_app/immutable/nodes/0.js", "js");
    await writeFile(out, "blog/post/__data.json", "{}");

    const pages = await loadPrerenderedPages(dir, out);
    const urls = pages.map((p) => p.url).sort();

    expect(urls).toEqual(["/", "/about", "/blog/post"]);
  });

  it("ignores Cloudflare-specific _worker.js, _routes.json, _headers, _redirects", async () => {
    const dir = await makeTempDir();
    const out = path.join(dir, ".svelte-kit/cloudflare");

    await writeFile(out, "index.html", "<html>home</html>");
    await writeFile(out, "_worker.js/index.js", "worker-code");
    await writeFile(out, "_routes.json", "{}");
    await writeFile(out, "_headers", "");
    await writeFile(out, "_redirects", "");

    const pages = await loadPrerenderedPages(dir, out);
    expect(pages.map((p) => p.url)).toEqual(["/"]);
  });

  it("applies maxPages limit", async () => {
    const dir = await makeTempDir();
    const out = path.join(dir, "build");

    for (let i = 0; i < 5; i++) {
      await writeFile(out, `page${i}.html`, `<html>${i}</html>`);
    }

    const pages = await loadPrerenderedPages(dir, out, 2);
    expect(pages).toHaveLength(2);
  });
});
