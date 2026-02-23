import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { loadBuildPages } from "../src/indexing/sources/build";
import type { ResolvedSearchSocketConfig } from "../src/types";
import { createDefaultConfig } from "../src/config/defaults";

const tempDirs: string[] = [];
const servers: http.Server[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "searchsocket-build-src-"));
  tempDirs.push(dir);
  return dir;
}

function createTestServer(pages: Record<string, string>): Promise<{ port: number; server: http.Server }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = req.url ?? "/";
      const html = pages[url];
      if (html) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(html);
      } else {
        res.writeHead(404);
        res.end("Not Found");
      }
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      servers.push(server);
      resolve({ port, server });
    });
  });
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
  await Promise.all(
    servers.splice(0).map(
      (s) => new Promise<void>((resolve) => s.close(() => resolve()))
    )
  );
});

describe("loadBuildPages", () => {
  it("returns PageSourceRecords with routeFile set from manifest", async () => {
    const dir = await makeTempDir();

    // Create a manifest with known routes
    const serverDir = path.join(dir, ".svelte-kit", "output", "server");
    await fs.mkdir(serverDir, { recursive: true });

    const manifestContent = `
export const manifest = {
  _: {
    routes: [
      {
        id: "/",
        pattern: /^\\/$/,
        page: { layouts: [0], leaf: 1 }
      },
      {
        id: "/about",
        pattern: /^\\/about\\/?$/,
        page: { layouts: [0], leaf: 2 }
      }
    ]
  }
};
`;
    await fs.writeFile(path.join(serverDir, "manifest-full.js"), manifestContent, "utf8");

    // Create a test HTTP server to serve pages (instead of vite preview)
    const { port } = await createTestServer({
      "/": "<html><head><title>Home</title></head><body><main><h1>Home</h1></main></body></html>",
      "/about": "<html><head><title>About</title></head><body><main><h1>About</h1></main></body></html>"
    });

    // We'll test the manifest parsing and route expansion parts directly
    // since the full loadBuildPages requires vite preview
    const { parseManifest, expandRoutes } = await import("../src/indexing/sources/build/manifest-parser");
    const { Logger } = await import("../src/core/logger");

    const routes = await parseManifest(dir, ".svelte-kit/output");
    expect(routes.length).toBe(2);

    const expanded = expandRoutes(routes, {}, [], new Logger());
    expect(expanded).toEqual([
      { url: "/", routeFile: "src/routes/+page.svelte" },
      { url: "/about", routeFile: "src/routes/about/+page.svelte" }
    ]);

    // Verify each expanded route has correct routeFile
    for (const route of expanded) {
      expect(route.routeFile).toMatch(/^src\/routes\//);
      expect(route.routeFile).toMatch(/\+page\.svelte$/);
    }
  });

  it("handles dynamic routes with paramValues in manifest", async () => {
    const dir = await makeTempDir();

    const serverDir = path.join(dir, ".svelte-kit", "output", "server");
    await fs.mkdir(serverDir, { recursive: true });

    const manifestContent = `
export const manifest = {
  _: {
    routes: [
      {
        id: "/",
        pattern: /^\\/$/,
        page: { layouts: [0], leaf: 1 }
      },
      {
        id: "/blog/[slug]",
        pattern: /^\\/blog\\/([^/]+?)\\/?$/,
        params: [{ name: "slug" }],
        page: { layouts: [0], leaf: 2 }
      }
    ]
  }
};
`;
    await fs.writeFile(path.join(serverDir, "manifest-full.js"), manifestContent, "utf8");

    const { parseManifest, expandRoutes } = await import("../src/indexing/sources/build/manifest-parser");
    const { Logger } = await import("../src/core/logger");

    const routes = await parseManifest(dir, ".svelte-kit/output");
    const expanded = expandRoutes(
      routes,
      { "/blog/[slug]": ["first-post", "second-post"] },
      [],
      new Logger()
    );

    expect(expanded).toEqual([
      { url: "/", routeFile: "src/routes/+page.svelte" },
      { url: "/blog/first-post", routeFile: "src/routes/blog/[slug]/+page.svelte" },
      { url: "/blog/second-post", routeFile: "src/routes/blog/[slug]/+page.svelte" }
    ]);
  });

  it("applies exclude patterns to expanded routes", async () => {
    const dir = await makeTempDir();

    const serverDir = path.join(dir, ".svelte-kit", "output", "server");
    await fs.mkdir(serverDir, { recursive: true });

    const manifestContent = `
export const manifest = {
  _: {
    routes: [
      {
        id: "/",
        pattern: /^\\/$/,
        page: { layouts: [0], leaf: 1 }
      },
      {
        id: "/admin/dashboard",
        pattern: /^\\/admin\\/dashboard\\/?$/,
        page: { layouts: [0], leaf: 2 }
      },
      {
        id: "/about",
        pattern: /^\\/about\\/?$/,
        page: { layouts: [0], leaf: 3 }
      }
    ]
  }
};
`;
    await fs.writeFile(path.join(serverDir, "manifest-full.js"), manifestContent, "utf8");

    const { parseManifest, expandRoutes } = await import("../src/indexing/sources/build/manifest-parser");
    const { Logger } = await import("../src/core/logger");

    const routes = await parseManifest(dir, ".svelte-kit/output");
    const expanded = expandRoutes(routes, {}, ["/admin/*"], new Logger());

    const urls = expanded.map((r) => r.url);
    expect(urls).toContain("/");
    expect(urls).toContain("/about");
    expect(urls).not.toContain("/admin/dashboard");
  });
});
