import path from "node:path";

export function normalizeUrlPath(rawPath: string): string {
  let out = rawPath.trim();
  if (!out.startsWith("/")) {
    out = `/${out}`;
  }

  out = out.replace(/\/+/g, "/");

  if (out.length > 1 && out.endsWith("/")) {
    out = out.slice(0, -1);
  }

  return out;
}

export function urlPathToMirrorRelative(urlPath: string): string {
  const normalized = normalizeUrlPath(urlPath);

  if (normalized === "/") {
    return "index.md";
  }

  return `${normalized.slice(1)}.md`;
}

export function staticHtmlFileToUrl(filePath: string, rootDir: string): string {
  const relative = path.relative(rootDir, filePath).replace(/\\/g, "/");

  if (relative === "index.html") {
    return "/";
  }

  if (relative.endsWith("/index.html")) {
    return normalizeUrlPath(relative.slice(0, -"/index.html".length));
  }

  if (relative.endsWith(".html")) {
    return normalizeUrlPath(relative.slice(0, -".html".length));
  }

  return normalizeUrlPath(relative);
}

export function getUrlDepth(urlPath: string): number {
  if (urlPath === "/") {
    return 0;
  }

  return normalizeUrlPath(urlPath)
    .split("/")
    .filter(Boolean).length;
}

export function humanizeUrlPath(urlPath: string): string {
  const normalized = normalizeUrlPath(urlPath);
  if (normalized === "/") return "";
  return normalized
    .slice(1)
    .split("/")
    .map((segment) => segment.replace(/[-_]/g, " "))
    .join(" / ");
}

export function ensureLeadingSlash(value: string): string {
  return value.startsWith("/") ? value : `/${value}`;
}

export function joinUrl(baseUrl: string, route: string): string {
  const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  const routePart = ensureLeadingSlash(route);
  return `${base}${routePart}`;
}
