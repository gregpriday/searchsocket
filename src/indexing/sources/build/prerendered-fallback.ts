import fs from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import type { PageSourceRecord } from "../../../types";
import { staticHtmlFileToUrl } from "../../../utils/path";

/**
 * Universal skip list for SvelteKit prerendered output across adapters.
 * Covers build-asset directories, framework fallback/error pages, and
 * platform routing/header files so they never reach the indexer.
 */
export const PRERENDERED_IGNORE_PATTERNS = [
  "_app/**",
  "__data.json",
  "**/__data.json",
  "200.html",
  "404.html",
  "fallback.html",
  "_worker.js",
  "_worker.js/**",
  "_routes.json",
  "_headers",
  "_redirects"
];

/**
 * Load prerendered HTML pages from an adapter's output directory. Works for
 * any adapter that writes prerendered routes as `.html` files mirroring the
 * URL tree (vercel, cloudflare, node's `build/prerendered/`, netlify, static).
 */
export async function loadPrerenderedPages(
  cwd: string,
  outputDir: string,
  maxPages?: number
): Promise<PageSourceRecord[]> {
  const htmlFiles = await fg(["**/*.html"], {
    cwd: outputDir,
    absolute: true,
    ignore: PRERENDERED_IGNORE_PATTERNS
  });

  const limit = typeof maxPages === "number" ? Math.max(0, Math.floor(maxPages)) : undefined;
  const selected = typeof limit === "number" ? htmlFiles.slice(0, limit) : htmlFiles;

  const pages: PageSourceRecord[] = [];
  for (const filePath of selected) {
    const html = await fs.readFile(filePath, "utf8");
    pages.push({
      url: staticHtmlFileToUrl(filePath, outputDir),
      html,
      sourcePath: path.relative(cwd, filePath).replace(/\\/g, "/"),
      outgoingLinks: []
    });
  }

  return pages;
}
