import path from "node:path";
import { z } from "zod";
import { SearchSocketError } from "../errors";
import { loadConfig } from "../config/load";
import { resolveScope } from "../core/scope";
import { hrTimeMs } from "../utils/time";
import { normalizeUrlPath } from "../utils/path";
import { createUpstashStore } from "../vector/factory";
import { GeminiEmbedder } from "../vector/gemini";
import { rankHits, aggregateByPage, trimByScoreGap, mergePageAndChunkResults, rankPageHits, trimPagesByScoreGap } from "./ranking";
import type {
  PageHit,
  RankingOverrides,
  RelatedPage,
  RelatedPagesResult,
  ResolvedSearchSocketConfig,
  SearchRequest,
  SearchResponse,
  SearchResult,
  SiteStructureResult,
  SiteTreeNode,
  VectorHit
} from "../types";
import type { UpstashSearchStore } from "../vector/upstash";
import type { RankedHit, PageResult, RankedPage } from "./ranking";
import { diceScore, compositeScore, dominantRelationshipType } from "./related-pages";
import { toSnippet, queryAwareExcerpt } from "../utils/text";
import { buildMetaFilterString } from "../utils/structured-meta";

const rankingOverridesSchema = z.object({
  ranking: z.object({
    enableIncomingLinkBoost: z.boolean().optional(),
    enableDepthBoost: z.boolean().optional(),
    aggregationCap: z.number().int().positive().optional(),
    aggregationDecay: z.number().min(0).max(1).optional(),
    minChunkScoreRatio: z.number().min(0).max(1).optional(),
    minScore: z.number().min(0).max(1).optional(),
    scoreGapThreshold: z.number().min(0).max(1).optional(),
    weights: z.object({
      incomingLinks: z.number().optional(),
      depth: z.number().optional(),
      aggregation: z.number().optional(),
      titleMatch: z.number().optional(),
    }).optional(),
  }).optional(),
  search: z.object({
    pageSearchWeight: z.number().min(0).max(1).optional(),
  }).optional(),
}).optional();

