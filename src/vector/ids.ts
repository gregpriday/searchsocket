import { SearchSocketError } from "../errors";
import { sha1 } from "../utils/hash";
import type { Scope } from "../types";

/**
 * Version of the record identity and metadata layout.
 *
 * It is part of every record's ID and metadata, and every read filters on it,
 * so records written by an incompatible version are invisible rather than
 * misinterpreted. Bump it whenever the shape of an ID or the meaning of a
 * metadata field changes; doing so requires a full reindex.
 */
export const INDEX_SCHEMA_VERSION = 1;

export type RecordType = "page" | "chunk";

/**
 * Characters permitted in a project id or scope name.
 *
 * Both are embedded in record IDs and in Upstash filter literals, so the set is
 * deliberately narrow: no quotes, no backslashes, and nothing that collides
 * with the ID separator.
 */
const SAFE_NAME_RE = /^[a-zA-Z0-9._-]+$/;
const MAX_NAME_LENGTH = 80;

/** Cannot appear in a project id or scope name, so ID prefixes are unambiguous. */
const SEP = ":";

export function isSafeName(value: string): boolean {
  return value.length > 0 && value.length <= MAX_NAME_LENGTH && SAFE_NAME_RE.test(value);
}

/**
 * Reject a project id or scope name that cannot be safely embedded in a record
 * ID or a filter literal, so a bad value fails at the boundary rather than
 * silently corrupting IDs or escaping filter syntax.
 */
export function assertSafeName(kind: "project id" | "scope name", value: string): void {
  if (!isSafeName(value)) {
    throw new SearchSocketError(
      "INVALID_REQUEST",
      `Invalid ${kind} ${JSON.stringify(value)}. Must be 1-${MAX_NAME_LENGTH} characters of ` +
        "a-z, A-Z, 0-9, dot, underscore, or hyphen.",
      400
    );
  }
}

/**
 * Render a string as a single-quoted literal in the Upstash Vector filter DSL.
 *
 * Upstash documents single-quoted string literals but specifies **no escape
 * sequence** for an embedded quote or backslash — neither SQL-style doubling
 * nor C-style backslashes. Guessing produces a filter that either errors or,
 * worse, silently parses part of the value as syntax: a value of
 * `x' OR projectId = 'other` would widen the query across tenants.
 *
 * So values containing a quote or backslash are rejected rather than escaped.
 * This mirrors what other Upstash clients do for the same reason, and it is the
 * only choice that is provably safe against an undocumented grammar. Project
 * ids and scope names already exclude both characters by validation, so this
 * only ever fires on caller-supplied values.
 */
export function filterStringLiteral(value: string, what: string): string {
  if (value.includes("'") || value.includes("\\")) {
    throw new SearchSocketError(
      "INVALID_REQUEST",
      `${what} may not contain a quote or backslash: Upstash Vector's filter syntax ` +
        "defines no way to escape them.",
      400
    );
  }
  return `'${value}'`;
}

/**
 * Wrap a caller-supplied filter expression so it cannot widen the clauses it is
 * combined with.
 *
 * Upstash gives `AND` higher precedence than `OR`, so appending a bare
 * `a = 1 OR b = 2` to `projectId = 'x' AND ...` yields
 * `(projectId = 'x' AND ... AND a = 1) OR b = 2` — and the trailing disjunct
 * matches records from every project.
 */
export function groupFilter(expression: string): string {
  return `(${expression})`;
}

/**
 * The filter clauses isolating one project, scope, and schema version.
 * Every query, scan, and delete must include them.
 */
export function scopeFilterClauses(scope: Scope): string[] {
  return [
    `projectId = ${filterStringLiteral(scope.projectId, "project id")}`,
    `scopeName = ${filterStringLiteral(scope.scopeName, "scope name")}`,
    `schemaVersion = ${INDEX_SCHEMA_VERSION}`
  ];
}

/**
 * The common prefix of every record belonging to one project, scope, and type.
 * Suitable as an Upstash `range({ prefix })` argument so a scan touches only
 * the requested scope rather than every project sharing the index.
 */
