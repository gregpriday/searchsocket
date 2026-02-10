import fs from "node:fs/promises";
import path from "node:path";
import type { MirrorPage, Scope } from "../types";
import { urlPathToMirrorRelative } from "../utils/path";
import { normalizeMarkdown } from "../utils/text";

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function yamlArray(values: string[]): string {
  return `[${values.map((v) => JSON.stringify(v)).join(", ")}]`;
}

export function buildMirrorMarkdown(page: MirrorPage): string {
  const frontmatterLines = [
    "---",
    `url: ${yamlString(page.url)}`,
    `title: ${yamlString(page.title)}`,
    `scope: ${yamlString(page.scope)}`,
    `routeFile: ${yamlString(page.routeFile)}`,
    `routeResolution: ${yamlString(page.routeResolution)}`,
    `generatedAt: ${yamlString(page.generatedAt)}`,
    `incomingLinks: ${page.incomingLinks}`,
    `outgoingLinks: ${page.outgoingLinks}`,
    `depth: ${page.depth}`,
    `tags: ${yamlArray(page.tags)}`,
    "---",
    ""
  ];

  return `${frontmatterLines.join("\n")}${normalizeMarkdown(page.markdown)}`;
}

function stripGeneratedAt(content: string): string {
  return content.replace(/^generatedAt: .*$/m, "");
}

export async function writeMirrorPage(statePath: string, scope: Scope, page: MirrorPage): Promise<string> {
  const relative = urlPathToMirrorRelative(page.url);
  const outputPath = path.join(statePath, "pages", scope.scopeName, relative);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });

  const newContent = buildMirrorMarkdown(page);

  try {
    const existing = await fs.readFile(outputPath, "utf8");
    if (stripGeneratedAt(existing) === stripGeneratedAt(newContent)) {
      return outputPath;
    }
  } catch {
    // File doesn't exist yet, write it
  }

  await fs.writeFile(outputPath, newContent, "utf8");
  return outputPath;
}

export async function cleanMirrorForScope(statePath: string, scope: Scope): Promise<void> {
  const target = path.join(statePath, "pages", scope.scopeName);
  await fs.rm(target, { recursive: true, force: true });
  await fs.mkdir(target, { recursive: true });
}
