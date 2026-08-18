import { gunzipSync } from "node:zlib";
import { load as cheerioLoad } from "cheerio";
import pLimit from "p-limit";
import { Logger } from "../../core/logger";
import type { PageSourceRecord, ResolvedSearchSocketConfig } from "../../types";
import { ensureLeadingSlash, joinUrl, normalizeUrlPath } from "../../utils/path";
import { applyMaxPages, sourceResult, type SourceFailure, type SourceLoadResult } from "./result";

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


/** Wall-clock limit for a single request, so a hung server cannot stall a run. */
const REQUEST_TIMEOUT_MS = 30_000;
/** Largest response body accepted, so one huge document cannot exhaust memory. */
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
/** Bounds a sitemap-index fan-out, including a maliciously deep or wide one. */
const MAX_SITEMAPS = 50;

const USER_AGENT = "Searchsocket";

/**
 * Fetch with a timeout, a size cap, and a same-origin redirect policy.
 *
 * Plain `fetch()` follows redirects anywhere, so a sitemap entry — content the
 * crawler does not control — could redirect the crawl to an internal address
 * and have the response indexed. Redirects are followed manually and only
 * within the site's own origin.
 */
async function safeFetch(
  url: string,
  allowedOrigin: string,
  accept: string
): Promise<{ body: Buffer; contentType: string }> {
  let current = url;

  for (let redirects = 0; redirects <= 5; redirects += 1) {
    const target = new URL(current);
    if (target.origin !== allowedOrigin) {
      throw new Error(`Refusing to fetch ${target.origin}: outside the configured crawl origin`);
    }
    if (target.protocol !== "http:" && target.protocol !== "https:") {
      throw new Error(`Unsupported scheme ${target.protocol}`);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(current, {
        redirect: "manual",
        signal: controller.signal,
        headers: { "user-agent": USER_AGENT, accept }
      });
    } finally {
      clearTimeout(timer);
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error(`Redirect from ${current} had no Location header`);
      current = new URL(location, current).href;
      continue;
    }

    if (!response.ok) {
      throw new Error(`Failed to fetch ${current}: ${response.status} ${response.statusText}`);
    }

    const declaredLength = Number(response.headers.get("content-length") ?? 0);
    if (declaredLength > MAX_RESPONSE_BYTES) {
      throw new Error(`Response from ${current} exceeds ${MAX_RESPONSE_BYTES} bytes`);
    }

    const body = Buffer.from(await response.arrayBuffer());
    // Checked again against the real body: Content-Length can be absent or lie.
    if (body.byteLength > MAX_RESPONSE_BYTES) {
      throw new Error(`Response from ${current} exceeds ${MAX_RESPONSE_BYTES} bytes`);
    }

    return { body, contentType: response.headers.get("content-type") ?? "" };
  }

  throw new Error(`Too many redirects fetching ${url}`);
}

async function fetchSitemapXml(url: string, allowedOrigin: string): Promise<string> {
  const { body } = await safeFetch(url, allowedOrigin, "application/xml,text/xml");

  if (url.endsWith(".gz")) {
    return gunzipSync(body).toString("utf8");
  }

  return body.toString("utf8");
}

function resolveSitemapUrl(baseUrl: string, candidate: string): string {
  return candidate.startsWith("http") ? candidate : joinUrl(baseUrl, candidate);
}

async function parseSitemap(xml: string, baseUrl: string, visitedSitemaps: Set<string>): Promise<string[]> {
  if (isSitemapIndex(xml)) {
    const childUrls = extractLocs(xml);
    const routes: string[] = [];

    for (const childUrl of childUrls) {
      const childRoutes = await parseSitemapFromUrl(childUrl, baseUrl, visitedSitemaps);
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
      if (!["http:", "https:"].includes(parsed.protocol)) {
        continue;
      }
      routes.push(normalizeUrlPath(parsed.pathname));
    } catch {
      // ignore invalid entry
    }
  }

  return [...new Set(routes)];
}

async function parseSitemapFromUrl(url: string, baseUrl: string, visitedSitemaps: Set<string>): Promise<string[]> {
  const resolved = resolveSitemapUrl(baseUrl, url);
  if (visitedSitemaps.has(resolved)) {
    return [];
  }

  if (visitedSitemaps.size >= MAX_SITEMAPS) {
    logger.warn(`Sitemap limit of ${MAX_SITEMAPS} reached; skipping ${resolved}`);
    return [];
  }

  visitedSitemaps.add(resolved);
  const xml = await fetchSitemapXml(resolved, new URL(baseUrl).origin);
  return parseSitemap(xml, baseUrl, visitedSitemaps);
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

  return parseSitemapFromUrl(crawlConfig.sitemapUrl, crawlConfig.baseUrl, new Set<string>());
}

export async function loadCrawledPages(
  config: ResolvedSearchSocketConfig,
  maxPages?: number
): Promise<SourceLoadResult> {
  const crawlConfig = config.source.crawl;
  if (!crawlConfig) {
    throw new Error("crawl source config is missing");
  }

  const baseOrigin = new URL(crawlConfig.baseUrl).origin;
  const routes = await resolveRoutes(config);
  // Deterministic order before limiting — see static-output for why.
  routes.sort();
  const { selected, limitedBy } = applyMaxPages(routes, maxPages);

  const concurrencyLimit = pLimit(8);
  const results = await Promise.allSettled(
    selected.map((route) =>
      concurrencyLimit(async (): Promise<PageSourceRecord> => {
        const url = joinUrl(crawlConfig.baseUrl, route);
        const { body, contentType } = await safeFetch(url, baseOrigin, "text/html");

        if (contentType && !contentType.includes("text/html")) {
          throw new Error(`Route ${route} returned ${contentType}, expected text/html`);
        }

        return {
          url: normalizeUrlPath(route),
          html: body.toString("utf8"),
          sourcePath: url,
          outgoingLinks: []
        };
      })
    )
  );

  const pages: PageSourceRecord[] = [];
  const failures: SourceFailure[] = [];
  for (let i = 0; i < results.length; i += 1) {
    const result = results[i];
    if (!result) continue;
    if (result.status === "fulfilled") {
      pages.push(result.value);
    } else {
      const route = selected[i] ?? "unknown";
      const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
      // A failed fetch is not evidence the page is gone. Recording it here
      // makes the whole run deletion-ineligible rather than silently
      // presenting a partial crawl as an authoritative snapshot.
      failures.push({ target: route, reason });
      logger.warn(`Skipping route ${route}: ${reason}`);
    }
  }

  return sourceResult({
    records: pages,
    discoveredCount: routes.length,
    failures,
    limitedBy
  });
}
