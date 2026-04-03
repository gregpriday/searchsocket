import fs from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import type { PageSourceRecord, ResolvedSearchSocketConfig } from "../../types";
import { normalizeUrlPath } from "../../utils/path";

function filePathToUrl(filePath: string, baseDir: string): string {
  const relative = path.relative(baseDir, filePath).replace(/\\/g, "/");
  const segments = relative.split("/").filter(Boolean);

  if (/(^|\/)\+page\.svelte$/.test(relative)) {
    const routeSegments = segments.slice();

    if ((routeSegments[0] ?? "").toLowerCase() === "src" && (routeSegments[1] ?? "").toLowerCase() === "routes") {
      routeSegments.splice(0, 2);
    } else if ((routeSegments[0] ?? "").toLowerCase() === "routes") {
      routeSegments.splice(0, 1);
    }

    const routePath = routeSegments
      .filter((segment) => segment !== "+page.svelte")
      .filter((segment) => segment && !segment.startsWith("("))
      .map((segment) =>
        segment
          .replace(/^\[\[[^\]]+\]\]$/, "optional")
          .replace(/^\[\.\.\.[^\]]+\]$/, "splat")
          .replace(/^\[[^\]]+\]$/, "param")
      )
      .join("/");

    return normalizeUrlPath(routePath || "/");
  }

  const noExt = relative
    .replace(/\.md$/i, "")
    .replace(/\/index$/i, "");

  return normalizeUrlPath(noExt || "/");
}

/** SvelteKit route file pattern — these are pages, not components. */
const ROUTE_FILE_RE = /\+(page|layout|error)(@[^.]+)?\.svelte$/;

/**
 * Returns true for `.svelte` files that are reusable components (not route files).
 */
export function isSvelteComponentFile(filePath: string): boolean {
  if (!filePath.endsWith(".svelte")) return false;
  return !ROUTE_FILE_RE.test(filePath);
}

export interface SveltePropMeta {
  name: string;
  type?: string;
  default?: string;
}

export interface SvelteComponentMeta {
  description?: string;
  props: SveltePropMeta[];
}

/**
 * Extract `<!-- @component ... -->` description and `$props()` metadata from raw Svelte source.
 */
export function extractSvelteComponentMeta(source: string): SvelteComponentMeta {
  // Extract @component description from HTML comment
  const componentMatch = source.match(/<!--\s*@component\s*([\s\S]*?)\s*-->/);
  const description = componentMatch?.[1]?.trim() || undefined;

  // Extract $props() destructuring
  const propsMatch = source.match(
    /let\s+\{([\s\S]*?)\}\s*(?::\s*([^=;{][\s\S]*?))?\s*=\s*\$props\(\)/
  );

  const props: SveltePropMeta[] = [];

  if (propsMatch) {
    const destructureBlock = propsMatch[1]!;
    const typeAnnotation = propsMatch[2]?.trim();

    // Try to resolve type from interface/type alias if it's a reference name
    let resolvedTypeMap: Map<string, string> | undefined;
    if (typeAnnotation && /^[A-Z]\w*$/.test(typeAnnotation)) {
      resolvedTypeMap = resolveTypeReference(source, typeAnnotation);
    } else if (typeAnnotation && typeAnnotation.startsWith("{")) {
      // Inline type annotation: `{ a: string; b: number }`
      resolvedTypeMap = parseInlineTypeAnnotation(typeAnnotation);
    }

    // Parse the destructure block into individual props
    const propEntries = splitDestructureBlock(destructureBlock);

    for (const entry of propEntries) {
      const trimmed = entry.trim();
      if (!trimmed || trimmed.startsWith("...")) continue;

      // Handle renamed props: `originalName: localName` or `originalName: localName = default`
      // Also handle props with defaults: `name = defaultValue`
      let propName: string;
      let defaultValue: string | undefined;

      const renameMatch = trimmed.match(/^(\w+)\s*:\s*\w+\s*(?:=\s*([\s\S]+))?$/);
      if (renameMatch) {
        propName = renameMatch[1]!;
        defaultValue = renameMatch[2]?.trim();
      } else {
        const defaultMatch = trimmed.match(/^(\w+)\s*=\s*([\s\S]+)$/);
        if (defaultMatch) {
          propName = defaultMatch[1]!;
          defaultValue = defaultMatch[2]?.trim();
        } else {
          propName = trimmed.match(/^(\w+)/)?.[1] ?? trimmed;
        }
      }

      const propType = resolvedTypeMap?.get(propName);

      props.push({
        name: propName,
        ...(propType ? { type: propType } : {}),
        ...(defaultValue ? { default: defaultValue } : {})
      });
    }
  }

  return { description, props };
}

/**
 * Split a destructure block on commas, respecting nested braces/brackets/parens.
 */
function splitDestructureBlock(block: string): string[] {
  const entries: string[] = [];
  let depth = 0;
  let current = "";

  for (const ch of block) {
    if (ch === "{" || ch === "[" || ch === "(") {
      depth++;
      current += ch;
    } else if (ch === "}" || ch === "]" || ch === ")") {
      depth--;
      current += ch;
    } else if (ch === "," && depth === 0) {
      entries.push(current);
      current = "";
    } else {
      current += ch;
    }
  }

  if (current.trim()) entries.push(current);
  return entries;
}

/**
 * Resolve an interface or type alias definition to a map of prop name → type string.
 */
function resolveTypeReference(source: string, typeName: string): Map<string, string> | undefined {
  // Find the opening brace for the interface or type alias
  const startRe = new RegExp(`(?:interface\\s+${typeName}\\s*|type\\s+${typeName}\\s*=\\s*)\\{`);
  const startMatch = source.match(startRe);
  if (!startMatch || startMatch.index === undefined) return undefined;

  // Walk from after the opening brace, tracking brace depth
  const bodyStart = startMatch.index + startMatch[0].length;
  let depth = 1;
  let i = bodyStart;
  while (i < source.length && depth > 0) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") depth--;
    i++;
  }
  if (depth !== 0) return undefined;

  // Extract body between the braces (excluding closing brace)
  const body = source.slice(bodyStart, i - 1);
  return parseTypeMembers(body);
}

