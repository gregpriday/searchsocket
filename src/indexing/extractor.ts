import { load } from "cheerio";
import matter from "gray-matter";
import TurndownService from "turndown";
import { gfm, highlightedCodeBlock, strikethrough, tables, taskListItems } from "turndown-plugin-gfm";
import type { ExtractedPage, ResolvedSearchSocketConfig } from "../types";
import { normalizeMarkdown, normalizeText } from "../utils/text";
import { normalizeUrlPath } from "../utils/path";

export function extractFromHtml(
  url: string,
  html: string,
  config: ResolvedSearchSocketConfig
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
      const parsed = new URL(href, "https://searchsocket.local");
      if (!["http:", "https:"].includes(parsed.protocol)) {
        return;
      }

      outgoingLinks.push(normalizeUrlPath(parsed.pathname));
    } catch {
      // ignore malformed links
    }
  });

  const turndown = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced"
  });

  if (config.transform.preserveCodeBlocks && config.transform.preserveTables) {
    turndown.use(gfm);
  } else {
    // Always apply strikethrough and task list items
    turndown.use(strikethrough);
    turndown.use(taskListItems);

    if (config.transform.preserveTables) {
      turndown.use(tables);
    }
    if (config.transform.preserveCodeBlocks) {
      turndown.use(highlightedCodeBlock);
    }
  }

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
  // Check for <!-- noindex --> HTML comment before any processing
  if (/<!--\s*noindex\s*-->/i.test(markdown)) {
    return null;
  }

  // Parse frontmatter and check for noindex flag
  const parsed = matter(markdown);
  const frontmatter = parsed.data as Record<string, unknown>;

  const searchsocketMeta = frontmatter.searchsocket as Record<string, unknown> | undefined;
  if (frontmatter.noindex === true || searchsocketMeta?.noindex === true) {
    return null;
  }

  const content = parsed.content;
  const normalized = normalizeMarkdown(content);
  if (!normalizeText(normalized)) {
    return null;
  }

  const resolvedTitle = title ?? (typeof frontmatter.title === "string" ? frontmatter.title : undefined) ?? normalizeUrlPath(url);

  return {
    url: normalizeUrlPath(url),
    title: resolvedTitle,
    markdown: normalized,
    outgoingLinks: [],
    noindex: false,
    tags: normalizeUrlPath(url)
      .split("/")
      .filter(Boolean)
      .slice(0, 1)
  };
}
