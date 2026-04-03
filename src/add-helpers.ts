import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const AVAILABLE_COMPONENTS = ["search-dialog", "search-input", "search-results"] as const;
export type ComponentName = (typeof AVAILABLE_COMPONENTS)[number];

export function resolveTemplateDir(): string {
  return path.resolve(__dirname, "templates");
}

export function listAvailableComponents(): string[] {
  return [...AVAILABLE_COMPONENTS];
}

export function isValidComponent(name: string): name is ComponentName {
  return (AVAILABLE_COMPONENTS as readonly string[]).includes(name);
}

export interface CopyResult {
  written: string[];
  skipped: string[];
}

export async function copyComponent(
  name: ComponentName,
  targetDir: string,
  options: { overwrite?: boolean } = {}
): Promise<CopyResult> {
  const templateDir = path.join(resolveTemplateDir(), name);
  if (!fs.existsSync(templateDir)) {
    throw new Error(
      `Template directory not found: ${templateDir}. Run "pnpm run build" to generate templates.`
    );
  }

  const entries = await fsp.readdir(templateDir);
  const svelteFiles = entries.filter((f) => f.endsWith(".svelte"));
  if (svelteFiles.length === 0) {
    throw new Error(`No .svelte files found in template: ${name}`);
  }

  await fsp.mkdir(targetDir, { recursive: true });

  const written: string[] = [];
  const skipped: string[] = [];

  for (const file of svelteFiles) {
    const dest = path.join(targetDir, file);
    if (fs.existsSync(dest) && !options.overwrite) {
      skipped.push(dest);
      continue;
    }
    await fsp.copyFile(path.join(templateDir, file), dest);
    written.push(dest);
  }

  return { written, skipped };
}
