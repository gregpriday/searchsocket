import fs from "node:fs/promises";
import path from "node:path";
import { SearchSocketError } from "../../../errors";
import { Logger } from "../../../core/logger";
import { matchUrlPatterns } from "../../../utils/pattern";

export interface ManifestRoute {
  id: string;
  isPage: boolean;
  isDynamic: boolean;
  routeFile: string;
}

export interface ExpandedRoute {
  url: string;
  routeFile: string;
}

export function routeIdToFile(routeId: string): string {
  if (routeId === "/") {
    return "src/routes/+page.svelte";
  }
  return `src/routes${routeId}/+page.svelte`;
}

export function routeIdToUrl(routeId: string): string {
  if (routeId === "/") return "/";

  return routeId
    .split("/")
    .filter((seg) => !(seg.startsWith("(") && seg.endsWith(")")))
    .join("/") || "/";
}

export async function parseManifest(cwd: string, outputDir: string): Promise<ManifestRoute[]> {
  const manifestPath = path.resolve(cwd, outputDir, "server", "manifest-full.js");

  let content: string;
  try {
    content = await fs.readFile(manifestPath, "utf8");
  } catch {
    throw new SearchSocketError(
      "BUILD_MANIFEST_NOT_FOUND",
      `SvelteKit build manifest not found at ${manifestPath}. Run \`vite build\` first.`
    );
  }

  const routes: ManifestRoute[] = [];

  // Find all route ID positions, then extract context between them
  const idRegex = /id:\s*"([^"]+)"/g;
  const idMatches: Array<{ id: string; index: number }> = [];

  let idMatch: RegExpExecArray | null;
  while ((idMatch = idRegex.exec(content)) !== null) {
    idMatches.push({ id: idMatch[1]!, index: idMatch.index });
  }

  for (let i = 0; i < idMatches.length; i++) {
    const current = idMatches[i]!;
    const nextIndex = idMatches[i + 1]?.index ?? content.length;
    const block = content.slice(current.index, nextIndex);

    // A page route has `page: {` with a non-null value
    const isPage = /page:\s*\{/.test(block);
    if (!isPage) continue;

    const isDynamic = current.id.includes("[");

    routes.push({
      id: current.id,
      isPage: true,
      isDynamic,
      routeFile: routeIdToFile(current.id)
    });
  }

  return routes;
}

export function expandRoutes(
  routes: ManifestRoute[],
  paramValues: Record<string, string[]>,
  exclude: string[],
  logger: Logger
): ExpandedRoute[] {
  const expanded: ExpandedRoute[] = [];

  for (const route of routes) {
    const url = routeIdToUrl(route.id);

    if (isExcluded(url, exclude)) continue;

    if (!route.isDynamic) {
      expanded.push({ url, routeFile: route.routeFile });
      continue;
    }

    // Look up param values by route ID first, then by URL (handles layout group mismatch)
    const values = paramValues[route.id] ?? paramValues[url];
    if (!values || values.length === 0) {
      logger.warn(
        `Skipping dynamic route ${route.id}: no paramValues provided. ` +
          `Add paramValues["${route.id}"] or paramValues["${url}"] to your build config.`
      );
      continue;
    }

    for (const value of values) {
      const expandedUrl = expandDynamicUrl(url, value);
      if (!isExcluded(expandedUrl, exclude)) {
        expanded.push({ url: expandedUrl, routeFile: route.routeFile });
      }
    }
  }

  return expanded;
}

function expandDynamicUrl(url: string, value: string): string {
  // Replace all [param], [...param], [[param]], [[...param]] segments with the value
  return url.replace(/\[\[?\.\.\.[^\]]+\]?\]|\[\[[^\]]+\]\]|\[[^\]]+\]/g, value);
}

export function isExcluded(url: string, patterns: string[]): boolean {
  return matchUrlPatterns(url, patterns);
}
