import { gunzipSync } from "node:zlib";
import pLimit from "p-limit";
import type { PageSourceRecord, ResolvedSearchSocketConfig } from "../../types";
import { ensureLeadingSlash, joinUrl, normalizeUrlPath } from "../../utils/path";

function extractLocs(xml: string): string[] {
  const locs: string[] = [];
  const regex = /<loc>(.*?)<\/loc>/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(xml)) !== null) {
    const loc = match[1];
    if (loc) {
      locs.push(loc);
    }
  }

  return locs;
}

function isSitemapIndex(xml: string): boolean {
  return /<sitemapindex[\s>]/i.test(xml);
}

async function fetchSitemapXml(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch sitemap ${url}: ${res.status} ${res.statusText}`);
  }

  if (url.endsWith(".gz")) {
    const buffer = Buffer.from(await res.arrayBuffer());
    return gunzipSync(buffer).toString("utf8");
  }

  return res.text();
}

async function parseSitemap(xml: string, baseUrl: string): Promise<string[]> {
  if (isSitemapIndex(xml)) {
    const childUrls = extractLocs(xml);
    const routes: string[] = [];

    for (const childUrl of childUrls) {
      const resolved = childUrl.startsWith("http") ? childUrl : joinUrl(baseUrl, childUrl);
      const childXml = await fetchSitemapXml(resolved);
      const childRoutes = await parseSitemap(childXml, baseUrl);
      routes.push(...childRoutes);
    }

    return [...new Set(routes)];
  }

  const locs = extractLocs(xml);
  const routes: string[] = [];

  for (const loc of locs) {
    try {
      const url = new URL(loc);
      routes.push(normalizeUrlPath(url.pathname));
    } catch {
      // ignore invalid entry
    }
  }

  return [...new Set(routes)];
}

async function resolveRoutes(config: ResolvedSearchSocketConfig): Promise<string[]> {
  const crawlConfig = config.source.crawl;
  if (!crawlConfig) {
    return [];
  }

  if (crawlConfig.routes.length > 0) {
    return [...new Set(crawlConfig.routes.map(ensureLeadingSlash))];
  }

  if (!crawlConfig.sitemapUrl) {
    return ["/"];
  }

  const sitemapUrl = crawlConfig.sitemapUrl.startsWith("http")
    ? crawlConfig.sitemapUrl
    : joinUrl(crawlConfig.baseUrl, crawlConfig.sitemapUrl);

  const xml = await fetchSitemapXml(sitemapUrl);
  return parseSitemap(xml, crawlConfig.baseUrl);
}

export async function loadCrawledPages(
  config: ResolvedSearchSocketConfig,
  maxPages?: number
): Promise<PageSourceRecord[]> {
  const crawlConfig = config.source.crawl;
  if (!crawlConfig) {
    throw new Error("crawl source config is missing");
  }

  const routes = await resolveRoutes(config);
  const selected = typeof maxPages === "number" ? routes.slice(0, maxPages) : routes;

  const limit = pLimit(8);
  const pages = await Promise.all(
    selected.map((route) =>
      limit(async () => {
        const url = joinUrl(crawlConfig.baseUrl, route);
        const response = await fetch(url);

        if (!response.ok) {
          throw new Error(`Failed to fetch route ${route}: ${response.status} ${response.statusText}`);
        }

        return {
          url: normalizeUrlPath(route),
          html: await response.text(),
          sourcePath: url,
          outgoingLinks: []
        } satisfies PageSourceRecord;
      })
    )
  );

  return pages;
}
