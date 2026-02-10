import pLimit from "p-limit";
import type { PageSourceRecord, ResolvedSiteScribeConfig } from "../../types";
import { ensureLeadingSlash, joinUrl, normalizeUrlPath } from "../../utils/path";

function parseSitemap(xml: string): string[] {
  const routes: string[] = [];
  const regex = /<loc>(.*?)<\/loc>/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(xml)) !== null) {
    const loc = match[1];
    if (!loc) {
      continue;
    }
    try {
      const url = new URL(loc);
      routes.push(normalizeUrlPath(url.pathname));
    } catch {
      // ignore invalid entry
    }
  }

  return [...new Set(routes)];
}

async function resolveRoutes(config: ResolvedSiteScribeConfig): Promise<string[]> {
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

  const res = await fetch(sitemapUrl);
  if (!res.ok) {
    throw new Error(`Failed to fetch sitemap ${sitemapUrl}: ${res.status} ${res.statusText}`);
  }

  return parseSitemap(await res.text());
}

export async function loadCrawledPages(
  config: ResolvedSiteScribeConfig,
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
