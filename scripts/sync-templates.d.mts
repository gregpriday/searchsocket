/** Which shared files each component template directory needs. */
export declare const SHARED_TEMPLATE_FILES: Record<string, string[]>;

/**
 * Mirror `src/templates/_shared/` into each component template directory.
 * Returns the repo-relative paths that were out of date — empty when in sync.
 * With `check: true` nothing is written.
 */
export declare function syncTemplates(options?: { check?: boolean }): string[];
