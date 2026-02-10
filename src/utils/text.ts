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

export function safeJsonParse<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
