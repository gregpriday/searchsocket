import pLimit from "p-limit";
import { load, type CheerioAPI } from "cheerio";
import type { Chunk, ResolvedSearchSocketConfig, Scope } from "../types";
import { sha1, sha256 } from "../utils/hash";
import { toSnippet } from "../utils/text";
import { getUrlDepth } from "../utils/path";
import { Logger } from "../core/logger";

export interface ImageCandidate {
  src: string;
  resolvedUrl: string;
  alt: string;
  contextHeading?: string;
  width?: number;
  height?: number;
}

const SUPPORTED_MIME_TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif"
};

const SKIP_EXTENSIONS = new Set(["svg", "ico", "bmp", "avif"]);

function getExtension(url: string): string {
  try {
    const pathname = new URL(url, "https://placeholder.local").pathname;
    const match = pathname.match(/\.(\w+)$/);
    return match ? match[1]!.toLowerCase() : "";
  } catch {
    return "";
  }
}

function getMimeType(url: string): string | null {
  const ext = getExtension(url);
  return SUPPORTED_MIME_TYPES[ext] ?? null;
}

function resolveImageUrl(src: string, pageUrl: string, baseUrl?: string): string | null {
  try {
    if (src.startsWith("data:")) return null;
    const base = baseUrl ? `${baseUrl}${pageUrl}` : `https://placeholder.local${pageUrl}`;
    const resolved = new URL(src, base);
    return resolved.href;
  } catch {
    return null;
  }
}

export function extractImageCandidates(
  rawHtml: string,
  pageUrl: string,
  config: ResolvedSearchSocketConfig
): ImageCandidate[] {
  const $ = load(rawHtml);
  const imagesConfig = config.embedding.images;
  const candidates: ImageCandidate[] = [];

  // Find the main content area (same selector as extractor)
  const root = $(config.extract.mainSelector).first().length
    ? $(config.extract.mainSelector).first()
    : $("body").first();

  // Find the nearest preceding heading for context
  function findContextHeading(imgEl: ReturnType<CheerioAPI>): string | undefined {
    // Walk backwards through preceding siblings and their parents to find a heading
    let node = imgEl;
    while (node.length) {
      // Check preceding siblings for headings
      const prev = node.prevAll("h1, h2, h3, h4, h5, h6").first();
      if (prev.length) {
        return prev.text().trim() || undefined;
      }
      // Move up to the parent and check its preceding siblings
      node = node.parent();
      if (!node.length || node.is("body") || node.is("html")) break;
    }
    return undefined;
  }

  root.find("img").each((_i, el) => {
    if (candidates.length >= imagesConfig.maxPerPage) return;

    const img = $(el);

    // Skip images inside ignored/dropped areas
    if (img.closest(`[${config.extract.ignoreAttr}]`).length) return;
    for (const selector of config.extract.dropSelectors) {
      if (img.closest(selector).length) return;
    }
    for (const tag of config.extract.dropTags) {
      if (img.closest(tag).length) return;
    }

    const src = img.attr("src")?.trim();
    if (!src || src.startsWith("data:")) return;

    const ext = getExtension(src);
    if (SKIP_EXTENSIONS.has(ext)) return;

    const mimeType = getMimeType(src);
    if (!mimeType) return;

    // Check dimensions if provided
    const widthAttr = parseInt(img.attr("width") ?? "", 10);
    const heightAttr = parseInt(img.attr("height") ?? "", 10);
    if (!isNaN(widthAttr) && widthAttr < imagesConfig.minWidth) return;
    if (!isNaN(heightAttr) && heightAttr < imagesConfig.minHeight) return;

    const resolvedUrl = resolveImageUrl(src, pageUrl, config.project.baseUrl);
    if (!resolvedUrl) return;

    const alt = img.attr("alt")?.trim() ?? "";
    const contextHeading = findContextHeading(img);

    candidates.push({
      src,
      resolvedUrl,
      alt,
      contextHeading,
      width: isNaN(widthAttr) ? undefined : widthAttr,
      height: isNaN(heightAttr) ? undefined : heightAttr
    });
  });

  return candidates;
}

async function fetchImageAsBase64(
  url: string,
  logger: Logger
): Promise<{ base64: string; mimeType: string } | null> {
  const FETCH_TIMEOUT_MS = 15_000;
  const MAX_SIZE = 20 * 1024 * 1024; // 20MB

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { "User-Agent": "SearchSocket/1.0 (image-indexer)" }
      });

      if (!response.ok) {
        logger.debug(`Image fetch failed for ${url}: HTTP ${response.status}`);
        return null;
      }

      const contentLength = response.headers.get("content-length");
      if (contentLength && parseInt(contentLength, 10) > MAX_SIZE) {
        logger.debug(`Image too large: ${url} (${contentLength} bytes)`);
        return null;
      }

      const contentType = response.headers.get("content-type") ?? "";
      const mimeFromHeader = contentType.split(";")[0]?.trim() ?? "";

      // Determine MIME type: prefer header, fall back to extension
      const ext = getExtension(url);
      const mimeFromExt = SUPPORTED_MIME_TYPES[ext];
      const mimeType = (mimeFromHeader && mimeFromHeader.startsWith("image/"))
        ? mimeFromHeader
        : mimeFromExt ?? "image/jpeg";

      // Verify it's a supported MIME type
      const supportedValues = new Set(Object.values(SUPPORTED_MIME_TYPES));
      if (!supportedValues.has(mimeType)) {
        logger.debug(`Unsupported MIME type for ${url}: ${mimeType}`);
        return null;
      }

      const buffer = await response.arrayBuffer();
      if (buffer.byteLength > MAX_SIZE) {
        logger.debug(`Image too large after download: ${url} (${buffer.byteLength} bytes)`);
        return null;
      }

      const base64 = Buffer.from(buffer).toString("base64");
      return { base64, mimeType };
    } finally {
      clearTimeout(timeout);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.debug(`Image fetch error for ${url}: ${message}`);
    return null;
  }
}