const requestSchema = z.object({
  q: z.string().trim().min(1),
  topK: z.number().int().positive().max(100).optional(),
  scope: z.string().optional(),
  pathPrefix: z.string().optional(),
  tags: z.array(z.string()).optional(),
  filters: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  groupBy: z.enum(["page", "chunk"]).optional(),
  maxSubResults: z.number().int().positive().max(20).optional(),
  debug: z.boolean().optional(),
  rankingOverrides: rankingOverridesSchema,
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

function mergeRankingOverrides(
  base: ResolvedSearchSocketConfig,
  overrides: RankingOverrides
): ResolvedSearchSocketConfig {
  return {
    ...base,
    search: {
      ...base.search,
      ...overrides.search,
    },
    ranking: {
      ...base.ranking,
      ...overrides.ranking,
      weights: {
        ...base.ranking.weights,
        ...overrides.ranking?.weights,
      },
    },
  };
}

export interface SearchEngineOptions {
  cwd?: string;
  configPath?: string;
  config?: ResolvedSearchSocketConfig;
  store?: UpstashSearchStore;
  embedder?: GeminiEmbedder;
}

export class SearchEngine {
  private readonly cwd: string;
  private readonly config: ResolvedSearchSocketConfig;
  private readonly store: UpstashSearchStore;
  private readonly embedder: GeminiEmbedder;

  private constructor(options: {
    cwd: string;
    config: ResolvedSearchSocketConfig;
    store: UpstashSearchStore;
    embedder: GeminiEmbedder;
  }) {
    this.cwd = options.cwd;
    this.config = options.config;
    this.store = options.store;
    this.embedder = options.embedder;
  }

  static async create(options: SearchEngineOptions = {}): Promise<SearchEngine> {
    const cwd = path.resolve(options.cwd ?? process.cwd());
    const config = options.config ?? (await loadConfig({ cwd, configPath: options.configPath }));

    const store = options.store ?? await createUpstashStore(config);
    const embedder = options.embedder ?? GeminiEmbedder.fromConfig(config);

    return new SearchEngine({
      cwd,
      config,
      store,
      embedder
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

    // Apply ranking overrides only when debug mode is enabled
    const effectiveConfig = (input.debug && input.rankingOverrides)
      ? mergeRankingOverrides(this.config, input.rankingOverrides)
      : this.config;

    const resolvedScope = resolveScope(this.config, input.scope);

    const topK = input.topK ?? 10;
    const maxSubResults = input.maxSubResults ?? 5;
    const groupByPage = (input.groupBy ?? "page") === "page";

    // Embed the query text via Gemini
    const queryVector = await this.embedder.embedQuery(input.q);

    // Post-query filtering for pathPrefix and tags
    const pathPrefix = input.pathPrefix
      ? (input.pathPrefix.startsWith("/") ? input.pathPrefix : `/${input.pathPrefix}`)
      : undefined;
    const filterTags = input.tags && input.tags.length > 0 ? input.tags : undefined;

    // Build server-side Upstash filter for structured metadata
    const metaFilterStr = input.filters && Object.keys(input.filters).length > 0
      ? buildMetaFilterString(input.filters)
      : "";
    const metaFilter = metaFilterStr || undefined;

    const applyPagePostFilters = (hits: PageHit[]): PageHit[] => {
      let filtered = hits;
      if (pathPrefix) {
        filtered = filtered.filter((h) => h.url.startsWith(pathPrefix));
      }
      if (filterTags) {
        filtered = filtered.filter((h) =>
          filterTags.every((tag) => h.tags.includes(tag))
        );
      }
      return filtered;
    };

    const applyChunkPostFilters = (hits: VectorHit[]): VectorHit[] => {
      let filtered = hits;
      if (filterTags) {
        filtered = filtered.filter((h) =>
          filterTags.every((tag) => h.metadata.tags.includes(tag))
        );
      }
      return filtered;
    };

    const searchStart = process.hrtime.bigint();

    if (groupByPage) {
      // ── Page-first pipeline ──
      // 1. Search page vectors to get top pages ranked by similarity
      const fetchMultiplier = (pathPrefix || filterTags) ? 2 : 1;
      const pageLimit = Math.max(topK * 2, 20);

      const pageHits = await this.store.searchPages(
        queryVector,
        { limit: pageLimit * fetchMultiplier, filter: metaFilter },
        resolvedScope
      );

      const filteredPages = applyPagePostFilters(pageHits);

      // 2. Rank pages with boosts (depth, incoming links, title match, page weights, etc.)
      let rankedPages = rankPageHits(filteredPages, effectiveConfig, input.q, input.debug);
      rankedPages = trimPagesByScoreGap(rankedPages, effectiveConfig);

      // Take top N pages
      const topPages = rankedPages.slice(0, topK);

      // 3. For each top page, find best-matching chunks within that page
      const chunkPromises = topPages.map((page) =>
        this.store.searchChunksByUrl(
          queryVector,
          page.url,
          { limit: maxSubResults, filter: metaFilter },
          resolvedScope
        ).then((chunks) => applyChunkPostFilters(chunks))
      );
      const allChunks = await Promise.all(chunkPromises);

      // 4. Build results: pages with nested chunks for navigation
      const searchMs = hrTimeMs(searchStart);
      const results = this.buildPageFirstResults(topPages, allChunks, input.q, input.debug, maxSubResults);

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
    } else {
      // ── Chunk-only mode (groupBy: "chunk") — legacy behavior ──
      const candidateK = Math.max(50, topK);
      const fetchMultiplier = (pathPrefix || filterTags) ? 2 : 1;

      const hits = await this.store.search(
        queryVector,
        { limit: candidateK * fetchMultiplier, filter: metaFilter },
        resolvedScope
      );

      let filtered = hits;
      if (pathPrefix) {
        filtered = filtered.filter((h) => h.metadata.url.startsWith(pathPrefix));
      }
      if (filterTags) {
        filtered = filtered.filter((h) =>
          filterTags!.every((tag) => h.metadata.tags.includes(tag))
        );
      }

      const ranked = rankHits(filtered, effectiveConfig, input.q, input.debug);
      const searchMs = hrTimeMs(searchStart);
      const results = this.buildResults(ranked, topK, false, maxSubResults, input.q, input.debug, effectiveConfig);

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
  }

  private buildPageFirstResults(
    rankedPages: RankedPage[],
    allChunks: VectorHit[][],
    query?: string,
    debug?: boolean,
    maxSubResults: number = 5
  ): SearchResult[] {
    return rankedPages.map((page, i) => {
      const chunks = allChunks[i] ?? [];

      // Best chunk is the first one (highest similarity to query within this page)
      const bestChunk = chunks[0];

      // Build snippet from best chunk, or fall back to page description
      const snippet = bestChunk
        ? (query ? queryAwareExcerpt(bestChunk.metadata.chunkText, query) : toSnippet(bestChunk.metadata.chunkText))
        : (page.description || page.title);

      const result: SearchResult = {
        url: page.url,
        title: page.title,
        sectionTitle: bestChunk?.metadata.sectionTitle || undefined,
        snippet,
        chunkText: bestChunk?.metadata.chunkText || undefined,
        score: Number(page.finalScore.toFixed(6)),
        routeFile: page.routeFile,
        chunks: chunks.length > 0
          ? chunks.slice(0, maxSubResults).map((c) => ({
              sectionTitle: c.metadata.sectionTitle || undefined,
              snippet: query ? queryAwareExcerpt(c.metadata.chunkText, query) : toSnippet(c.metadata.chunkText),
              chunkText: c.metadata.chunkText || undefined,
              headingPath: c.metadata.headingPath,
              score: Number(c.score.toFixed(6))
            }))
          : undefined
      };

      if (debug && page.breakdown) {
        result.breakdown = {
          baseScore: page.breakdown.baseScore,
          incomingLinkBoost: page.breakdown.incomingLinkBoost,
          depthBoost: page.breakdown.depthBoost,
          titleMatchBoost: page.breakdown.titleMatchBoost,
          freshnessBoost: page.breakdown.freshnessBoost,
          anchorTextMatchBoost: 0
        };
      }

      return result;
    });
  }

  private ensureSnippet(hit: RankedHit, query?: string): string {
    const chunkText = hit.hit.metadata.chunkText;
    if (query && chunkText) return queryAwareExcerpt(chunkText, query);
    const snippet = hit.hit.metadata.snippet;
    if (snippet && snippet.length >= 30) return snippet;
    if (chunkText) return toSnippet(chunkText);
    return snippet || "";
  }

  private buildResults(ordered: RankedHit[], topK: number, groupByPage: boolean, maxSubResults: number, query?: string, debug?: boolean, config?: ResolvedSearchSocketConfig): SearchResult[] {
    const cfg = config ?? this.config;
    if (groupByPage) {
      let pages = aggregateByPage(ordered, cfg);
      pages = trimByScoreGap(pages, cfg);
      const minRatio = cfg.ranking.minChunkScoreRatio;
      return pages.slice(0, topK).map((page) => {
        const bestScore = page.bestChunk.finalScore;
        const minChunkScore = Number.isFinite(bestScore) ? bestScore * minRatio : Number.NEGATIVE_INFINITY;
        const meaningful = page.matchingChunks
          .filter((c) => c.finalScore >= minChunkScore)
          .slice(0, maxSubResults);
        const result: SearchResult = {
          url: page.url,
          title: page.title,
          sectionTitle: page.bestChunk.hit.metadata.sectionTitle || undefined,
          snippet: this.ensureSnippet(page.bestChunk, query),
          chunkText: page.bestChunk.hit.metadata.chunkText || undefined,
          score: Number(page.pageScore.toFixed(6)),
          routeFile: page.routeFile,
          chunks: meaningful.length >= 1
            ? meaningful.map((c) => ({
                sectionTitle: c.hit.metadata.sectionTitle || undefined,
                snippet: this.ensureSnippet(c, query),
                chunkText: c.hit.metadata.chunkText || undefined,
                headingPath: c.hit.metadata.headingPath,
                score: Number(c.finalScore.toFixed(6))
              }))
            : undefined
        };
        if (debug && page.bestChunk.breakdown) {
          result.breakdown = page.bestChunk.breakdown;
        }
        return result;
      });
    } else {
      let filtered = ordered;
      const minScore = cfg.ranking.minScore;
      if (minScore > 0) {
        filtered = ordered.filter((entry) => entry.finalScore >= minScore);
      }
      return filtered.slice(0, topK).map(({ hit, finalScore, breakdown }) => {
        const result: SearchResult = {
          url: hit.metadata.url,
          title: hit.metadata.title,
          sectionTitle: hit.metadata.sectionTitle || undefined,
          snippet: this.ensureSnippet({ hit, finalScore }, query),
          chunkText: hit.metadata.chunkText || undefined,
          score: Number(finalScore.toFixed(6)),
          routeFile: hit.metadata.routeFile
        };
        if (debug && breakdown) {
          result.breakdown = breakdown;
        }
        return result;
      });
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
        truncated = allPages.length > maxPages || !!cursor;
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

  async getRelatedPages(
    pathOrUrl: string,
    opts?: { topK?: number; scope?: string }
  ): Promise<RelatedPagesResult> {
    const resolvedScope = resolveScope(this.config, opts?.scope);
    const urlPath = this.resolveInputPath(pathOrUrl);
    const topK = Math.min(opts?.topK ?? 10, 25);

    // Fetch source page with its vector
    const source = await this.store.fetchPageWithVector(urlPath, resolvedScope);
    if (!source) {
      throw new SearchSocketError("INVALID_REQUEST", `Indexed page not found for ${urlPath}`, 404);
    }

    const sourceOutgoing = new Set(source.metadata.outgoingLinkUrls ?? []);

    // ANN query for semantically similar pages
    const semanticHits = await this.store.searchPages(
      source.vector,
      { limit: 50 },
      resolvedScope
    );
    const filteredHits = semanticHits.filter((h) => h.url !== urlPath);

    // Build semantic score map
    const semanticScoreMap = new Map<string, number>();
    for (const hit of filteredHits) {
      semanticScoreMap.set(hit.url, hit.score);
    }

    // Collect candidate URLs: semantic hits + outgoing link targets
    const candidateUrls = new Set<string>();
    for (const hit of filteredHits) {
      candidateUrls.add(hit.url);
    }
    for (const url of sourceOutgoing) {
      if (url !== urlPath) candidateUrls.add(url);
    }

    // Fetch outgoing link targets that weren't in semantic results (for metadata)
    const missingUrls = [...sourceOutgoing].filter(
      (u) => u !== urlPath && !semanticScoreMap.has(u)
    );
    const fetchedPages = missingUrls.length > 0
      ? await this.store.fetchPagesBatch(missingUrls, resolvedScope)
      : [];

    // Build metadata map from semantic hits + fetched pages
    const metaMap = new Map<string, { title: string; routeFile: string; outgoingLinkUrls: string[] }>();
    for (const hit of filteredHits) {
      metaMap.set(hit.url, { title: hit.title, routeFile: hit.routeFile, outgoingLinkUrls: [] });
    }
    for (const p of fetchedPages) {
      metaMap.set(p.url, { title: p.title, routeFile: p.routeFile, outgoingLinkUrls: p.outgoingLinkUrls });
    }

    // We need outgoingLinkUrls for semantic hits too (for incoming link detection)
    // Batch-fetch semantic hits to get their outgoingLinkUrls
    const semanticUrls = filteredHits.map((h) => h.url);
    if (semanticUrls.length > 0) {
      const semanticPageData = await this.store.fetchPagesBatch(semanticUrls, resolvedScope);
      for (const p of semanticPageData) {
        const existing = metaMap.get(p.url);
        if (existing) {
          existing.outgoingLinkUrls = p.outgoingLinkUrls;
        }
      }
    }

    // Score each candidate
    const candidates: RelatedPage[] = [];
    for (const url of candidateUrls) {
      const meta = metaMap.get(url);
      if (!meta) continue;

      const isOutgoing = sourceOutgoing.has(url);
      const isIncoming = meta.outgoingLinkUrls.includes(urlPath);
      const isLinked = isOutgoing || isIncoming;
      const dice = diceScore(urlPath, url);
      const semantic = semanticScoreMap.get(url) ?? 0;

      const score = compositeScore(isLinked, dice, semantic);
      const relationshipType = dominantRelationshipType(isOutgoing, isIncoming, dice);

      candidates.push({
        url,
        title: meta.title,
        score: Number(score.toFixed(6)),
        relationshipType,
        routeFile: meta.routeFile
      });
    }

    // Sort by score descending and cap at topK
    candidates.sort((a, b) => b.score - a.score);
    const results = candidates.slice(0, topK);

    return {
      sourceUrl: urlPath,
      scope: resolvedScope.scopeName,
      relatedPages: results
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