/**
 * Parse an inline type annotation like `{ a: string; b: number }`.
 */
function parseInlineTypeAnnotation(annotation: string): Map<string, string> | undefined {
  // Strip outer braces
  const inner = annotation.replace(/^\{/, "").replace(/\}$/, "");
  return parseTypeMembers(inner);
}

/**
 * Parse type members from the body of an interface or inline type.
 */
function parseTypeMembers(body: string): Map<string, string> {
  const map = new Map<string, string>();
  // Split on semicolons or newlines
  const members = body.split(/[;\n]/).map((m) => m.trim()).filter(Boolean);

  for (const member of members) {
    const memberMatch = member.match(/^(\w+)\??\s*:\s*(.+)$/);
    if (memberMatch) {
      map.set(memberMatch[1]!, memberMatch[2]!.replace(/,\s*$/, "").trim());
    }
  }

  return map;
}

/**
 * Build structured markdown prose for a component, optimized for semantic search embedding.
 */
export function buildComponentMarkdown(
  componentName: string,
  meta: SvelteComponentMeta
): string {
  if (!meta.description && meta.props.length === 0) return "";

  const parts: string[] = [`${componentName} component.`];

  if (meta.description) {
    parts.push(meta.description);
  }

  if (meta.props.length > 0) {
    const propEntries = meta.props.map((p) => {
      let entry = p.name;
      if (p.type) entry += ` (${p.type})`;
      if (p.default) entry += ` default: ${p.default}`;
      return entry;
    });
    parts.push(`Props: ${propEntries.join(", ")}.`);
  }

  return parts.join(" ");
}

function normalizeSvelteToMarkdown(source: string): string {
  return source
    .replace(/<script[\s\S]*?<\/script>/g, "")
    .replace(/<style[\s\S]*?<\/style>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\{[^}]+\}/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export async function loadContentFilesPages(
  cwd: string,
  config: ResolvedSearchSocketConfig,
  maxPages?: number
): Promise<PageSourceRecord[]> {
  const contentConfig = config.source.contentFiles;
  if (!contentConfig) {
    throw new Error("content-files config is missing");
  }

  const baseDir = path.resolve(cwd, contentConfig.baseDir);
  const files = await fg(contentConfig.globs, {
    cwd: baseDir,
    absolute: true,
    onlyFiles: true
  });

  const limit = typeof maxPages === "number" ? Math.max(0, Math.floor(maxPages)) : undefined;
  const selected = typeof limit === "number" ? files.slice(0, limit) : files;
  const pages: PageSourceRecord[] = [];

  for (const filePath of selected) {
    const raw = await fs.readFile(filePath, "utf8");
    let markdown: string;
    let tags: string[] | undefined;

    if (filePath.endsWith(".md")) {
      markdown = raw;
    } else if (isSvelteComponentFile(filePath)) {
      // Extract component metadata before normalization strips <script> blocks
      const componentName = path.basename(filePath, ".svelte");
      const meta = extractSvelteComponentMeta(raw);
      const componentMarkdown = buildComponentMarkdown(componentName, meta);
      const templateContent = normalizeSvelteToMarkdown(raw);

      markdown = componentMarkdown
        ? [componentMarkdown, templateContent].filter(Boolean).join("\n\n")
        : templateContent;
      tags = ["component"];
    } else {
      markdown = normalizeSvelteToMarkdown(raw);
    }

    pages.push({
      url: filePathToUrl(filePath, baseDir),
      markdown,
      sourcePath: path.relative(cwd, filePath).replace(/\\/g, "/"),
      outgoingLinks: [],
      ...(tags ? { tags } : {})
    });
  }

  return pages;
}
