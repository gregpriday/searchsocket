import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * What each `searchsocket add <component>` writes. `entry` is the component the
 * user imports — the CLI needs it named explicitly, because the first file
 * written is not reliably the interesting one now that a template directory
 * also carries a stylesheet, helpers and a shared result row.
 *
 * Each directory is self-contained on purpose: generated code never imports
 * back into node_modules. The shared files are kept in sync from
 * `src/templates/_shared/` by `scripts/sync-templates.mjs`.
 */
const COMPONENTS = {
  "search-dialog": { entry: "SearchDialog.svelte" },
  "search-input": { entry: "SearchInput.svelte" },
  "search-results": { entry: "SearchResults.svelte" },
  "search-trigger": { entry: "SearchTrigger.svelte" },
} as const satisfies Record<string, { entry: string }>;

const AVAILABLE_COMPONENTS = Object.keys(COMPONENTS) as ComponentName[];

export type ComponentName = keyof typeof COMPONENTS;

/** File types a template may contribute. Anything else is ignored. */
const ALLOWED_TEMPLATE_EXTENSIONS = new Set([".svelte", ".ts", ".css", ".svg"]);

export function resolveTemplateDir(): string {
  return path.resolve(__dirname, "templates");
}

export function listAvailableComponents(): string[] {
  return [...AVAILABLE_COMPONENTS];
}

export function isValidComponent(name: string): name is ComponentName {
  return Object.hasOwn(COMPONENTS, name);
}

/** The file a consumer imports after adding `name`. */
export function componentEntryFile(name: ComponentName): string {
  return COMPONENTS[name].entry;
}

export interface CopyResult {
  written: string[];
  skipped: string[];
  /** Absolute path of the entry component, whether it was written or skipped. */
  entry: string;
  /** False when the entry already existed and was left alone. */
  entryWritten: boolean;
}

interface PlannedFile {
  source: string;
  relativeTarget: string;
}

export async function copyComponent(
  name: ComponentName,
  targetDir: string,
  options: { overwrite?: boolean } = {}
): Promise<CopyResult> {
  if (!isValidComponent(name)) {
    throw new Error(`unknown component: ${name}`);
  }

  const templateRoot = resolveTemplateDir();
  const componentDir = path.join(templateRoot, name);
  if (!fs.existsSync(componentDir)) {
    throw new Error(
      `Template directory not found: ${componentDir}. Run "pnpm run build" to generate templates.`
    );
  }

  const planned = await collectTree(componentDir, "");
  if (planned.length === 0) {
    throw new Error(`No template files found in: ${componentDir}`);
  }

  const resolvedTarget = path.resolve(targetDir);
  await fsp.mkdir(resolvedTarget, { recursive: true });

  const written: string[] = [];
  const skipped: string[] = [];

  for (const file of planned) {
    // Every source is derived from a known template directory, and targets are
    // re-checked so a relative path can never escape the output directory.
    const dest = path.resolve(resolvedTarget, file.relativeTarget);
    if (dest !== resolvedTarget && !dest.startsWith(resolvedTarget + path.sep)) {
      throw new Error(`Refusing to write outside the target directory: ${file.relativeTarget}`);
    }

    // lstat, not existsSync: the lexical check above says nothing about where a
    // symlink points, and `--overwrite` would happily follow one out of the
    // target directory. Anything that is not a regular file is refused outright.
    const existing = await lstatOrNull(dest);
    if (existing && !existing.isFile()) {
      throw new Error(
        `Refusing to overwrite ${dest}: expected a regular file, found ${describe(existing)}.`
      );
    }

    if (existing && !options.overwrite) {
      skipped.push(dest);
      continue;
    }

    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.copyFile(file.source, dest);
    written.push(dest);
  }

  const entry = path.resolve(resolvedTarget, COMPONENTS[name].entry);

  return {
    written,
    skipped,
    entry,
    entryWritten: written.includes(entry),
  };
}

async function lstatOrNull(target: string): Promise<fs.Stats | null> {
  try {
    return await fsp.lstat(target);
  } catch {
    return null;
  }
}

function describe(stats: fs.Stats): string {
  if (stats.isSymbolicLink()) return "a symlink";
  if (stats.isDirectory()) return "a directory";
  return "a special file";
}

async function collectTree(dir: string, prefix: string): Promise<PlannedFile[]> {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const files: PlannedFile[] = [];

  for (const entry of entries) {
    const relativeTarget = prefix ? path.join(prefix, entry.name) : entry.name;

    if (entry.isDirectory()) {
      files.push(...(await collectTree(path.join(dir, entry.name), relativeTarget)));
      continue;
    }

    if (!entry.isFile()) continue;
    if (!ALLOWED_TEMPLATE_EXTENSIONS.has(path.extname(entry.name))) continue;

    files.push({ source: path.join(dir, entry.name), relativeTarget });
  }

  return files.sort((a, b) => a.relativeTarget.localeCompare(b.relativeTarget));
}
