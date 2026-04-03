import fs from "node:fs/promises";
import path from "node:path";
import type { IndexedPage, ResolvedSearchSocketConfig } from "../types";
import type { Logger } from "../core/logger";

/**
 * Build the absolute URL for a page, given the project's baseUrl.
 * Falls back to the raw page URL (relative path) if baseUrl is not configured.
 */
function resolvePageUrl(pageUrl: string, baseUrl?: string): string {
  if (!baseUrl) return pageUrl;
  try {
    return new URL(pageUrl, baseUrl).href;
  } catch {
    return pageUrl;
  }
}

/**
 * Generate the content of an llms.txt file from indexed pages.
 */
export function generateLlmsTxt(
  pages: IndexedPage[],
  config: ResolvedSearchSocketConfig
): string {
  const title = config.llmsTxt.title ?? config.project.id;
  const description = config.llmsTxt.description;
  const baseUrl = config.project.baseUrl;

  const lines: string[] = [`# ${title}`];

  if (description) {
    lines.push("", `> ${description}`);
  }

  // Filter out /llms.txt and /llms-full.txt from the page list
  const filtered = pages.filter(
    (p) => p.url !== "/llms.txt" && p.url !== "/llms-full.txt"
  );

  // Sort by depth ascending, then by incoming links descending
  const sorted = [...filtered].sort((a, b) => {
    if (a.depth !== b.depth) return a.depth - b.depth;
    return b.incomingLinks - a.incomingLinks;
  });

  if (sorted.length > 0) {
    lines.push("", "## Pages", "");
    for (const page of sorted) {
      const url = resolvePageUrl(page.url, baseUrl);
      if (page.description) {
        lines.push(`- [${page.title}](${url}): ${page.description}`);
      } else {
        lines.push(`- [${page.title}](${url})`);
      }
    }
  }

  lines.push("");
  return lines.join("\n");
}

/**
 * Generate the content of an llms-full.txt file with full page markdown.
 */
export function generateLlmsFullTxt(
  pages: IndexedPage[],
  config: ResolvedSearchSocketConfig
): string {
  const title = config.llmsTxt.title ?? config.project.id;
  const description = config.llmsTxt.description;
  const baseUrl = config.project.baseUrl;

  const lines: string[] = [`# ${title}`];

  if (description) {
    lines.push("", `> ${description}`);
  }

  const filtered = pages.filter(
    (p) => p.url !== "/llms.txt" && p.url !== "/llms-full.txt"
  );

  const sorted = [...filtered].sort((a, b) => {
    if (a.depth !== b.depth) return a.depth - b.depth;
    return b.incomingLinks - a.incomingLinks;
  });

  for (const page of sorted) {
    const url = resolvePageUrl(page.url, baseUrl);
    lines.push("", "---", "", `## [${page.title}](${url})`, "");
    lines.push(page.markdown.trim());
  }

  lines.push("");
  return lines.join("\n");
}

/**
 * Write llms.txt (and optionally llms-full.txt) to disk.
 */
export async function writeLlmsTxt(
  pages: IndexedPage[],
  config: ResolvedSearchSocketConfig,
  cwd: string,
  logger: Logger
): Promise<void> {
  const outputPath = path.resolve(cwd, config.llmsTxt.outputPath);
  const outputDir = path.dirname(outputPath);

  await fs.mkdir(outputDir, { recursive: true });

  const content = generateLlmsTxt(pages, config);
  await fs.writeFile(outputPath, content, "utf8");
  logger.info(`Generated llms.txt at ${config.llmsTxt.outputPath}`);

  if (config.llmsTxt.generateFull) {
    const fullPath = outputPath.replace(/\.txt$/, "-full.txt");
    const fullContent = generateLlmsFullTxt(pages, config);
    await fs.writeFile(fullPath, fullContent, "utf8");
    const relativeFull = path.relative(cwd, fullPath);
    logger.info(`Generated llms-full.txt at ${relativeFull}`);
  }
}
