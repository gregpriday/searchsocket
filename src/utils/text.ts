export function normalizeText(input: string): string {
  return input.replace(/\r\n/g, "\n").replace(/\s+/g, " ").trim();
}

export function normalizeMarkdown(input: string): string {
  return input.replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "").trim() + "\n";
}

export function sanitizeScopeName(scopeName: string): string {
  return scopeName
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function markdownToPlain(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/[#>*_|\-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function toSnippet(markdown: string, maxLen = 220): string {
  const plain = markdownToPlain(markdown);

  if (plain.length <= maxLen) {
    return plain;
  }

  return `${plain.slice(0, Math.max(0, maxLen - 1)).trim()}…`;
}

export function queryAwareExcerpt(markdown: string, query: string, maxLen = 220): string {
  const plain = markdownToPlain(markdown);
  if (plain.length <= maxLen) return plain;

  const tokens = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length >= 2);

  if (tokens.length === 0) return toSnippet(markdown, maxLen);

  // Find all match positions in the plain text, tagged by token index
  const positions: Array<{ start: number; end: number; tokenIdx: number }> = [];
  for (let ti = 0; ti < tokens.length; ti++) {
    const escaped = tokens[ti]!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(escaped, "gi");
    let m: RegExpExecArray | null;
    while ((m = re.exec(plain)) !== null) {
      positions.push({ start: m.index, end: m.index + m[0].length, tokenIdx: ti });
    }
  }

  if (positions.length === 0) return toSnippet(markdown, maxLen);

  positions.sort((a, b) => a.start - b.start);

  // Two-pointer sliding window: find the window with most unique terms fitting in maxLen chars
  // Tie-break by total match count
  let bestUniqueCount = 0;
  let bestTotalCount = 0;
  let bestLeft = 0;
  let bestRight = 0;
  let left = 0;
  const tokenCounts = new Map<number, number>();

  for (let right = 0; right < positions.length; right++) {
    tokenCounts.set(positions[right]!.tokenIdx, (tokenCounts.get(positions[right]!.tokenIdx) ?? 0) + 1);

    // Shrink from left while the window span exceeds maxLen
    while (positions[right]!.end - positions[left]!.start > maxLen && left < right) {
      const leftToken = positions[left]!.tokenIdx;
      const cnt = tokenCounts.get(leftToken)! - 1;
      if (cnt === 0) tokenCounts.delete(leftToken);
      else tokenCounts.set(leftToken, cnt);
      left++;
    }

    const uniqueCount = tokenCounts.size;
    const totalCount = right - left + 1;
    if (uniqueCount > bestUniqueCount || (uniqueCount === bestUniqueCount && totalCount > bestTotalCount)) {
      bestUniqueCount = uniqueCount;
      bestTotalCount = totalCount;
      bestLeft = left;
      bestRight = right;
    }
  }

  // Center the excerpt around the midpoint of the best window
  const mid = Math.floor((positions[bestLeft]!.start + positions[bestRight]!.end) / 2);
  let start = Math.max(0, mid - Math.floor(maxLen / 2));
  let end = Math.min(plain.length, start + maxLen);
  // Re-adjust start if end hit the boundary
  start = Math.max(0, end - maxLen);

  // Snap to word boundaries
  if (start > 0) {
    const spaceIdx = plain.lastIndexOf(" ", start);
    if (spaceIdx > start - 30) {
      start = spaceIdx + 1;
    }
  }
  if (end < plain.length) {
    const spaceIdx = plain.indexOf(" ", end);
    if (spaceIdx !== -1 && spaceIdx < end + 30) {
      end = spaceIdx;
    }
  }

  let excerpt = plain.slice(start, end);

  // Hard-trim if word-boundary snapping expanded beyond limit
  if (excerpt.length > Math.ceil(maxLen * 1.2)) {
    excerpt = excerpt.slice(0, maxLen);
    const lastSpace = excerpt.lastIndexOf(" ");
    if (lastSpace > maxLen * 0.5) {
      excerpt = excerpt.slice(0, lastSpace);
    }
  }

  const prefix = start > 0 ? "…" : "";
  const suffix = end < plain.length ? "…" : "";
  return `${prefix}${excerpt}${suffix}`;
}

export function extractFirstParagraph(markdown: string): string {
  const lines = markdown.split("\n");
  let inFence = false;
  const collected: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    if (/^(```|~~~)/.test(trimmed)) {
      inFence = !inFence;
      if (collected.length > 0) break;
      continue;
    }

    if (inFence) continue;

    // Skip headings
    if (/^#{1,6}\s/.test(trimmed)) {
      if (collected.length > 0) break;
      continue;
    }

    // Empty line ends a paragraph
    if (!trimmed) {
      if (collected.length > 0) break;
      continue;
    }

    collected.push(trimmed);
  }

  return collected.join(" ");
}

export function safeJsonParse<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
