import { afterEach, describe, expect, it, vi } from "vitest";
import { gzipSync } from "node:zlib";
import { createDefaultConfig } from "../src/config/defaults";
import { loadCrawledPages } from "../src/indexing/sources/crawl";

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
      return {
        ok: true,
        text: async () => `<html><body><main><h1>${url}</h1></main></body></html>`
      } as Response;
    });

    const pages = await loadCrawledPages(config);
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
      return {
        ok: true,
        text: async () => `<html><body><main><h1>${String(input)}</h1></main></body></html>`
      } as Response;
    });

    const pages = await loadCrawledPages(config);
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
        return {
          ok: true,
          text: async () => `
            <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
              <url><loc>/docs</loc></url>
              <url><loc>/blog/intro</loc></url>
            </urlset>
          `
        } as Response;
      }

      return {
        ok: true,
        text: async () => `<html><body><main><h1>${url}</h1></main></body></html>`
      } as Response;
    });

    const pages = await loadCrawledPages(config);
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
        return {
          ok: true,
          text: async () => `
            <sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
              <sitemap><loc>/sitemap-a.xml</loc></sitemap>
              <sitemap><loc>https://example.com/sitemap-b.xml</loc></sitemap>
            </sitemapindex>
          `
        } as Response;
      }

      if (url === "https://example.com/sitemap-a.xml") {
        return {
          ok: true,
          text: async () => `
            <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
              <url><loc>https://example.com/docs</loc></url>
              <url><loc>https://example.com/shared</loc></url>
            </urlset>
          `
        } as Response;
      }

      if (url === "https://example.com/sitemap-b.xml") {
        return {
          ok: true,
          text: async () => `
            <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
              <url><loc>https://example.com/shared</loc></url>
              <url><loc>https://example.com/fails</loc></url>
            </urlset>
          `
        } as Response;
      }

      if (url.endsWith("/fails")) {
        return {
          ok: false,
          status: 500,
          statusText: "Server Error"
        } as Response;
      }

      return {
        ok: true,
        text: async () => `<html><body><main><h1>${url}</h1></main></body></html>`
      } as Response;
    });

    const pages = await loadCrawledPages(config);
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
        return {
          ok: true,
          arrayBuffer: async () => gz
        } as unknown as Response;
      }

      return {
        ok: true,
        text: async () => `<html><body><main><h1>${url}</h1></main></body></html>`
      } as Response;
    });

    const pages = await loadCrawledPages(config);
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
      return {
        ok: true,
        text: async () => `<html><body><main><h1>${String(input)}</h1></main></body></html>`
      } as Response;
    });

    const pages = await loadCrawledPages(config, -10);
    expect(pages).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
