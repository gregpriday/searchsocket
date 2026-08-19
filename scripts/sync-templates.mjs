#!/usr/bin/env node
/**
 * Mirror `src/templates/_shared/` into each component template directory.
 *
 * Every `searchsocket add` writes a self-contained directory — the generated
 * code never imports back into node_modules — which means the support files are
 * duplicated per component. `_shared/` is the single source of truth; this
 * script propagates it, and `tests/template-sync.test.ts` fails if a copy
 * drifts.
 *
 * Run after editing anything in `src/templates/_shared/`:
 *   pnpm run sync:templates
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const templatesDir = path.join(root, "src", "templates");
const sharedDir = path.join(templatesDir, "_shared");

/** Which shared files each component directory needs. */
export const SHARED_TEMPLATE_FILES = {
  "search-dialog": ["SearchResultRow.svelte", "search-ui.ts", "search-theme.css"],
  "search-input": ["SearchResultRow.svelte", "search-ui.ts", "search-theme.css"],
  "search-results": ["SearchResultRow.svelte", "search-ui.ts", "search-theme.css"],
  "search-trigger": ["search-ui.ts", "search-theme.css"]
};

export function syncTemplates({ check = false } = {}) {
  const drifted = [];

  for (const [component, files] of Object.entries(SHARED_TEMPLATE_FILES)) {
    for (const file of files) {
      const source = path.join(sharedDir, file);
      const target = path.join(templatesDir, component, file);

      if (!existsSync(source)) {
        throw new Error(`missing shared template file: ${path.relative(root, source)}`);
      }

      const expected = readFileSync(source, "utf8");
      const actual = existsSync(target) ? readFileSync(target, "utf8") : null;
      if (actual === expected) continue;

      drifted.push(path.relative(root, target));
      if (!check) writeFileSync(target, expected, "utf8");
    }
  }

  return drifted;
}

// String-building a file:// URL breaks on paths needing escapes and on Windows,
// which would silently skip the sync during `pnpm run build`.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const check = process.argv.includes("--check");
  const drifted = syncTemplates({ check });

  if (drifted.length === 0) {
    console.log("templates in sync");
  } else if (check) {
    console.error("template copies are out of sync with src/templates/_shared:");
    for (const file of drifted) console.error(`  ${file}`);
    console.error("\nrun: pnpm run sync:templates");
    process.exit(1);
  } else {
    console.log(`synced ${drifted.length} file(s):`);
    for (const file of drifted) console.log(`  ${file}`);
  }
}