async function generateDescription(
  client: { models: { generateContent: Function } },
  model: string,
  base64: string,
  mimeType: string,
  pageTitle: string,
  alt: string,
  contextHeading?: string
): Promise<string | null> {
  const contextParts: string[] = [];
  if (pageTitle) contextParts.push(`Page title: "${pageTitle}"`);
  if (contextHeading) contextParts.push(`Section heading: "${contextHeading}"`);
  if (alt) contextParts.push(`Image alt text: "${alt}"`);

  const contextStr = contextParts.length > 0
    ? `Context: ${contextParts.join(". ")}.\n\n`
    : "";

  const prompt = `${contextStr}Describe this image in detail for search indexing. Focus on what the image shows, its purpose in the page context, and any text visible in the image. Write 2-4 sentences.`;

  const response = await client.models.generateContent({
    model,
    contents: [
      {
        role: "user",
        parts: [
          { text: prompt },
          {
            inlineData: {
              mimeType,
              data: base64
            }
          }
        ]
      }
    ]
  });

  const text = (response as { text?: string }).text;
  if (!text || !text.trim()) return null;
  return text.trim();
}

export interface DescribeImagesOptions {
  candidates: ImageCandidate[];
  pageUrl: string;
  pageTitle: string;
  pageDepth: number;
  pageTags: string[];
  pageRouteFile: string;
  pageIncomingLinks: number;
  scope: Scope;
  config: ResolvedSearchSocketConfig;
  logger: Logger;
}

export async function describeImages(options: DescribeImagesOptions): Promise<Chunk[]> {
  const {
    candidates,
    pageUrl,
    pageTitle,
    pageDepth,
    pageTags,
    pageRouteFile,
    pageIncomingLinks,
    scope,
    config,
    logger
  } = options;

  if (candidates.length === 0) return [];

  const imagesConfig = config.embedding.images;
  const apiKeyEnv = imagesConfig.apiKeyEnv ?? config.embedding.apiKeyEnv;
  const apiKey = process.env[apiKeyEnv];

  if (!apiKey) {
    logger.warn(`Image description skipped: missing API key (env: ${apiKeyEnv})`);
    return [];
  }

  // Dynamic import to match the existing pattern in GeminiEmbedder
  const { GoogleGenAI } = await import("@google/genai");
  const client = new GoogleGenAI({ apiKey });

  const limiter = pLimit(3);
  const chunks: Chunk[] = [];

  await Promise.all(
    candidates.map((candidate, index) =>
      limiter(async () => {
        try {
          const imageData = await fetchImageAsBase64(candidate.resolvedUrl, logger);
          if (!imageData) return;

          const description = await generateDescription(
            client as unknown as { models: { generateContent: Function } },
            imagesConfig.model,
            imageData.base64,
            imageData.mimeType,
            pageTitle,
            candidate.alt,
            candidate.contextHeading
          );

          if (!description) {
            logger.debug(`No description generated for image ${candidate.resolvedUrl}`);
            return;
          }

          const chunkKey = sha1(
            `${scope.scopeName}|${pageUrl}|__img__|${candidate.resolvedUrl}`
          );

          const chunkText = candidate.alt
            ? `${candidate.alt}\n\n${description}`
            : description;

          const chunk: Chunk = {
            chunkKey,
            ordinal: 1000 + index,
            url: pageUrl,
            path: pageUrl,
            title: pageTitle,
            sectionTitle: candidate.alt || "Image",
            headingPath: candidate.contextHeading ? [candidate.contextHeading] : [],
            chunkText,
            snippet: toSnippet(description),
            depth: pageDepth,
            incomingLinks: pageIncomingLinks,
            routeFile: pageRouteFile,
            tags: pageTags,
            contentHash: sha256(`${candidate.resolvedUrl}|${description}`),
            contentType: "image",
            imageUrl: candidate.resolvedUrl,
            imageAlt: candidate.alt || undefined
          };

          chunks.push(chunk);
          logger.debug(`Generated image description for ${candidate.resolvedUrl}`);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger.warn(`Image description failed for ${candidate.resolvedUrl}: ${message}`);
        }
      })
    )
  );

  return chunks;
}
