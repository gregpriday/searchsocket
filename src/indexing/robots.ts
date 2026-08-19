import fs from "node:fs/promises";
import path from "node:path";

export interface RobotsTxtRules {
  disallow: string[];
  allow: string[];
}

/**
 * Parse a robots.txt string for a specific user-agent.
 * Checks `Searchsocket` first, then falls back to `*`.
 */
export function parseRobotsTxt(content: string, userAgent = "Searchsocket"): RobotsTxtRules {
  const lines = content.split(/\r?\n/);

  // Group rules by user-agent
  const agentGroups = new Map<string, RobotsTxtRules>();
  let currentAgents: string[] = [];
  // Whether the group currently being accumulated has seen any allow/disallow
  // line yet — used to decide when a new user-agent line starts a new group.
  let currentGroupHasRules = false;

  for (const rawLine of lines) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;

    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;

    const directive = line.slice(0, colonIdx).trim().toLowerCase();
    const value = line.slice(colonIdx + 1).trim();

    if (directive === "user-agent") {
      // Per RFC 9309, consecutive user-agent lines share one group, but a
      // user-agent line that *follows* rule lines starts a new group. Without
      // this reset the extremely common pattern
      //
      //   User-agent: *
      //   Disallow: /admin
      //   User-agent: GPTBot
      //   Disallow: /
      //
      // leaked the site-wide block into the `*` group and excluded the entire
      // site from indexing.
      if (currentGroupHasRules) {
        currentAgents = [];
        currentGroupHasRules = false;
      }

      const agentName = value.toLowerCase();
      currentAgents.push(agentName);
      if (!agentGroups.has(agentName)) {
        agentGroups.set(agentName, { disallow: [], allow: [] });
      }
    } else if (directive === "disallow" || directive === "allow") {
      // An empty value ("Disallow:" meaning allow-all) carries no path, but it
      // still counts as a rule line for the purpose of splitting groups.
      currentGroupHasRules = true;

      if (value && currentAgents.length > 0) {
        for (const agent of currentAgents) {
          agentGroups.get(agent)![directive].push(value);
        }
      }
    }
    // Any other directive (sitemap, crawl-delay, host, ...) is ignored and
    // leaves the current group intact — crawl-delay in particular is commonly
    // written *inside* a group, and dropping the group there discarded every
    // rule that followed it.
  }

  // Check for specific user-agent first, then fallback to *
  const specific = agentGroups.get(userAgent.toLowerCase());
  if (specific && (specific.disallow.length > 0 || specific.allow.length > 0)) {
    return specific;
  }

  return agentGroups.get("*") ?? { disallow: [], allow: [] };
}

/**
 * Check if a URL path is blocked by robots.txt rules.
 * Allow rules take precedence over disallow when the allow path is more specific.
 */
export function isBlockedByRobots(urlPath: string, rules: RobotsTxtRules): boolean {
  // Find the longest matching disallow rule
  let longestDisallow = "";
  for (const pattern of rules.disallow) {
    if (urlPath.startsWith(pattern) && pattern.length > longestDisallow.length) {
      longestDisallow = pattern;
    }
  }

  if (!longestDisallow) return false;

  // Check if there's a more specific allow rule
  let longestAllow = "";
  for (const pattern of rules.allow) {
    if (urlPath.startsWith(pattern) && pattern.length > longestAllow.length) {
      longestAllow = pattern;
    }
  }

  // More specific (longer) rule wins; if equal length, allow wins
  return longestAllow.length < longestDisallow.length;
}

/**
 * Load and parse robots.txt from a directory (for static-output/build modes).
 * Returns null if the file doesn't exist.
 */
export async function loadRobotsTxtFromDir(dir: string): Promise<RobotsTxtRules | null> {
  try {
    const content = await fs.readFile(path.join(dir, "robots.txt"), "utf8");
    return parseRobotsTxt(content);
  } catch {
    return null;
  }
}

/**
 * Fetch and parse robots.txt from a URL (for crawl mode).
 * Returns null if the fetch fails or 404s.
 */
export async function fetchRobotsTxt(baseUrl: string): Promise<RobotsTxtRules | null> {
  try {
    const url = new URL("/robots.txt", baseUrl).href;
    const response = await fetch(url);
    if (!response.ok) return null;
    const content = await response.text();
    return parseRobotsTxt(content);
  } catch {
    return null;
  }
}
