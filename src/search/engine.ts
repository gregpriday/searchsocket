import path from "node:path";
import { z } from "zod";
import { SearchSocketError } from "../errors";
import { loadConfig } from "../config/load";
import { resolveScope } from "../core/scope";
import { hrTimeMs } from "../utils/time";
import { normalizeUrlPath } from "../utils/path";
import { createUpstashStore } from "../vector/factory";
import { rankHits, aggregateByPage, trimByScoreGap, mergePageAndChunkResults } from "./ranking";
import type {
  PageHit,
  ResolvedSearchSocketConfig,
  SearchRequest,
  SearchResponse,
  SearchResult,
  SiteStructureResult,
  SiteTreeNode,
  VectorHit
} from "../types";
import type { UpstashSearchStore } from "../vector/upstash";
import type { RankedHit, PageResult } from "./ranking";
import { toSnippet } from "../utils/text";
import { isServerless } from "../core/serverless";
import { logAnalyticsEvent } from "../analytics/logger";

const requestSchema = z.object({
  q: z.string().trim().min(1),
  topK: z.number().int().positive().max(100).optional(),
  scope: z.string().optional(),
  pathPrefix: z.string().optional(),
  tags: z.array(z.string()).optional(),
  groupBy: z.enum(["page", "chunk"]).optional()
});

const MAX_SITE_STRUCTURE_PAGES = 2000;

function makeNode(url: string, depth: number): SiteTreeNode {
  return { url, title: "", depth, routeFile: "", isIndexed: false, childCount: 0, children: [] };
}

export function buildTree(
  pages: Array<{ url: string; title: string; routeFile: string }>,
  pathPrefix?: string
): SiteTreeNode {
  const nodeMap = new Map<string, SiteTreeNode>();
  const root = makeNode("/", 0);
  nodeMap.set("/", root);

  // Ensure all intermediate nodes exist and set data for real pages
  for (const page of pages) {
    const normalized = normalizeUrlPath(page.url);
    const segments = normalized.split("/").filter(Boolean);

    if (segments.length === 0) {
      // Root page "/"
      root.title = page.title;
      root.routeFile = page.routeFile;
      root.isIndexed = true;
      continue;
    }

    // Ensure all intermediate nodes exist
    for (let i = 1; i <= segments.length; i++) {
      const partialUrl = "/" + segments.slice(0, i).join("/");
      if (!nodeMap.has(partialUrl)) {
        nodeMap.set(partialUrl, makeNode(partialUrl, i));
      }
    }

    // Set real page data on the leaf node
    const node = nodeMap.get(normalized)!;
    node.title = page.title;
    node.routeFile = page.routeFile;
    node.isIndexed = true;
  }

  // Wire parent-child relationships
  for (const [url, node] of nodeMap) {
    if (url === "/") continue;
    const segments = url.split("/").filter(Boolean);
    const parentUrl = segments.length === 1 ? "/" : "/" + segments.slice(0, -1).join("/");
    const parent = nodeMap.get(parentUrl) ?? root;
    parent.children.push(node);
  }

  // Sort children alphabetically and set childCount
  const sortAndCount = (node: SiteTreeNode): void => {
    node.children.sort((a, b) => a.url.localeCompare(b.url));
    node.childCount = node.children.length;
    for (const child of node.children) {
      sortAndCount(child);
    }
  };
  sortAndCount(root);

  // If pathPrefix is specified, return the subtree rooted at that path
  if (pathPrefix) {
    const normalizedPrefix = normalizeUrlPath(pathPrefix);
    const subtreeRoot = nodeMap.get(normalizedPrefix);
    if (subtreeRoot) {
      return subtreeRoot;
    }
    // If the prefix node doesn't exist, return an empty placeholder
    return makeNode(normalizedPrefix, normalizedPrefix.split("/").filter(Boolean).length);
  }

  return root;
}

export interface SearchEngineOptions {
  cwd?: string;
  configPath?: string;
  config?: ResolvedSearchSocketConfig;
  store?: UpstashSearchStore;
}

export class SearchEngine {
  private readonly cwd: string;
  private readonly config: ResolvedSearchSocketConfig;
  private readonly store: UpstashSearchStore;

  private constructor(options: {
    cwd: string;
    config: ResolvedSearchSocketConfig;
    store: UpstashSearchStore;
  }) {
    this.cwd = options.cwd;
    this.config = options.config;
    this.store = options.store;
  }

