import { load } from "cheerio";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import type { ExtractedPage, ResolvedSiteScribeConfig } from "../types";
import { normalizeMarkdown, normalizeText } from "../utils/text";
import { normalizeUrlPath } from "../utils/path";

export function extractFromHtml(
  url: string,
  html: string,
  config: ResolvedSiteScribeConfig
): ExtractedPage | null {
  const $ = load(html);

  const title =
    normalizeText($("title").first().text() || "") ||
    normalizeText($(`${config.extract.mainSelector} h1`).first().text() || "") ||
    normalizeUrlPath(url);

  if (config.extract.respectRobotsNoindex) {
    const robots = $("meta[name='robots']").attr("content") ?? "";
    if (/\bnoindex\b/i.test(robots)) {
      return null;
    }
  }

  if ($(`[${config.extract.noindexAttr}]`).length > 0) {
    return null;
  }

  const root = $(config.extract.mainSelector).first().length
    ? $(config.extract.mainSelector).first().clone()
    : $("body").first().clone();

  for (const tagName of config.extract.dropTags) {
    root.find(tagName).remove();
  }

  for (const selector of config.extract.dropSelectors) {
    root.find(selector).remove();
  }

  root.find(`[${config.extract.ignoreAttr}]`).remove();

  const outgoingLinks: string[] = [];
  root.find("a[href]").each((_index, node) => {
    const href = $(node).attr("href");
    if (!href || href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("tel:")) {
      return;
    }

    try {
      if (href.startsWith("http://") || href.startsWith("https://")) {
        const parsed = new URL(href);
        outgoingLinks.push(normalizeUrlPath(parsed.pathname));
        return;
      }

      outgoingLinks.push(normalizeUrlPath(href));
    } catch {
      // ignore malformed links
    }
  });

  const turndown = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced"
  });
  turndown.use(gfm);

  const markdown = normalizeMarkdown(turndown.turndown(root.html() ?? ""));

  if (!normalizeText(markdown)) {
    return null;
  }

  const tags = normalizeUrlPath(url)
    .split("/")
    .filter(Boolean)
    .slice(0, 1);

  return {
    url: normalizeUrlPath(url),
    title,
    markdown,
    outgoingLinks: [...new Set(outgoingLinks)],
    noindex: false,
    tags
  };
}

export function extractFromMarkdown(url: string, markdown: string, title?: string): ExtractedPage | null {
  const normalized = normalizeMarkdown(markdown);
  if (!normalizeText(normalized)) {
    return null;
  }

  return {
    url: normalizeUrlPath(url),
    title: title ?? normalizeUrlPath(url),
    markdown: normalized,
    outgoingLinks: [],
    noindex: false,
    tags: normalizeUrlPath(url)
      .split("/")
      .filter(Boolean)
      .slice(0, 1)
  };
}
