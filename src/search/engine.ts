import path from "node:path";
import { z } from "zod";
import { SearchSocketError } from "../errors";
import { loadConfig } from "../config/load";
import { resolveScope } from "../core/scope";
import { hrTimeMs } from "../utils/time";
import { normalizeUrlPath } from "../utils/path";
import { createUpstashStore } from "../vector/factory";
import { rankHits, aggregateByPage, trimByScoreGap } from "./ranking";
import type {
  ResolvedSearchSocketConfig,
  SearchRequest,
  SearchResponse,
  SearchResult,
  VectorHit
} from "../types";
import type { UpstashSearchStore } from "../vector/upstash";
import type { RankedHit, PageResult } from "./ranking";
import { toSnippet } from "../utils/text";

const requestSchema = z.object({
  q: z.string().trim().min(1),
  topK: z.number().int().positive().max(100).optional(),
  scope: z.string().optional(),
  pathPrefix: z.string().optional(),
  tags: z.array(z.string()).optional(),
  groupBy: z.enum(["page", "chunk"]).optional()
});

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

    const searchStart = process.hrtime.bigint();
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
    const searchMs = hrTimeMs(searchStart);

    const ranked = rankHits(hits, this.config, input.q);
    const results = this.buildResults(ranked, topK, groupByPage, input.q);

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