export function recordPrefix(scope: Scope, type: RecordType): string {
  // Validated here, not only at config load: `Scope` is a public type, so a
  // direct consumer of the store can hand over unvalidated names. Without this,
  // project "a:b"/scope "c" and project "a"/scope "b:c" share a prefix and
  // collide.
  assertSafeName("project id", scope.projectId);
  assertSafeName("scope name", scope.scopeName);
  return ["ss", String(INDEX_SCHEMA_VERSION), scope.projectId, scope.scopeName, type, ""].join(SEP);
}

/**
 * Build a page record ID from a page URL.
 *
 * Page IDs used to be the raw URL, so two projects — or two scopes — sharing
 * one Upstash index and both serving `/docs` wrote to the same vector. The
 * later run silently overwrote the earlier one, and a fetch for `/docs` could
 * return either.
 */
export function pageId(scope: Scope, url: string): string {
  return recordPrefix(scope, "page") + encodeURIComponent(url);
}

/** Build a chunk record ID from a stable logical chunk key. */
export function chunkId(scope: Scope, logicalKey: string): string {
  return recordPrefix(scope, "chunk") + logicalKey;
}

/**
 * Recover the logical key from a physical record ID, or `null` when the ID does
 * not belong to this scope, type, and schema version.
 */
export function logicalKeyFromId(
  id: string,
  scope: Scope,
  type: RecordType
): string | null {
  const prefix = recordPrefix(scope, type);
  return id.startsWith(prefix) ? id.slice(prefix.length) : null;
}

/** Recover a page URL from a page record ID. */
export function urlFromPageId(id: string, scope: Scope): string | null {
  const key = logicalKeyFromId(id, scope, "page");
  if (key === null) return null;
  try {
    return decodeURIComponent(key);
  } catch {
    return null;
  }
}

/**
 * A stable identifier for one chunk of a page.
 *
 * Deliberately excludes the chunk's ordinal. Keying on position meant that
 * inserting a paragraph near the top of a page changed the key of every chunk
 * below it, so editing one section re-embedded — and deleted and recreated —
 * the entire page. Keying on the heading path plus a fingerprint of the chunk's
 * own text means only genuinely changed sections churn.
 *
 * `collisionOrdinal` disambiguates a page that repeats an identical section
 * under an identical heading path.
 */
export function chunkLogicalKey(opts: {
  url: string;
  headingPath: string[];
  text: string;
  collisionOrdinal: number;
}): string {
  return sha1(chunkIdentityBase(opts));
}

/**
 * The exact string hashed into a chunk key.
 *
 * Exported so the chunker can group repeated sections on precisely the identity
 * the key uses. Deriving the collision counter from a differently-canonicalised
 * string (say, case-sensitive headings) would assign ordinal 0 to two chunks
 * that then normalise to the same key.
 *
 * Serialised as JSON rather than delimiter-joined: with `a|b` separators,
 * url `/a|b` + heading `c` and url `/a` + heading `b|c` produce an identical
 * preimage, and both `|` in a path and `|` in a Markdown heading are legal.
 * The full text hash is included, not a truncated prefix.
 */
export function chunkIdentityBase(opts: {
  url: string;
  headingPath: string[];
  text: string;
  collisionOrdinal: number;
}): string {
  return JSON.stringify({
    v: INDEX_SCHEMA_VERSION,
    kind: "chunk",
    url: opts.url,
    headings: opts.headingPath.map((h) => h.trim().toLowerCase()),
    // The text is hashed rather than embedded: chunk bodies are far larger than
    // an ID may be, and Upstash bounds ID length.
    text: sha1(opts.text),
    n: opts.collisionOrdinal
  });
}

/**
 * Confirm a record fetched directly by ID belongs to the requested project,
 * scope, and schema version.
 *
 * A direct `fetch()` bypasses the metadata filter that protects queries, so
 * without this check a caller could read another tenant's record by knowing —
 * or guessing — its ID.
 */
export function recordBelongsToScope(
  metadata: { projectId?: string; scopeName?: string; schemaVersion?: number } | undefined,
  scope: Scope
): boolean {
  if (!metadata) return false;
  return (
    metadata.projectId === scope.projectId &&
    metadata.scopeName === scope.scopeName &&
    metadata.schemaVersion === INDEX_SCHEMA_VERSION
  );
}
