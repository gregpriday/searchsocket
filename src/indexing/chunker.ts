import type { Chunk, MirrorPage, ResolvedSearchSocketConfig, Scope } from "../types";
import { sha1, sha256 } from "../utils/hash";
import { normalizeText, toSnippet } from "../utils/text";

interface Section {
  sectionTitle?: string;
  headingPath: string[];
  text: string;
}

const FENCE_LINE_RE = /^(```|~~~)/;

function parseHeadingSections(markdown: string, headingPathDepth: number): Section[] {
  const lines = markdown.split("\n");
  const sections: Section[] = [];

  const headingStack: Array<string | undefined> = [];
  let inFence = false;

  let current: Section = {
    sectionTitle: undefined,
    headingPath: [],
    text: ""
  };

  const flush = (): void => {
    if (normalizeText(current.text)) {
      sections.push({
        sectionTitle: current.sectionTitle,
        headingPath: current.headingPath,
        text: current.text.trim()
      });
    }
  };

  for (const line of lines) {
    if (FENCE_LINE_RE.test(line.trim())) {
      inFence = !inFence;
    }

    const headingMatch = !inFence ? line.match(/^(#{1,6})\s+(.+)$/) : null;
    if (headingMatch) {
      flush();

      const level = (headingMatch[1] ?? "#").length;
      const title = (headingMatch[2] ?? "").trim();
      headingStack[level - 1] = title;
      headingStack.length = level;

      current = {
        sectionTitle: title,
        headingPath: headingStack.filter((entry): entry is string => Boolean(entry)).slice(0, headingPathDepth),
        text: `${line}\n`
      };
      continue;
    }

    current.text += `${line}\n`;
  }

  flush();

  if (sections.length === 0 && normalizeText(markdown)) {
    sections.push({
      sectionTitle: undefined,
      headingPath: [],
      text: markdown.trim()
    });
  }

  return sections;
}

function blockify(text: string, config: ResolvedSearchSocketConfig["chunking"]): string[] {
  const lines = text.split("\n");
  const blocks: string[] = [];

  let inFence = false;
  let current: string[] = [];

  const flush = (): void => {
    const value = current.join("\n").trim();
    if (value) {
      blocks.push(value);
    }
    current = [];
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();

    if (FENCE_LINE_RE.test(trimmed)) {
      inFence = !inFence;
      current.push(line);
      continue;
    }

    if (inFence) {
      current.push(line);
      continue;
    }

    const isTableLine = /^\|.*\|$/.test(trimmed) || /^\|?\s*:?-+:?\s*\|/.test(trimmed);
    const isQuoteLine = /^>/.test(trimmed);

    if (isTableLine && config.dontSplitInside.includes("table")) {
      current.push(line);
      while (i + 1 < lines.length) {
        const next = lines[i + 1];
        if (!next || !/^\|/.test(next.trim())) {
          break;
        }
        i += 1;
        current.push(lines[i] ?? "");
      }
      continue;
    }

    if (isQuoteLine && config.dontSplitInside.includes("blockquote")) {
      current.push(line);
      while (i + 1 < lines.length) {
        const next = lines[i + 1];
        if (!next || !/^>/.test(next.trim())) {
          break;
        }
        i += 1;
        current.push(lines[i] ?? "");
      }
      continue;
    }

    if (!trimmed) {
      flush();
      continue;
    }

    current.push(line);
  }

  flush();
  return blocks;
}

function isProtectedBlock(block: string, config: ResolvedSearchSocketConfig["chunking"]): boolean {
  const lines = block.trim().split("\n");
  const first = (lines[0] ?? "").trim();
  const last = (lines[lines.length - 1] ?? "").trim();

  const isCodeBlock = FENCE_LINE_RE.test(first) && FENCE_LINE_RE.test(last);
  if (isCodeBlock && config.dontSplitInside.includes("code")) {
    return true;
  }

  const isTableBlock = lines.every((line) => {
    const trimmed = line.trim();
    return trimmed.length === 0 || /^\|.*\|$/.test(trimmed) || /^\|?\s*:?-+:?\s*\|/.test(trimmed);
  });
  if (isTableBlock && config.dontSplitInside.includes("table")) {
    return true;
  }

  const isQuoteBlock = lines.every((line) => {
    const trimmed = line.trim();
    return trimmed.length === 0 || trimmed.startsWith(">");
  });
  return isQuoteBlock && config.dontSplitInside.includes("blockquote");
}

function splitOversizedBlock(block: string, config: ResolvedSearchSocketConfig["chunking"]): string[] {
  const trimmed = block.trim();
  if (trimmed.length <= config.maxChars || isProtectedBlock(trimmed, config)) {
    return [trimmed];
  }

  const chunks: string[] = [];
  let start = 0;

  while (start < trimmed.length) {
    let end = Math.min(start + config.maxChars, trimmed.length);

    if (end < trimmed.length) {
      const boundary = trimmed.lastIndexOf(" ", end);
      if (boundary > start + Math.floor(config.maxChars * 0.6)) {
        end = boundary;
      }
    }

    const chunk = trimmed.slice(start, end).trim();
    if (chunk) {
      chunks.push(chunk);
    }

    if (end >= trimmed.length) {
      break;
    }

    const nextStart = Math.max(0, end - config.overlapChars);
    start = nextStart > start ? nextStart : end;
  }

  return chunks.length > 0 ? chunks : [trimmed];
}

function splitSection(section: Section, config: ResolvedSearchSocketConfig["chunking"]): Array<Pick<Chunk, "sectionTitle" | "headingPath" | "chunkText">> {
  const text = section.text.trim();
  if (!text) {
    return [];
  }

  if (text.length <= config.maxChars) {
    return [
      {
        sectionTitle: section.sectionTitle,
        headingPath: section.headingPath,
        chunkText: text
      }
    ];
  }

  const blocks = blockify(text, config);
  const chunks: string[] = [];
  let current = "";

  for (const block of blocks) {
    const pieces = splitOversizedBlock(block, config);

    for (const piece of pieces) {
      if (!current) {
        current = piece;
        continue;
      }

      const candidate = `${current}\n\n${piece}`;
      if (candidate.length <= config.maxChars) {
        current = candidate;
        continue;
      }

      chunks.push(current);

      const overlap = current.slice(Math.max(0, current.length - config.overlapChars)).trim();
      const withOverlap = overlap ? `${overlap}\n\n${piece}` : piece;
      current = withOverlap.length <= config.maxChars ? withOverlap : piece;
    }
  }

  if (current.trim()) {
    chunks.push(current.trim());
  }

  const merged: string[] = [];
  for (const chunk of chunks) {
    if (merged.length === 0) {
      merged.push(chunk);
      continue;
    }

    const canMerge =
      chunk.length < config.minChars &&
      merged[merged.length - 1] !== undefined &&
      (merged[merged.length - 1]?.length ?? 0) + 2 + chunk.length <= config.maxChars;

    if (canMerge) {
      merged[merged.length - 1] = `${merged[merged.length - 1]}\n\n${chunk}`;
    } else {
      merged.push(chunk);
    }
  }

  return merged.map((chunkText) => ({
    sectionTitle: section.sectionTitle,
    headingPath: section.headingPath,
    chunkText
  }));
}

export function chunkMirrorPage(
  page: MirrorPage,
  config: ResolvedSearchSocketConfig,
  scope: Scope
): Chunk[] {
  const sections = parseHeadingSections(page.markdown, config.chunking.headingPathDepth);
  const rawChunks = sections.flatMap((section) => splitSection(section, config.chunking));

  return rawChunks.map((entry, index) => {
    const sectionTitleNormalized = normalizeText(entry.sectionTitle ?? "").toLowerCase();
    const chunkTextNormalized = normalizeText(entry.chunkText);
    const chunkKey = sha1(
      `${scope.scopeName}|${page.url}|${index}|${sectionTitleNormalized}`
    );

    return {
      chunkKey,
      ordinal: index,
      url: page.url,
      path: page.url,
      title: page.title,
      sectionTitle: entry.sectionTitle,
      headingPath: entry.headingPath,
      chunkText: entry.chunkText,
      snippet: toSnippet(entry.chunkText),
      depth: page.depth,
      incomingLinks: page.incomingLinks,
      routeFile: page.routeFile,
      tags: page.tags,
      contentHash: sha256(chunkTextNormalized)
    } satisfies Chunk;
  });
}
