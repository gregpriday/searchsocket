import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureMcpJson } from "../src/init-helpers";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "searchsocket-mcp-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => fsp.rm(d, { recursive: true, force: true })));
});

const expectedEntry = {
  command: "npx",
  args: ["searchsocket", "mcp"],
  env: {
    UPSTASH_SEARCH_REST_URL: "${UPSTASH_SEARCH_REST_URL}",
    UPSTASH_SEARCH_REST_TOKEN: "${UPSTASH_SEARCH_REST_TOKEN}",
  },
};

describe("ensureMcpJson", () => {
  it("creates .mcp.json with correct shape in a fresh directory", async () => {
    const dir = await makeTempDir();
    ensureMcpJson(dir);

    const content = JSON.parse(fs.readFileSync(path.join(dir, ".mcp.json"), "utf8"));
    expect(content).toEqual({
      mcpServers: { searchsocket: expectedEntry },
    });
  });

  it("merges into existing .mcp.json without overwriting other entries", async () => {
    const dir = await makeTempDir();
    const existing = {
      mcpServers: {
        "other-tool": { command: "npx", args: ["other-tool", "serve"] },
      },
      customKey: "preserved",
    };
    fs.writeFileSync(path.join(dir, ".mcp.json"), JSON.stringify(existing, null, 2), "utf8");

    ensureMcpJson(dir);

    const content = JSON.parse(fs.readFileSync(path.join(dir, ".mcp.json"), "utf8"));
    expect(content.mcpServers["other-tool"]).toEqual(existing.mcpServers["other-tool"]);
    expect(content.mcpServers.searchsocket).toEqual(expectedEntry);
    expect(content.customKey).toBe("preserved");
  });

  it("is idempotent — calling twice produces identical output", async () => {
    const dir = await makeTempDir();
    ensureMcpJson(dir);
    const first = fs.readFileSync(path.join(dir, ".mcp.json"), "utf8");

    ensureMcpJson(dir);
    const second = fs.readFileSync(path.join(dir, ".mcp.json"), "utf8");

    expect(first).toBe(second);
  });

  it("skips with a warning when .mcp.json contains invalid JSON", async () => {
    const dir = await makeTempDir();
    const mcpPath = path.join(dir, ".mcp.json");
    fs.writeFileSync(mcpPath, "not valid json {{{", "utf8");

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    ensureMcpJson(dir);

    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining("could not be parsed")
    );
    stderrSpy.mockRestore();
    // File should be left unchanged
    expect(fs.readFileSync(mcpPath, "utf8")).toBe("not valid json {{{");
  });

  it("updates a stale searchsocket entry", async () => {
    const dir = await makeTempDir();
    const stale = {
      mcpServers: {
        searchsocket: { command: "npx", args: ["old-searchsocket"] },
      },
    };
    fs.writeFileSync(path.join(dir, ".mcp.json"), JSON.stringify(stale, null, 2), "utf8");

    ensureMcpJson(dir);

    const content = JSON.parse(fs.readFileSync(path.join(dir, ".mcp.json"), "utf8"));
    expect(content.mcpServers.searchsocket).toEqual(expectedEntry);
  });

  it("handles mcpServers being a non-object type gracefully", async () => {
    const dir = await makeTempDir();
    fs.writeFileSync(path.join(dir, ".mcp.json"), JSON.stringify({ mcpServers: "invalid" }, null, 2), "utf8");

    ensureMcpJson(dir);

    const content = JSON.parse(fs.readFileSync(path.join(dir, ".mcp.json"), "utf8"));
    expect(content.mcpServers).toEqual({ searchsocket: expectedEntry });
  });

  it("writes JSON with 2-space indent and trailing newline", async () => {
    const dir = await makeTempDir();
    ensureMcpJson(dir);

    const raw = fs.readFileSync(path.join(dir, ".mcp.json"), "utf8");
    expect(raw).toBe(JSON.stringify({ mcpServers: { searchsocket: expectedEntry } }, null, 2) + "\n");
  });
});
