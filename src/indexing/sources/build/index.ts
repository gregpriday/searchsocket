import { load as cheerioLoad } from "cheerio";
import pLimit from "p-limit";
import { Logger } from "../../../core/logger";
import { normalizeUrlPath, joinUrl } from "../../../utils/path";
import type { PageSourceRecord, ResolvedSearchSocketConfig } from "../../../types";
import { parseManifest, expandRoutes, isExcluded } from "./manifest-parser";
import { startPreviewServer, type PreviewServer } from "./preview-server";

const logger = new Logger();

/**
 * Extract internal links from an HTML document for link-discovery crawling.
 * Scans all `<a href>` tags (including navigation) to find linked pages.
 */
export function extractLinksFromHtml(html: string, pageUrl: string, baseOrigin: string): string[] {
  const $ = cheerioLoad(html);
  const links: string[] = [];

  $("a[href]").each((_i, el) => {
    const href = $(el).attr("href");
    if (!href || href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("tel:") || href.startsWith("javascript:")) {
      return;
    }

    try {
      const resolved = new URL(href, `${baseOrigin}${pageUrl}`);
      if (resolved.origin !== baseOrigin) return;
      if (!["http:", "https:"].includes(resolved.protocol)) return;

      links.push(normalizeUrlPath(resolved.pathname));
    } catch {
      // Ignore malformed URLs
    }
  });

  return [...new Set(links)];
}

/**
 * BFS link-discovery crawl against a running preview server.
 * Starts from seed URLs, follows internal `<a href>` links, and collects
 * pages up to maxPages with depth tracking.
 */
async function discoverPages(
  server: PreviewServer,
  buildConfig: NonNullable<ResolvedSearchSocketConfig["source"]["build"]>,
  pipelineMaxPages?: number
): Promise<PageSourceRecord[]> {
  const { seedUrls, maxDepth, exclude } = buildConfig;
  const baseOrigin = new URL(server.baseUrl).origin;

  // Use the lower of pipeline maxPages and config maxPages
  let effectiveMax = buildConfig.maxPages;
  if (typeof pipelineMaxPages === "number") {
    const floored = Math.max(0, Math.floor(pipelineMaxPages));
    effectiveMax = Math.min(effectiveMax, floored);
  }

  if (effectiveMax === 0) return [];

  const visited = new Set<string>();
  const pages: PageSourceRecord[] = [];
  const queue: Array<{ url: string; depth: number }> = [];
  const limit = pLimit(8);

  // Seed the queue
  for (const seed of seedUrls) {
    const normalized = normalizeUrlPath(seed);
    if (!visited.has(normalized) && !isExcluded(normalized, exclude)) {
      visited.add(normalized);
      queue.push({ url: normalized, depth: 0 });
    }
  }

  // Process in waves (BFS order)
  while (queue.length > 0 && pages.length < effectiveMax) {
    const remaining = effectiveMax - pages.length;
    const batch = queue.splice(0, remaining);

    const results = await Promise.allSettled(
      batch.map((item) =>
        limit(async (): Promise<PageSourceRecord | null> => {
          const fullUrl = joinUrl(server.baseUrl, item.url);
          const response = await fetch(fullUrl);

          if (!response.ok) {
            logger.warn(`Skipping ${item.url}: ${response.status} ${response.statusText}`);
            return null;
          }

          const contentType = response.headers.get("content-type") ?? "";
          if (!contentType.includes("text/html")) {
            return null;
          }

          const html = await response.text();

          // Extract and queue new links if not at max depth
          if (item.depth < maxDepth) {
            const links = extractLinksFromHtml(html, item.url, baseOrigin);
            for (const link of links) {
              if (!visited.has(link) && !isExcluded(link, exclude)) {
                visited.add(link);
                queue.push({ url: link, depth: item.depth + 1 });
              }
            }
          }

          return {
            url: item.url,
            html,
            sourcePath: fullUrl,
            outgoingLinks: []
          };
        })
      )
    );

    for (const result of results) {
      if (result.status === "fulfilled" && result.value) {
        pages.push(result.value);
      }
    }
  }

  if (pages.length >= effectiveMax && queue.length > 0) {
    logger.warn(`Discovery crawl reached maxPages limit (${effectiveMax}), ${queue.length} URLs not visited.`);
  }

  logger.event("build_discover_complete", {
    pagesFound: pages.length,
    urlsVisited: visited.size,
    urlsSkipped: queue.length
  });

  return pages;
}

export async function loadBuildPages(
  cwd: string,
  config: ResolvedSearchSocketConfig,
  maxPages?: number
): Promise<PageSourceRecord[]> {
  const buildConfig = config.source.build;
  if (!buildConfig) {
    throw new Error("build source config is missing");
  }

  // Discovery mode: BFS crawl from seed URLs instead of manifest parsing
  if (buildConfig.discover) {
    const server = await startPreviewServer(cwd, { previewTimeout: buildConfig.previewTimeout }, logger);
    try {
      return await discoverPages(server, buildConfig, maxPages);
    } finally {
      await server.shutdown();
    }
  }

  // Manifest mode: parse SvelteKit build manifest and fetch known routes
  const routes = await parseManifest(cwd, buildConfig.outputDir);
  const expanded = expandRoutes(routes, buildConfig.paramValues, buildConfig.exclude, logger);

  logger.event("build_routes_discovered", {
    manifestRoutes: routes.length,
    expandedRoutes: expanded.length
  });

  const maxCount = typeof maxPages === "number" ? Math.max(0, Math.floor(maxPages)) : undefined;
  const selected = typeof maxCount === "number" ? expanded.slice(0, maxCount) : expanded;

  const server = await startPreviewServer(cwd, { previewTimeout: buildConfig.previewTimeout }, logger);

  try {
    const concurrencyLimit = pLimit(8);
    const results = await Promise.allSettled(
      selected.map((route) =>
        concurrencyLimit(async (): Promise<PageSourceRecord> => {
          const fetchUrl = joinUrl(server.baseUrl, route.url);
          const response = await fetch(fetchUrl);

          if (!response.ok) {
            throw new Error(`Failed to fetch ${route.url}: ${response.status} ${response.statusText}`);
          }

          return {
            url: normalizeUrlPath(route.url),
            html: await response.text(),
            sourcePath: route.routeFile,
            outgoingLinks: [],
            routeFile: route.routeFile,
            routeResolution: "exact"
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
        const route = selected[i]?.url ?? "unknown";
        logger.warn(
          `Skipping build route ${route}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`
        );
      }
    }

    return pages;
  } finally {
    await server.shutdown();
  }
}