  static async create(options: SearchEngineOptions = {}): Promise<SearchEngine> {
    const cwd = path.resolve(options.cwd ?? process.cwd());
    const config = options.config ?? (await loadConfig({ cwd, configPath: options.configPath }));

    const store = options.store ?? await createUpstashStore(config);

    return new SearchEngine({
      cwd,
      config,
      store
    });
  }

  getConfig(): ResolvedSearchSocketConfig {
    return this.config;
  }

  async search(request: SearchRequest): Promise<SearchResponse> {
    const parsed = requestSchema.safeParse(request);
    if (!parsed.success) {
      throw new SearchSocketError("INVALID_REQUEST", parsed.error.issues[0]?.message ?? "Invalid request", 400);
    }

    const input = parsed.data;
    const totalStart = process.hrtime.bigint();

    const resolvedScope = resolveScope(this.config, input.scope);

    const topK = input.topK ?? 10;
    const groupByPage = (input.groupBy ?? "page") === "page";
    // Fetch more candidates for page aggregation
    const candidateK = groupByPage
      ? Math.max(topK * 10, 50)
      : Math.max(50, topK);

    // Build filter string for Upstash Search
    const filterParts: string[] = [];
    if (input.pathPrefix) {
      const prefix = input.pathPrefix.startsWith("/") ? input.pathPrefix : `/${input.pathPrefix}`;
      filterParts.push(`url GLOB '${prefix}*'`);
    }
    if (input.tags && input.tags.length > 0) {
      for (const tag of input.tags) {
        filterParts.push(`tags GLOB '*${tag}*'`);
      }
    }
    const filter = filterParts.length > 0 ? filterParts.join(" AND ") : undefined;

    const useDualSearch = this.config.search.dualSearch && groupByPage;

    const searchStart = process.hrtime.bigint();
    let ranked: RankedHit[];

    if (useDualSearch) {
      // Parallel search: reranked page search + fast chunk search
      const chunkLimit = Math.max(topK * 10, 100);
      const pageLimit = 20;

      const [pageHits, chunkHits] = await Promise.all([
        this.store.searchPages(
          input.q,
          {
            limit: pageLimit,
            semanticWeight: this.config.search.semanticWeight,
            inputEnrichment: this.config.search.inputEnrichment,
            filter
          },
          resolvedScope
        ),
        this.store.search(
          input.q,
          {
            limit: chunkLimit,
            semanticWeight: this.config.search.semanticWeight,
            inputEnrichment: this.config.search.inputEnrichment,
            reranking: false,
            filter
          },
          resolvedScope
        )
      ]);

      const rankedChunks = rankHits(chunkHits, this.config, input.q);
      ranked = mergePageAndChunkResults(pageHits, rankedChunks, this.config);
    } else {
      // Legacy single-search behavior
      const hits = await this.store.search(
        input.q,
        {
          limit: candidateK,
          semanticWeight: this.config.search.semanticWeight,
          inputEnrichment: this.config.search.inputEnrichment,
          reranking: this.config.search.reranking,
          filter
        },
        resolvedScope
      );
      ranked = rankHits(hits, this.config, input.q);
    }
    const searchMs = hrTimeMs(searchStart);

    const results = this.buildResults(ranked, topK, groupByPage, input.q);

    if (this.config.analytics.enabled && !isServerless()) {
      const logPath = path.join(this.cwd, this.config.state.dir, "analytics.jsonl");
      logAnalyticsEvent(logPath, {
        ts: new Date().toISOString(),
        q: input.q,
        results: results.length,
        latencyMs: Math.round(hrTimeMs(totalStart))
      });
    }

    return {
      q: input.q,
      scope: resolvedScope.scopeName,
      results,
      meta: {
        timingsMs: {
          search: Math.round(searchMs),
          total: Math.round(hrTimeMs(totalStart))
        }
      }
    };
  }

  private ensureSnippet(hit: RankedHit): string {
    const snippet = hit.hit.metadata.snippet;
    if (snippet && snippet.length >= 30) return snippet;
    const chunkText = hit.hit.metadata.chunkText;
    if (chunkText) return toSnippet(chunkText);
    return snippet || "";
  }

