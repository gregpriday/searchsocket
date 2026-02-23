import pLimit from "p-limit";
import { Logger } from "../../../core/logger";
import { normalizeUrlPath, joinUrl } from "../../../utils/path";
import type { PageSourceRecord, ResolvedSearchSocketConfig } from "../../../types";
import { parseManifest, expandRoutes } from "./manifest-parser";
import { startPreviewServer } from "./preview-server";

const logger = new Logger();

export async function loadBuildPages(
  cwd: string,
  config: ResolvedSearchSocketConfig,
  maxPages?: number
): Promise<PageSourceRecord[]> {
  const buildConfig = config.source.build;
  if (!buildConfig) {
    throw new Error("build source config is missing");
  }

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
