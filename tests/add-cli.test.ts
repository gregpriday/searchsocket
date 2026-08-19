import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(repoRoot, "dist", "cli.js");

function runAdd(cwd: string, args: string[]): string {
  return execFileSync(process.execPath, [cli, "--cwd", cwd, "add", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

describe("searchsocket add (CLI)", () => {
  let tmpDir: string;

  beforeAll(() => {
    // These assertions are about the packaged CLI, so it must be built.
    if (!fs.existsSync(cli)) {
      throw new Error(`dist/cli.js not found — run "pnpm run build" before this suite.`);
    }
  });

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "ss-add-cli-"));
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it("writes a kit whose relative imports all resolve", () => {
    runAdd(tmpDir, ["search-dialog"]);

    const dir = path.join(tmpDir, "src", "lib", "components", "search");
    const files = fs.readdirSync(dir);
    expect(files.sort()).toEqual([
      "SearchDialog.svelte",
      "SearchResultRow.svelte",
      "search-theme.css",
      "search-ui.ts",
    ]);

    for (const file of files) {
      const source = fs.readFileSync(path.join(dir, file), "utf8");
      for (const match of source.matchAll(/from\s+"(\.\/[^"]+)"|import\s+"(\.\/[^"]+)"/g)) {
        const specifier = (match[1] ?? match[2])!.replace(/^\.\//, "");
        const candidates = [specifier, `${specifier}.ts`, `${specifier}.svelte`];
        expect(
          candidates.some((candidate) => fs.existsSync(path.join(dir, candidate))),
          `${file} imports ${specifier}, which was not copied`
        ).toBe(true);
      }
    }
  });

  it("prints the $lib import path for the default directory", () => {
    const output = runAdd(tmpDir, ["search-dialog"]);
    expect(output).toContain('import SearchDialog from "$lib/components/search/SearchDialog.svelte"');
  });

  it("prints a relative import path outside src/lib", () => {
    const output = runAdd(tmpDir, ["search-dialog", "--dir", "components/search"]);
    expect(output).toContain('import SearchDialog from "./components/search/SearchDialog.svelte"');
  });

  it("keeps a second component's shared files and says so", () => {
    runAdd(tmpDir, ["search-dialog"]);
    const output = runAdd(tmpDir, ["search-input"]);

    expect(output).toContain("created:");
    expect(output).toContain("SearchInput.svelte");
    expect(output).toContain("skipped (exists)");
    expect(output).toContain("existing file(s) were kept");
  });

  it("does not describe a template it did not write", () => {
    runAdd(tmpDir, ["search-dialog"]);
    const output = runAdd(tmpDir, ["search-dialog"]);

    expect(output).toContain("already exists and was kept");
    expect(output).toContain("--overwrite");
    // Printing prop instructions here would describe a component the user
    // may not actually have.
    expect(output).not.toContain('theme="inherit"');
  });

  it("replaces everything with --overwrite", () => {
    runAdd(tmpDir, ["search-dialog"]);
    const entry = path.join(tmpDir, "src/lib/components/search/SearchDialog.svelte");
    fs.writeFileSync(entry, "stale", "utf8");

    const output = runAdd(tmpDir, ["search-dialog", "--overwrite"]);
    expect(output).not.toContain("skipped (exists)");
    expect(fs.readFileSync(entry, "utf8")).toContain("createSearch");
  });

  it("rejects an unknown component and lists the real ones", () => {
    expect(() => runAdd(tmpDir, ["search-modal"])).toThrow();

    try {
      runAdd(tmpDir, ["search-modal"]);
    } catch (error) {
      const stderr = String((error as { stderr?: string }).stderr ?? "");
      expect(stderr).toContain("unknown component: search-modal");
      expect(stderr).toContain("search-dialog, search-input, search-results, search-trigger");
    }
  });
});
