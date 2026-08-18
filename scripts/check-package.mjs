#!/usr/bin/env node
/**
 * Verify the published tarball is complete and contains nothing it shouldn't.
 *
 * `pnpm run test` exercises the source tree, which resolves imports that the
 * package may not actually ship. The `./svelte` subpath is the standing example:
 * it publishes raw TypeScript, so adding an import to `src/svelte/*` silently
 * breaks the installed package while every local test stays green. That is
 * exactly how v0.7.1 shipped broken.
 *
 * Run after `pnpm run build`.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));

/** Files the tarball must contain for each declared export to resolve. */
function requiredFiles() {
  const required = new Set();

  for (const [subpath, entry] of Object.entries(pkg.exports ?? {})) {
    for (const target of Object.values(entry)) {
      if (typeof target === "string") {
        required.add(target.replace(/^\.\//, ""));
      }
    }
    void subpath;
  }

  if (pkg.bin) {
    for (const target of Object.values(pkg.bin)) {
      required.add(String(target).replace(/^\.\//, ""));
    }
  }

  return [...required];
}

/**
 * Every local file the raw-source `./svelte` subpath imports, transitively.
 *
 * These are shipped as source, so the tarball needs each one — but `files`
 * lists them by hand, and nothing else notices when a new import is added.
 */
function svelteSourceDependencies() {
  const found = new Set();
  const seen = new Set();
  const queue = [];

  for (const entry of Object.values(pkg.exports?.["./svelte"] ?? {})) {
    if (typeof entry === "string") queue.push(entry.replace(/^\.\//, ""));
  }

  while (queue.length > 0) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);

    const abs = path.join(root, file);
    if (!existsSync(abs)) continue;
    const source = readFileSync(abs, "utf8");

    for (const match of source.matchAll(/from\s+["'](\.[^"']+)["']/g)) {
      const specifier = match[1];
      const resolvedBase = path.join(path.dirname(file), specifier);

      for (const candidate of [
        resolvedBase,
        `${resolvedBase}.ts`,
        `${resolvedBase}.svelte`,
        `${resolvedBase}.svelte.ts`,
        path.join(resolvedBase, "index.ts")
      ]) {
        if (existsSync(path.join(root, candidate))) {
          found.add(candidate);
          queue.push(candidate);
          break;
        }
      }
    }
  }

  return [...found];
}

function packedFiles() {
  // The file listing goes to stderr as `npm notice` lines, while the `prepare`
  // build hook writes to stdout — so `--json` is not parseable here and the
  // listing has to be read from stderr.
  const result = spawnSync("npm", ["pack", "--dry-run", "--loglevel", "notice"], {
    cwd: root,
    encoding: "utf8"
  });
  if (result.status !== 0) {
    console.error(result.stderr || result.stdout);
    throw new Error("`npm pack --dry-run` failed");
  }
  const output = `${result.stderr ?? ""}\n${result.stdout ?? ""}`;

  const files = [];
  for (const line of output.split(/\r?\n/)) {
    // "npm notice 1.2kB dist/index.js"
    const match = line.match(/^npm notice\s+[\d.]+\s*[kMG]?B\s+(.+)$/);
    if (match) files.push(match[1].trim());
  }
  return files;
}

function main() {
  const packed = new Set(packedFiles());
  if (packed.size === 0) {
    console.error("could not determine packed files from `npm pack --dry-run`");
    process.exit(1);
  }

  const problems = [];

  for (const file of requiredFiles()) {
    if (!packed.has(file)) {
      problems.push(`missing: ${file} — an entry in package.json "exports"/"bin" is not packed`);
    }
  }

  for (const file of svelteSourceDependencies()) {
    if (!packed.has(file)) {
      problems.push(
        `missing: ${file} — imported by the raw-source ./svelte export but not in "files"`
      );
    }
  }

  // Things that must never ship.
  for (const file of packed) {
    if (file.endsWith(".map")) problems.push(`unexpected source map: ${file}`);
    if (/(^|\/)\.env/.test(file)) problems.push(`unexpected env file: ${file}`);
    if (/(^|\/)(tests?|__tests__)\//.test(file)) problems.push(`unexpected test file: ${file}`);
    if (file.endsWith(".test.ts") || file.endsWith(".spec.ts")) {
      problems.push(`unexpected test file: ${file}`);
    }
  }

  if (problems.length > 0) {
    console.error(`package check failed (${problems.length} problem(s)):`);
    for (const problem of problems) console.error(`  ${problem}`);
    process.exit(1);
  }

  console.log(`package check passed: ${packed.size} files, all exports resolvable`);
}

main();
