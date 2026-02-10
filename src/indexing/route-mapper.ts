import path from "node:path";
import fg from "fast-glob";
import type { RouteMatch } from "../types";
import { normalizeUrlPath } from "../utils/path";

interface RoutePattern {
  routeFile: string;
  regex: RegExp;
  score: number;
}

function segmentToRegex(segment: string): { regex: string; score: number } {
  if (segment.startsWith("(") && segment.endsWith(")")) {
    return { regex: "", score: 0 };
  }

  if (/^\[\.\.\.[^\]]+\]$/.test(segment)) {
    return { regex: "/.+", score: 1 };
  }

  if (/^\[\[[^\]]+\]\]$/.test(segment)) {
    return { regex: "(?:/[^/]+)?", score: 2 };
  }

  if (/^\[[^\]]+\]$/.test(segment)) {
    return { regex: "/[^/]+", score: 3 };
  }

  return { regex: `/${segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, score: 10 };
}

function routeFileToPattern(routeFile: string, cwd: string): RoutePattern {
  const relative = path.relative(cwd, routeFile).replace(/\\/g, "/");
  const withoutPrefix = relative.replace(/^src\/routes\/?/, "");
  const withoutPage = withoutPrefix.replace(/\/\+page\.[^/]+$/, "");
  const segments = withoutPage.split("/").filter(Boolean);

  let regex = "^";
  let score = 0;

  if (segments.length === 0) {
    regex += "/";
  } else {
    for (const segment of segments) {
      const converted = segmentToRegex(segment);
      regex += converted.regex;
      score += converted.score;
    }
  }

  regex += "/?$";

  return {
    routeFile: relative,
    regex: new RegExp(regex),
    score
  };
}

export async function buildRoutePatterns(cwd: string): Promise<RoutePattern[]> {
  const files = await fg("src/routes/**/+page.svelte", {
    cwd,
    absolute: true
  });

  return files
    .map((file) => routeFileToPattern(file, cwd))
    .sort((a, b) => b.score - a.score || b.routeFile.length - a.routeFile.length);
}

export function mapUrlToRoute(urlPath: string, patterns: RoutePattern[]): RouteMatch {
  const normalized = normalizeUrlPath(urlPath);

  for (const pattern of patterns) {
    if (pattern.regex.test(normalized)) {
      return {
        routeFile: pattern.routeFile,
        routeResolution: "exact"
      };
    }
  }

  const rootRoute = patterns.find((pattern) => pattern.routeFile === "src/routes/+page.svelte");
  if (rootRoute) {
    return {
      routeFile: rootRoute.routeFile,
      routeResolution: "best-effort"
    };
  }

  const fallback = patterns[0];
  return {
    routeFile: fallback?.routeFile ?? "src/routes/+page.svelte",
    routeResolution: "best-effort"
  };
}
