import type { RelatedPage, RelatedPagesResult, SearchResult } from "../types";

/**
 * One rule for what is privileged, applied to every surface that can serve an
 * unauthenticated caller.
 *
 * The browser API has always stripped these fields unless the deployment sets
 * `api.exposeInternalFields`. MCP used to be unconditionally key-gated, so it
 * had no need for them — `mcp.handle.access: "public"` changes that, and both
 * surfaces now decide with the same `redact` flag rather than each carrying its
 * own notion of what a public caller may see.
 *
 * These take a plain boolean rather than the resolved config so the MCP server
 * can reuse them without importing the SvelteKit handle (which imports it).
 */

/**
 * Strip repository paths from a page-retrieval response.
 *
 * `getPage` returns the page's indexed markdown, which is fine — it is the same
 * content the site already serves publicly. `routeFile` is not: it is a path
 * inside the author's repository, useful to an editing agent and disclosed to
 * nobody else.
 */
export function toPublicPage<T extends { frontmatter?: Record<string, unknown> }>(
  page: T,
  redact: boolean
): T {
  if (!redact) return page;
  if (!page.frontmatter) return page;

  const { routeFile: _routeFile, ...frontmatter } = page.frontmatter;
  return { ...page, frontmatter };
}

/**
 * Strip fields a public search response should not carry.
 *
 * `routeFile` is a path inside the author's repository and `chunkText` is the
 * indexed text of a matched section rather than a snippet. Both are useful to an MCP
 * client editing the site and neither belongs in a public search box, so they
 * are opt-in via `api.exposeInternalFields`.
 */
export function toPublicResults(results: SearchResult[], redact: boolean): SearchResult[] {
  if (!redact) return results;

  return results.map((result) => {
    const { routeFile: _routeFile, chunkText: _chunkText, breakdown: _breakdown, ...rest } = result;
    return {
      ...rest,
      chunks: result.chunks?.map((chunk) => {
        const { chunkText: _chunkChunkText, ...chunkRest } = chunk;
        return chunkRest;
      })
    } as SearchResult;
  });
}

/**
 * Strip repository paths from a related-pages response.
 *
 * `get_related_pages` has no browser-API equivalent, so this leak went
 * unnoticed until MCP could serve an anonymous caller: every entry carries a
 * `routeFile`, which is the same repository path the other two surfaces hide.
 *
 * The engine always produces `routeFile`, so `RelatedPage` keeps it required
 * and the stripped shape is a separate type. Widening the domain type because
 * one serializer drops the field would break every consumer that reads it.
 */
export interface PublicRelatedPagesResult extends Omit<RelatedPagesResult, "relatedPages"> {
  relatedPages: Array<Omit<RelatedPage, "routeFile">>;
}

export function toPublicRelatedPages(
  result: RelatedPagesResult,
  redact: boolean
): RelatedPagesResult | PublicRelatedPagesResult {
  if (!redact) return result;

  return {
    ...result,
    relatedPages: result.relatedPages.map((page) => {
      const { routeFile: _routeFile, ...rest } = page;
      return rest;
    })
  };
}
