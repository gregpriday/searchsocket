/**
 * Utilities for structured per-page metadata: validation, serialization,
 * HTML meta tag parsing, and Upstash Vector filter string construction.
 */

export type MetaValue = string | number | boolean | string[] | Date;
export type PageMeta = Record<string, MetaValue>;

/** Stored metadata values — Date is converted to epoch ms (number) */
export type StoredMetaValue = string | number | boolean | string[];
export type StoredPageMeta = Record<string, StoredMetaValue>;

const VALID_KEY_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export function validateMetaKey(key: string): boolean {
  return VALID_KEY_RE.test(key);
}

export function serializeMetaValue(value: MetaValue): { content: string; dataType: string } {
  if (value instanceof Date) {
    return { content: String(value.getTime()), dataType: "date" };
  }
  if (Array.isArray(value)) {
    return { content: value.join(","), dataType: "string[]" };
  }
  if (typeof value === "boolean") {
    return { content: String(value), dataType: "boolean" };
  }
  if (typeof value === "number") {
    return { content: String(value), dataType: "number" };
  }
  return { content: value, dataType: "string" };
}

export function parseMetaValue(content: string, dataType: string): StoredMetaValue {
  switch (dataType) {
    case "number": {
      const n = Number(content);
      return Number.isFinite(n) ? n : content;
    }
    case "boolean":
      return content === "true";
    case "string[]":
      return content ? content.split(",").map((s) => s.trim()) : [];
    case "date": {
      const ms = Number(content);
      return Number.isFinite(ms) ? ms : content;
    }
    default:
      return content;
  }
}

/**
 * Convert a MetaValue to its stored form (Date → epoch ms number).
 */
export function toStoredValue(value: MetaValue): StoredMetaValue {
  if (value instanceof Date) return value.getTime();
  return value;
}

/**
 * Convert a full PageMeta (which may contain Date values) to StoredPageMeta.
 */
export function toStoredMeta(meta: PageMeta): StoredPageMeta {
  const result: StoredPageMeta = {};
  for (const [key, value] of Object.entries(meta)) {
    if (!validateMetaKey(key)) continue;
    result[key] = toStoredValue(value);
  }
  return result;
}

/**
 * Escape a string value for use in Upstash Vector filter DSL.
 * Single quotes are escaped by doubling them.
 */
export function escapeFilterValue(s: string): string {
  return s.replace(/'/g, "''");
}

/**
 * Build an Upstash Vector filter string from user-supplied metadata filters.
 * Keys are auto-prefixed with `meta.` for the nested storage layout.
 * Uses `CONTAINS` for string values (works with both scalar and array fields)
 * and `=` for numbers and booleans.
 */
export function buildMetaFilterString(
  filters: Record<string, string | number | boolean>
): string {
  const clauses: string[] = [];

  for (const [key, value] of Object.entries(filters)) {
    if (!validateMetaKey(key)) continue;

    const field = `meta.${key}`;

    if (typeof value === "string") {
      clauses.push(`${field} CONTAINS '${escapeFilterValue(value)}'`);
    } else if (typeof value === "boolean") {
      clauses.push(`${field} = ${value}`);
    } else {
      clauses.push(`${field} = ${value}`);
    }
  }

  return clauses.join(" AND ");
}
