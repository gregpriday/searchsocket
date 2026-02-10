import { gunzipSync } from "node:zlib";
import { load as cheerioLoad } from "cheerio";
import pLimit from "p-limit";
import { Logger } from "../../core/logger";
import type { PageSourceRecord, ResolvedSearchSocketConfig } from "../../types";
import { ensureLeadingSlash, joinUrl, normalizeUrlPath } from "../../utils/path";

const logger = new Logger();

function extractLocs(xml: string): string[] {
  const $ = cheerioLoad(xml, { xmlMode: true });
  const locs: string[] = [];
  $("loc").each((_i, el) => {
    const text = $(el).text().trim();
    if (text) {
      locs.push(text);
    }
  });
  return locs;
}

function isSitemapIndex(xml: string): boolean {
  const $ = cheerioLoad(xml, { xmlMode: true });
  return $("sitemapindex").length > 0;
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
      const parsed = loc.startsWith("http://") || loc.startsWith("https://")
        ? new URL(loc)
        : new URL(loc, baseUrl);
      routes.push(normalizeUrlPath(parsed.pathname));
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
    return [...new Set(crawlConfig.routes.map((route) => normalizeUrlPath(ensureLeadingSlash(route))))];
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
  const maxCount = typeof maxPages === "number" ? Math.max(0, Math.floor(maxPages)) : undefined;
  const selected = typeof maxCount === "number" ? routes.slice(0, maxCount) : routes;

  const concurrencyLimit = pLimit(8);
  const results = await Promise.allSettled(
    selected.map((route) =>
      concurrencyLimit(async (): Promise<PageSourceRecord> => {
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
        };
      })
    )
  );

  const pages: PageSourceRecord[] = [];
  for (let i = 0; i < results.length; i += 1) {
    const result = results[i];
    if (!result) continue;
    if (result.status === "fulfilled") {
      pages.push(result.value);
    } else {
      const route = selected[i] ?? "unknown";
      logger.warn(`Skipping route ${route}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
    }
  }

  return pages;
}
