import { load } from "cheerio";
import matter from "gray-matter";
import TurndownService from "turndown";
import { gfm, highlightedCodeBlock, strikethrough, tables, taskListItems } from "turndown-plugin-gfm";
import type { ExtractedPage, ResolvedSearchSocketConfig } from "../types";
import { normalizeMarkdown, normalizeText } from "../utils/text";
import { normalizeUrlPath } from "../utils/path";

function hasTopLevelNoindexComment(markdown: string): boolean {
  const lines = markdown.split(/\r?\n/);
  let inFence = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^(```|~~~)/.test(trimmed)) {
      inFence = !inFence;
      continue;
    }

    if (!inFence && /<!--\s*noindex\s*-->/i.test(line)) {
      return true;
    }
  }

  return false;
}

export function extractFromHtml(
  url: string,
  html: string,
  config: ResolvedSearchSocketConfig
): ExtractedPage | null {
  const $ = load(html);
  const normalizedUrl = normalizeUrlPath(url);
  const pageBaseUrl = new URL(`https://searchsocket.local${normalizedUrl}`);

  const title =
    $("meta[property='og:title']").attr("content")?.trim() ||
    normalizeText($(`${config.extract.mainSelector} h1`).first().text() || "") ||
    $("meta[name='twitter:title']").attr("content")?.trim() ||
    normalizeText($("title").first().text() || "") ||
    normalizedUrl;

  if (config.extract.respectRobotsNoindex) {
    const robots = $("meta[name='robots']").attr("content") ?? "";
    if (/\bnoindex\b/i.test(robots)) {
      return null;
    }
  }

  if ($(`[${config.extract.noindexAttr}]`).length > 0) {
    return null;
  }

  const description =
    $("meta[name='description']").attr("content")?.trim() ||
    $("meta[property='og:description']").attr("content")?.trim() ||
    undefined;

  const keywordsRaw = $("meta[name='keywords']").attr("content")?.trim();
  const keywords = keywordsRaw
    ? keywordsRaw.split(",").map((k) => k.trim()).filter(Boolean)
    : undefined;

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
      const parsed = new URL(href, pageBaseUrl);
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
    tags,
    description,
    keywords
  };
}

export function extractFromMarkdown(url: string, markdown: string, title?: string): ExtractedPage | null {
  // Check for <!-- noindex --> comments outside fenced code blocks.
  if (hasTopLevelNoindexComment(markdown)) {
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

  const fmDescription = typeof frontmatter.description === "string" ? frontmatter.description.trim() || undefined : undefined;
  let fmKeywords: string[] | undefined;
  if (Array.isArray(frontmatter.keywords)) {
    fmKeywords = frontmatter.keywords.filter((k): k is string => typeof k === "string" && k.trim().length > 0).map((k) => k.trim());
  } else if (typeof frontmatter.keywords === "string" && frontmatter.keywords.trim()) {
    fmKeywords = frontmatter.keywords.split(",").map((k) => k.trim()).filter(Boolean);
  }
  if (fmKeywords && fmKeywords.length === 0) fmKeywords = undefined;

  return {
    url: normalizeUrlPath(url),
    title: resolvedTitle,
    markdown: normalized,
    outgoingLinks: [],
    noindex: false,
    tags: normalizeUrlPath(url)
      .split("/")
      .filter(Boolean)
      .slice(0, 1),
    description: fmDescription,
    keywords: fmKeywords
  };
}
