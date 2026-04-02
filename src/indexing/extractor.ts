import { load, type Cheerio, type CheerioAPI, type AnyNode } from "cheerio";
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

const GARBAGE_ALT_WORDS = new Set([
  "image", "photo", "picture", "icon", "logo", "banner",
  "screenshot", "thumbnail", "img", "graphic", "illustration",
  "spacer", "pixel", "placeholder", "avatar", "background"
]);

const IMAGE_EXT_RE = /\.(jpg|jpeg|png|gif|svg|webp|avif|bmp|ico)(\?.*)?$/i;

function isMeaningfulAlt(alt: string): boolean {
  const trimmed = alt.trim();
  if (!trimmed || trimmed.length < 5) return false;
  if (IMAGE_EXT_RE.test(trimmed)) return false;
  if (GARBAGE_ALT_WORDS.has(trimmed.toLowerCase())) return false;
  return true;
}

function resolveImageText(
  img: Cheerio<AnyNode>,
  $: CheerioAPI,
  imageDescAttr: string
): string | null {
  // Priority 1: data-search-description on the img itself
  const imgDesc = img.attr(imageDescAttr)?.trim();
  if (imgDesc) return imgDesc;

  // Priority 2: data-search-description on the closest <figure>
  const figure = img.closest("figure");
  if (figure.length) {
    const figDesc = figure.attr(imageDescAttr)?.trim();
    if (figDesc) return figDesc;
  }

  const alt = img.attr("alt")?.trim() ?? "";
  const caption = figure.length
    ? figure.find("figcaption").first().text().trim()
    : "";

  // Priority 3: meaningful alt + figcaption
  if (isMeaningfulAlt(alt) && caption) {
    return `${alt} — ${caption}`;
  }

  // Priority 4: meaningful alt alone
  if (isMeaningfulAlt(alt)) {
    return alt;
  }

  // Priority 5: figcaption alone (no meaningful alt)
  if (caption) {
    return caption;
  }

  // No useful text — remove
  return null;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function preprocessImages(
  root: Cheerio<AnyNode>,
  $: CheerioAPI,
  imageDescAttr: string
): void {
  // Pass 1: <picture> elements — process inner <img>, replace whole <picture>
  root.find("picture").each((_i, el) => {
    const picture = $(el);
    const img = picture.find("img").first();
    const parentFigure = picture.closest("figure");
    const text = img.length ? resolveImageText(img, $, imageDescAttr) : null;
    if (text) {
      if (parentFigure.length) parentFigure.find("figcaption").remove();
      picture.replaceWith(`<span>${escapeHtml(text)}</span>`);
    } else {
      picture.remove();
    }
  });

  // Pass 2: bare <img> elements (not already removed with <picture>)
  root.find("img").each((_i, el) => {
    const img = $(el);
    const parentFigure = img.closest("figure");
    const text = resolveImageText(img, $, imageDescAttr);
    if (text) {
      if (parentFigure.length) parentFigure.find("figcaption").remove();
      img.replaceWith(`<span>${escapeHtml(text)}</span>`);
    } else {
      img.remove();
    }
  });
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

  // Read per-page search weight from <meta name="searchsocket-weight" content="...">
  const weightRaw = $("meta[name='searchsocket-weight']").attr("content")?.trim();
  let weight: number | undefined;
  if (weightRaw !== undefined) {
    const parsed = Number(weightRaw);
    if (Number.isFinite(parsed) && parsed >= 0) {
      weight = parsed;
    }
  }

  // If weight is 0, skip indexing entirely — save extraction/chunking/embedding cost
  if (weight === 0) {
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

  // Replace <img> elements with descriptive text before Turndown
  preprocessImages(root, $, config.extract.imageDescAttr);

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
    keywords,
    weight
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

  // Read per-page weight from frontmatter: searchsocket.weight or weight
  let mdWeight: number | undefined;
  const rawWeight = searchsocketMeta?.weight ?? frontmatter.searchsocketWeight;
  if (typeof rawWeight === "number" && Number.isFinite(rawWeight) && rawWeight >= 0) {
    mdWeight = rawWeight;
  }
  if (mdWeight === 0) {
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
    keywords: fmKeywords,
    weight: mdWeight
  };
}
