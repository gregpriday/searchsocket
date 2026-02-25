/**
 * Match a URL path against a pattern.
 *
 * Patterns:
 * - `/blog`       — exact match only
 * - `/blog/*`     — matches one level: `/blog/foo` but not `/blog/foo/bar`
 * - `/blog/**`    — matches any depth: `/blog/foo`, `/blog/foo/bar`, etc.
 * - `/`           — exact match for root only
 *
 * Both URL and pattern have trailing slashes stripped (except root "/").
 */
export function matchUrlPattern(url: string, pattern: string): boolean {
  const norm = (p: string) => (p !== "/" && p.endsWith("/") ? p.slice(0, -1) : p);
  const normalizedUrl = norm(url);
  const normalizedPattern = norm(pattern);

  // Globstar: /prefix/**
  if (normalizedPattern.endsWith("/**")) {
    const prefix = normalizedPattern.slice(0, -3);
    if (prefix === "") {
      // /** matches everything
      return true;
    }
    // Match the prefix itself, or anything under it
    return normalizedUrl === prefix || normalizedUrl.startsWith(prefix + "/");
  }

  // Single-level wildcard: /prefix/*
  if (normalizedPattern.endsWith("/*")) {
    const prefix = normalizedPattern.slice(0, -2);
    if (prefix === "") {
      // /* matches single-segment paths like /foo but not /foo/bar
      return normalizedUrl !== "/" && !normalizedUrl.slice(1).includes("/");
    }
    // Must start with prefix/ and have exactly one more segment
    if (!normalizedUrl.startsWith(prefix + "/")) return false;
    const rest = normalizedUrl.slice(prefix.length + 1);
    // rest should be a single segment (no slashes)
    return rest.length > 0 && !rest.includes("/");
  }

  // Exact match
  return normalizedUrl === normalizedPattern;
}

/**
 * Check if a URL matches any of the given patterns.
 */
export function matchUrlPatterns(url: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    if (matchUrlPattern(url, pattern)) return true;
  }
  return false;
}
