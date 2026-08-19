import { afterEach, describe, expect, it, vi } from "vitest";
import { gzipSync } from "node:zlib";
import { createDefaultConfig } from "../src/config/defaults";
import { loadCrawledPages } from "../src/indexing/sources/crawl";


/**
 * A mock Response with the fields `safeFetch` reads: status, headers, and a
 * real body. The crawler now enforces timeouts, size caps, content types, and
 * a same-origin redirect policy, so a `{ ok, text }` stub is no longer enough.
 */
function mockResponse(
  body: string | Buffer,
  init: { status?: number; contentType?: string; location?: string } = {}
): Response {
  const buffer = typeof body === "string" ? Buffer.from(body, "utf8") : body;
  const headers = new Headers();
  headers.set("content-type", init.contentType ?? "text/html; charset=utf-8");
  headers.set("content-length", String(buffer.byteLength));
  if (init.location) headers.set("location", init.location);

  const status = init.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    headers,
    text: async () => buffer.toString("utf8"),
    arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
  } as unknown as Response;
}

describe("loadCrawledPages", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fetches explicit routes and returns normalized page urls", async () => {
    const config = createDefaultConfig("crawl-test");
    config.source.mode = "crawl";
    config.source.crawl = {
      baseUrl: "https://example.com",
      routes: ["/docs", "/docs/getting-started"],
      sitemapUrl: undefined
    };

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: string | URL | Request) => {
      const url = String(input);
      return mockResponse(`<html><body><main><h1>${url}</h1></main></body></html>`);
    });

    const pages = (await loadCrawledPages(config)).records;
    expect(pages.map((page) => page.url)).toEqual(["/docs", "/docs/getting-started"]);
  });

  it("normalizes and deduplicates explicit routes before crawling", async () => {
    const config = createDefaultConfig("crawl-test");
    config.source.mode = "crawl";
    config.source.crawl = {
      baseUrl: "https://example.com",
      routes: ["/docs", "/docs/", "docs", "/docs//", "/blog/"],
      sitemapUrl: undefined
    };

    const seen = new Set<string>();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: string | URL | Request) => {
      seen.add(String(input));
      return mockResponse(`<html><body><main><h1>${String(input)}</h1></main></body></html>`);
    });

    const pages = (await loadCrawledPages(config)).records;
    expect(pages.map((page) => page.url).sort()).toEqual(["/blog", "/docs"]);
    expect(seen).toEqual(new Set(["https://example.com/docs", "https://example.com/blog"]));
  });

  it("parses relative sitemap <loc> entries against baseUrl", async () => {
    const config = createDefaultConfig("crawl-test");
    config.source.mode = "crawl";
    config.source.crawl = {
      baseUrl: "https://example.com",
      routes: [],
      sitemapUrl: "/sitemap.xml"
    };

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: string | URL | Request) => {
      const url = String(input);

      if (url === "https://example.com/sitemap.xml") {
        return mockResponse(`
            <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
              <url><loc>/docs</loc></url>
              <url><loc>/blog/intro</loc></url>
            </urlset>
          `);
      }

      return mockResponse(`<html><body><main><h1>${url}</h1></main></body></html>`);
    });

    const pages = (await loadCrawledPages(config)).records;
    expect(pages.map((page) => page.url).sort()).toEqual(["/blog/intro", "/docs"]);
  });

  it("resolves sitemap indexes, deduplicates routes, and skips failed page fetches", async () => {
    const config = createDefaultConfig("crawl-test");
    config.source.mode = "crawl";
    config.source.crawl = {
      baseUrl: "https://example.com",
      routes: [],
      sitemapUrl: "/sitemap-index.xml"
    };

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: string | URL | Request) => {
      const url = String(input);

      if (url === "https://example.com/sitemap-index.xml") {
        return mockResponse(`
            <sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
              <sitemap><loc>/sitemap-a.xml</loc></sitemap>
              <sitemap><loc>https://example.com/sitemap-b.xml</loc></sitemap>
            </sitemapindex>
          `);
      }

      if (url === "https://example.com/sitemap-a.xml") {
        return mockResponse(`
            <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
              <url><loc>https://example.com/docs</loc></url>
              <url><loc>https://example.com/shared</loc></url>
            </urlset>
          `);
      }

      if (url === "https://example.com/sitemap-b.xml") {
        return mockResponse(`
            <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
              <url><loc>https://example.com/shared</loc></url>
              <url><loc>https://example.com/fails</loc></url>
            </urlset>
          `);
      }

      if (url.endsWith("/fails")) {
        return {
          ok: false,
          status: 500,
          statusText: "Server Error"
        } as Response;
      }

      return mockResponse(`<html><body><main><h1>${url}</h1></main></body></html>`);
    });

    const pages = (await loadCrawledPages(config)).records;
    expect(pages.map((page) => page.url).sort()).toEqual(["/docs", "/shared"]);
  });

  it("supports gzipped sitemap files", async () => {
    const config = createDefaultConfig("crawl-test");
    config.source.mode = "crawl";
    config.source.crawl = {
      baseUrl: "https://example.com",
      routes: [],
      sitemapUrl: "/sitemap.xml.gz"
    };

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: string | URL | Request) => {
      const url = String(input);

      if (url === "https://example.com/sitemap.xml.gz") {
        const xml = `
          <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
            <url><loc>https://example.com/docs</loc></url>
          </urlset>
        `;
        const gz = gzipSync(Buffer.from(xml, "utf8"));
        return mockResponse(gz, { contentType: "application/gzip" });
      }

      return mockResponse(`<html><body><main><h1>${url}</h1></main></body></html>`);
    });

    const pages = (await loadCrawledPages(config)).records;
    expect(pages.map((page) => page.url)).toEqual(["/docs"]);
  });

  it("treats negative maxPages as zero", async () => {
    const config = createDefaultConfig("crawl-test");
    config.source.mode = "crawl";
    config.source.crawl = {
      baseUrl: "https://example.com",
      routes: ["/docs", "/blog"],
      sitemapUrl: undefined
    };

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: string | URL | Request) => {
      return mockResponse(`<html><body><main><h1>${String(input)}</h1></main></body></html>`);
    });

    const pages = (await loadCrawledPages(config, -10)).records;
    expect(pages).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("handles cyclic sitemap indexes without infinite recursion", async () => {
    const config = createDefaultConfig("crawl-test");
    config.source.mode = "crawl";
    config.source.crawl = {
      baseUrl: "https://example.com",
      routes: [],
      sitemapUrl: "/sitemap.xml"
    };

    let sitemapFetches = 0;

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: string | URL | Request) => {
      const url = String(input);

      if (url === "https://example.com/sitemap.xml") {
        sitemapFetches += 1;
        if (sitemapFetches > 3) {
          throw new Error("cyclic sitemap recursion was not stopped");
        }

        return mockResponse(`
            <sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
              <sitemap><loc>/sitemap.xml</loc></sitemap>
              <sitemap><loc>/leaf.xml</loc></sitemap>
            </sitemapindex>
          `);
      }

      if (url === "https://example.com/leaf.xml") {
        return mockResponse(`
            <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
              <url><loc>https://example.com/docs</loc></url>
            </urlset>
          `);
      }

      return mockResponse("<html><body><main><h1>docs</h1></main></body></html>");
    });

    const pages = (await loadCrawledPages(config)).records;
    expect(pages.map((page) => page.url)).toEqual(["/docs"]);
    expect(sitemapFetches).toBe(1);
  });

  it("fetches duplicate child sitemaps only once", async () => {
    const config = createDefaultConfig("crawl-test");
    config.source.mode = "crawl";
    config.source.crawl = {
      baseUrl: "https://example.com",
      routes: [],
      sitemapUrl: "/index.xml"
    };

    let childFetches = 0;

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: string | URL | Request) => {
      const url = String(input);

      if (url === "https://example.com/index.xml") {
        return mockResponse(`
            <sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
              <sitemap><loc>/child.xml</loc></sitemap>
              <sitemap><loc>https://example.com/child.xml</loc></sitemap>
            </sitemapindex>
          `);
      }

      if (url === "https://example.com/child.xml") {
        childFetches += 1;
        return mockResponse(`
            <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
              <url><loc>https://example.com/docs</loc></url>
            </urlset>
          `);
      }

      return mockResponse("<html><body><main>Docs</main></body></html>");
    });

    const pages = (await loadCrawledPages(config)).records;
    expect(pages.map((page) => page.url)).toEqual(["/docs"]);
    expect(childFetches).toBe(1);
  });

  it("falls back to crawling root when no routes or sitemap are configured", async () => {
    const config = createDefaultConfig("crawl-test");
    config.source.mode = "crawl";
    config.source.crawl = {
      baseUrl: "https://example.com",
      routes: [],
      sitemapUrl: undefined
    };

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: string | URL | Request) => {
      expect(String(input)).toBe("https://example.com/");
      return mockResponse("<html><body><main><h1>Home</h1></main></body></html>");
    });

    const pages = (await loadCrawledPages(config)).records;
    expect(pages.map((page) => page.url)).toEqual(["/"]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("floors maxPages to an integer before route selection", async () => {
    const config = createDefaultConfig("crawl-test");
    config.source.mode = "crawl";
    config.source.crawl = {
      baseUrl: "https://example.com",
      routes: ["/a", "/b", "/c"],
      sitemapUrl: undefined
    };

    const seen: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: string | URL | Request) => {
      seen.push(String(input));
      return mockResponse("<html><body><main><h1>ok</h1></main></body></html>");
    });

    const pages = (await loadCrawledPages(config, 1.9)).records;
    expect(pages.map((page) => page.url)).toEqual(["/a"]);
    expect(seen).toEqual(["https://example.com/a"]);
  });

  it("ignores non-http(s) sitemap loc entries", async () => {
    const config = createDefaultConfig("crawl-test");
    config.source.mode = "crawl";
    config.source.crawl = {
      baseUrl: "https://example.com",
      routes: [],
      sitemapUrl: "/sitemap.xml"
    };

    const requested: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: string | URL | Request) => {
      const url = String(input);
      requested.push(url);

      if (url === "https://example.com/sitemap.xml") {
        return mockResponse(`
            <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
              <url><loc>https://example.com/docs</loc></url>
              <url><loc>ftp://example.com/private</loc></url>
              <url><loc>mailto:admin@example.com</loc></url>
            </urlset>
          `);
      }

      return mockResponse("<html><body><main>ok</main></body></html>");
    });

    const pages = (await loadCrawledPages(config)).records;
    expect(pages.map((page) => page.url)).toEqual(["/docs"]);
    expect(requested).toEqual(["https://example.com/sitemap.xml", "https://example.com/docs"]);
  });
});
