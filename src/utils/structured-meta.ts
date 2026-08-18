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
 * Thrown when a filter value cannot be represented in Upstash's filter syntax.
 * Kept local so this module stays importable from the browser bundle, which is
 * why it does not use SearchSocketError.
 */
export class UnsafeFilterValueError extends Error {}

/**
 * Validate a string for use as a single-quoted literal in the Upstash Vector
 * filter DSL.
 *
 * Upstash documents single-quoted literals but specifies **no escape sequence**
 * for an embedded quote or backslash. This function previously doubled quotes
 * SQL-style, which is a guess: if the backend instead treats `\'` as the escape,
 * a value like `x' OR projectId = 'other` survives as filter syntax and widens
 * the query across tenants.
 *
 * Rather than guess, reject. A caller gets a clear error instead of silently
 * wrong — or silently over-broad — results.
 */
export function assertSafeFilterValue(value: string): string {
  if (value.includes("'") || value.includes("\\")) {
    throw new UnsafeFilterValueError(
      "Filter values may not contain a quote or backslash: Upstash Vector's filter " +
        "syntax defines no way to escape them."
    );
  }
  return value;
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
      clauses.push(`${field} CONTAINS '${assertSafeFilterValue(value)}'`);
    } else if (typeof value === "boolean") {
      clauses.push(`${field} = ${value}`);
    } else {
      clauses.push(`${field} = ${value}`);
    }
  }

  return clauses.join(" AND ");
}
