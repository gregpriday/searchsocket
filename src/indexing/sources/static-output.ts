import fs from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import type { PageSourceRecord, ResolvedSiteScribeConfig } from "../../types";
import { staticHtmlFileToUrl } from "../../utils/path";

export async function loadStaticOutputPages(
  cwd: string,
  config: ResolvedSiteScribeConfig,
  maxPages?: number
): Promise<PageSourceRecord[]> {
  const outputDir = path.resolve(cwd, config.source.staticOutputDir);
  const htmlFiles = await fg(["**/*.html"], {
    cwd: outputDir,
    absolute: true
  });

  const selected = typeof maxPages === "number" ? htmlFiles.slice(0, maxPages) : htmlFiles;

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
