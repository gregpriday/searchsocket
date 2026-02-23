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

export function toSnippet(markdown: string, maxLen = 220): string {
  const plain = markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/[#>*_|\-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (plain.length <= maxLen) {
    return plain;
  }

  return `${plain.slice(0, Math.max(0, maxLen - 1)).trim()}…`;
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