  private buildResults(ordered: RankedHit[], topK: number, groupByPage: boolean, _query?: string): SearchResult[] {
    if (groupByPage) {
      let pages = aggregateByPage(ordered, this.config);
      pages = trimByScoreGap(pages, this.config);
      const minRatio = this.config.ranking.minChunkScoreRatio;
      return pages.slice(0, topK).map((page) => {
        const bestScore = page.bestChunk.finalScore;
        const minChunkScore = Number.isFinite(bestScore) ? bestScore * minRatio : Number.NEGATIVE_INFINITY;
        const meaningful = page.matchingChunks
          .filter((c) => c.finalScore >= minChunkScore)
          .slice(0, 5);
        return {
          url: page.url,
          title: page.title,
          sectionTitle: page.bestChunk.hit.metadata.sectionTitle || undefined,
          snippet: this.ensureSnippet(page.bestChunk),
          score: Number(page.pageScore.toFixed(6)),
          routeFile: page.routeFile,
          chunks: meaningful.length > 1
            ? meaningful.map((c) => ({
                sectionTitle: c.hit.metadata.sectionTitle || undefined,
                snippet: this.ensureSnippet(c),
                headingPath: c.hit.metadata.headingPath,
                score: Number(c.finalScore.toFixed(6))
              }))
            : undefined
        };
      });
    } else {
      let filtered = ordered;
      const minScore = this.config.ranking.minScore;
      if (minScore > 0) {
        filtered = ordered.filter((entry) => entry.finalScore >= minScore);
      }
      return filtered.slice(0, topK).map(({ hit, finalScore }) => ({
        url: hit.metadata.url,
        title: hit.metadata.title,
        sectionTitle: hit.metadata.sectionTitle || undefined,
        snippet: this.ensureSnippet({ hit, finalScore }),
        score: Number(finalScore.toFixed(6)),
        routeFile: hit.metadata.routeFile
      }));
    }
  }

  async getPage(pathOrUrl: string, scope?: string): Promise<{
    url: string;
    frontmatter: Record<string, unknown>;
    markdown: string;
  }> {
    const resolvedScope = resolveScope(this.config, scope);
    const urlPath = this.resolveInputPath(pathOrUrl);
    const page = await this.store.getPage(urlPath, resolvedScope);

    if (!page) {
      throw new SearchSocketError("INVALID_REQUEST", `Indexed page not found for ${urlPath}`, 404);
    }

    return {
      url: page.url,
      frontmatter: {
        url: page.url,
        title: page.title,
        routeFile: page.routeFile,
        routeResolution: page.routeResolution,
        incomingLinks: page.incomingLinks,
        outgoingLinks: page.outgoingLinks,
        depth: page.depth,
        tags: page.tags,
        indexedAt: page.indexedAt
      },
      markdown: page.markdown
    };
  }

  async listPages(opts?: {
    pathPrefix?: string;
    cursor?: string;
    limit?: number;
    scope?: string;
  }): Promise<{
    pages: Array<{ url: string; title: string; description: string; routeFile: string }>;
    nextCursor?: string;
  }> {
    const resolvedScope = resolveScope(this.config, opts?.scope);
    const pathPrefix = opts?.pathPrefix
      ? (opts.pathPrefix.startsWith("/") ? opts.pathPrefix : `/${opts.pathPrefix}`)
      : undefined;
    return this.store.listPages(resolvedScope, {
      cursor: opts?.cursor,
      limit: opts?.limit,
      pathPrefix
    });
  }

  async getSiteStructure(opts?: {
    pathPrefix?: string;
    scope?: string;
    maxPages?: number;
  }): Promise<SiteStructureResult> {
    const maxPages = Math.min(opts?.maxPages ?? MAX_SITE_STRUCTURE_PAGES, MAX_SITE_STRUCTURE_PAGES);
    const allPages: Array<{ url: string; title: string; description: string; routeFile: string }> = [];
    let cursor: string | undefined;
    let truncated = false;

    do {
      const result = await this.listPages({
        pathPrefix: opts?.pathPrefix,
        scope: opts?.scope,
        cursor,
        limit: 200
      });
      allPages.push(...result.pages);
      cursor = result.nextCursor;

      if (allPages.length >= maxPages) {
        truncated = allPages.length > maxPages;
        allPages.length = maxPages;
        break;
      }
    } while (cursor);

    const root = buildTree(allPages, opts?.pathPrefix);

    return {
      root,
      totalPages: allPages.length,
      truncated
    };
  }

  async health(): Promise<{ ok: boolean; details?: string }> {
    return this.store.health();
  }

  private resolveInputPath(pathOrUrl: string): string {
    try {
      if (/^https?:\/\//.test(pathOrUrl)) {
        return normalizeUrlPath(new URL(pathOrUrl).pathname);
      }
    } catch {
      // fall through to plain path handling
    }

    const withoutQueryOrHash = pathOrUrl.split(/[?#]/)[0] ?? pathOrUrl;
    return normalizeUrlPath(withoutQueryOrHash);
  }
}
