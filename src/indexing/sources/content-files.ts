import fs from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import type { PageSourceRecord, ResolvedSearchSocketConfig } from "../../types";
import { normalizeUrlPath } from "../../utils/path";

function filePathToUrl(filePath: string, baseDir: string): string {
  const relative = path.relative(baseDir, filePath).replace(/\\/g, "/");

  if (relative.endsWith("/+page.svelte")) {
    const routePath = relative
      .replace(/\/\+page\.svelte$/, "")
      .split("/")
      .filter((segment) => segment && !segment.startsWith("("))
      .map((segment) =>
        segment
          .replace(/^\[\[[^\]]+\]\]$/, "optional")
          .replace(/^\[\.\.\.[^\]]+\]$/, "splat")
          .replace(/^\[[^\]]+\]$/, "param")
      )
      .join("/");

    return normalizeUrlPath(routePath || "/");
  }

  const noExt = relative
    .replace(/\.md$/i, "")
    .replace(/\/index$/i, "");

  return normalizeUrlPath(noExt || "/");
}

function normalizeSvelteToMarkdown(source: string): string {
  return source
    .replace(/<script[\s\S]*?<\/script>/g, "")
    .replace(/<style[\s\S]*?<\/style>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\{[^}]+\}/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export async function loadContentFilesPages(
  cwd: string,
  config: ResolvedSearchSocketConfig,
  maxPages?: number
): Promise<PageSourceRecord[]> {
  const contentConfig = config.source.contentFiles;
  if (!contentConfig) {
    throw new Error("content-files config is missing");
  }

  const baseDir = path.resolve(cwd, contentConfig.baseDir);
  const files = await fg(contentConfig.globs, {
    cwd: baseDir,
    absolute: true,
    onlyFiles: true
  });

  const selected = typeof maxPages === "number" ? files.slice(0, maxPages) : files;
  const pages: PageSourceRecord[] = [];

  for (const filePath of selected) {
    const raw = await fs.readFile(filePath, "utf8");
    const markdown = filePath.endsWith(".md") ? raw : normalizeSvelteToMarkdown(raw);
    pages.push({
      url: filePathToUrl(filePath, baseDir),
      markdown,
      sourcePath: path.relative(cwd, filePath).replace(/\\/g, "/"),
      outgoingLinks: []
    });
  }

  return pages;
}
