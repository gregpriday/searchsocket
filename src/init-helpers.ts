import fs from "node:fs";
import path from "node:path";

/**
 * Create or merge a .mcp.json file with the searchsocket MCP server entry.
 * Uses ${VAR} env var references that Claude Code expands at runtime.
 * @internal
 */
export function ensureMcpJson(cwd: string): void {
  const mcpPath = path.join(cwd, ".mcp.json");

  const entry = {
    command: "npx",
    args: ["searchsocket", "mcp"],
    env: {
      UPSTASH_SEARCH_REST_URL: "${UPSTASH_SEARCH_REST_URL}",
      UPSTASH_SEARCH_REST_TOKEN: "${UPSTASH_SEARCH_REST_TOKEN}",
    },
  };

  let existing: Record<string, unknown> = {};
  if (fs.existsSync(mcpPath)) {
    try {
      const raw = fs.readFileSync(mcpPath, "utf8");
      existing = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      process.stderr.write("warning: .mcp.json exists but could not be parsed — skipping\n");
      return;
    }
  }

  const servers = (existing.mcpServers ?? {}) as Record<string, unknown>;
  if (JSON.stringify(servers["searchsocket"]) === JSON.stringify(entry)) {
    return;
  }

  existing.mcpServers = { ...servers, searchsocket: entry };
  fs.writeFileSync(mcpPath, JSON.stringify(existing, null, 2) + "\n", "utf8");
}
