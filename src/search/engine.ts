import path from "node:path";
import { z } from "zod";
import { createEmbeddingsProvider } from "../embeddings";
import { SearchSocketError } from "../errors";
import { loadConfig } from "../config/load";
import { resolveScope } from "../core/scope";
import { createReranker } from "../rerank";
import { hrTimeMs } from "../utils/time";
import { normalizeUrlPath } from "../utils/path";
import { createVectorStore } from "../vector/factory";
import { rankHits, aggregateByPage } from "./ranking";
import type { RankedHit } from "./ranking";
import type {
  EmbeddingsProvider,
  Reranker,
  ResolvedSearchSocketConfig,
  Scope,
  SearchRequest,
  SearchResponse,
  SearchResult,
  VectorStore
} from "../types";

const requestSchema = z.object({
  q: z.string().trim().min(1),
  topK: z.number().int().positive().max(100).optional(),
  scope: z.string().optional(),
  pathPrefix: z.string().optional(),
  tags: z.array(z.string()).optional(),
  rerank: z.boolean().optional(),
  groupBy: z.enum(["page", "chunk"]).optional()
});

export interface SearchEngineOptions {
  cwd?: string;
  configPath?: string;
  config?: ResolvedSearchSocketConfig;
  embeddingsProvider?: EmbeddingsProvider;
  vectorStore?: VectorStore;
  reranker?: Reranker | null;
}

export class SearchEngine {
  private readonly cwd: string;
  private readonly config: ResolvedSearchSocketConfig;
  private readonly embeddings: EmbeddingsProvider;
  private readonly vectorStore: VectorStore;
  private readonly reranker: Reranker | null;

  private constructor(options: {
    cwd: string;
    config: ResolvedSearchSocketConfig;
    embeddings: EmbeddingsProvider;
    vectorStore: VectorStore;
    reranker: Reranker | null;
  }) {
    this.cwd = options.cwd;
    this.config = options.config;
    this.embeddings = options.embeddings;
    this.vectorStore = options.vectorStore;
    this.reranker = options.reranker;
  }

  static async create(options: SearchEngineOptions = {}): Promise<SearchEngine> {
    const cwd = path.resolve(options.cwd ?? process.cwd());
    const config = options.config ?? (await loadConfig({ cwd, configPath: options.configPath }));

    const embeddings = options.embeddingsProvider ?? createEmbeddingsProvider(config);
    const vectorStore = options.vectorStore ?? await createVectorStore(config, cwd);
    const reranker = options.reranker === undefined
      ? createReranker(config)
      : options.reranker;

    return new SearchEngine({
      cwd,
      config,
      embeddings,
      vectorStore,
      reranker
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
    await this.assertModelCompatibility(resolvedScope);

    const topK = input.topK ?? 10;
    const wantsRerank = Boolean(input.rerank);
    const groupByPage = (input.groupBy ?? "page") === "page";
    const candidateK = groupByPage
      ? Math.max(topK * 10, 50)
      : Math.max(50, topK);

    const embedStart = process.hrtime.bigint();
    const queryEmbeddings = await this.embeddings.embedTexts([input.q], this.config.embeddings.model, "retrieval.query");
    const queryVector = queryEmbeddings[0];
    if (!queryVector || queryVector.length === 0 || queryVector.some((value) => !Number.isFinite(value))) {
      throw new SearchSocketError("VECTOR_BACKEND_UNAVAILABLE", "Unable to create query embedding.");
    }
    const embedMs = hrTimeMs(embedStart);

    const vectorStart = process.hrtime.bigint();
    const hits = await this.vectorStore.query(
      queryVector,
      {
        topK: candidateK,
        pathPrefix: input.pathPrefix,
        tags: input.tags
      },
      resolvedScope
    );
    const vectorMs = hrTimeMs(vectorStart);

    const ranked = rankHits(hits, this.config);
    let usedRerank = false;
    let rerankMs = 0;
    let ordered = ranked;

    if (wantsRerank) {
      const rerankStart = process.hrtime.bigint();
      ordered = await this.rerankHits(input.q, ranked, topK);
      rerankMs = hrTimeMs(rerankStart);
      usedRerank = true;
    }

    let results: SearchResult[];
    const minScore = this.config.ranking.minScore;

    if (groupByPage) {
      let pages = aggregateByPage(ordered, this.config);
      if (minScore > 0) {
        pages = pages.filter((p) => p.pageScore >= minScore);
      }
      const minRatio = this.config.ranking.minChunkScoreRatio;
      results = pages.slice(0, topK).map((page) => {
        const bestScore = page.bestChunk.finalScore;
        const minScore = Number.isFinite(bestScore) ? bestScore * minRatio : Number.NEGATIVE_INFINITY;
        const meaningful = page.matchingChunks
          .filter((c) => c.finalScore >= minScore)
          .slice(0, 5);
        return {
          url: page.url,
          title: page.title,
          sectionTitle: page.bestChunk.hit.metadata.sectionTitle || undefined,
          snippet: page.bestChunk.hit.metadata.snippet,
          score: Number(page.pageScore.toFixed(6)),
          routeFile: page.routeFile,
          chunks: meaningful.length > 1
            ? meaningful.map((c) => ({
                sectionTitle: c.hit.metadata.sectionTitle || undefined,
                snippet: c.hit.metadata.snippet,
                headingPath: c.hit.metadata.headingPath,
                score: Number(c.finalScore.toFixed(6))
              }))
            : undefined
        };
      });
    } else {
      if (minScore > 0) {
        ordered = ordered.filter((entry) => entry.finalScore >= minScore);
      }
      results = ordered.slice(0, topK).map(({ hit, finalScore }) => ({
        url: hit.metadata.url,
        title: hit.metadata.title,
        sectionTitle: hit.metadata.sectionTitle || undefined,
        snippet: hit.metadata.snippet,
        score: Number(finalScore.toFixed(6)),
        routeFile: hit.metadata.routeFile
      }));
    }

    return {
      q: input.q,
      scope: resolvedScope.scopeName,
      results,
      meta: {
        timingsMs: {
          embed: Math.round(embedMs),
          vector: Math.round(vectorMs),
          rerank: Math.round(rerankMs),
          total: Math.round(hrTimeMs(totalStart))
        },
        usedRerank,
        modelId: this.config.embeddings.model
      }
    };
  }

  async getPage(pathOrUrl: string, scope?: string): Promise<{
    url: string;
    frontmatter: Record<string, unknown>;
    markdown: string;
  }> {
    const resolvedScope = resolveScope(this.config, scope);
    const urlPath = this.resolveInputPath(pathOrUrl);
    const page = await this.vectorStore.getPage(urlPath, resolvedScope);

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
    return this.vectorStore.health();
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

  private async assertModelCompatibility(scope: Scope): Promise<void> {
    const modelId = await this.vectorStore.getScopeModelId(scope);
    if (modelId && modelId !== this.config.embeddings.model) {
      throw new SearchSocketError(
        "EMBEDDING_MODEL_MISMATCH",
        `Scope ${scope.scopeName} was indexed with ${modelId}. Current config uses ${this.config.embeddings.model}. Re-index with --force.`
      );
    }
  }

  private async rerankHits(
    query: string,
    ranked: RankedHit[],
    topK: number
  ): Promise<RankedHit[]> {
    if (!this.config.rerank.enabled) {
      throw new SearchSocketError(
        "INVALID_REQUEST",
        "rerank=true requested but rerank.enabled is not set to true.",
        400
      );
    }

    if (!this.reranker) {
      throw new SearchSocketError(
        "CONFIG_MISSING",
        `rerank=true requested but ${this.config.embeddings.apiKeyEnv} is not set.`,
        400
      );
    }

    // 1. Group chunks by page URL
    const pageGroups = new Map<string, RankedHit[]>();
    for (const entry of ranked) {
      const url = entry.hit.metadata.url;
      const group = pageGroups.get(url);
      if (group) group.push(entry);
      else pageGroups.set(url, [entry]);
    }

    // 2. Build page-level documents from top chunks in ordinal order
    //    Jina reranker v2 has a 1024 token context limit per document.
    //    We select the best chunks per page (by score) to stay within budget,
    //    then order them by ordinal so the text reads naturally.
    const MAX_CHUNKS_PER_PAGE = 5;
    const MIN_CHUNKS_PER_PAGE = 1;
    const MIN_CHUNK_SCORE_RATIO = 0.5;

    const pageCandidates: Array<{ id: string; text: string }> = [];
    for (const [url, chunks] of pageGroups) {
      // Sort by score descending to pick the best chunks
      const byScore = [...chunks].sort((a, b) => b.finalScore - a.finalScore);
      const bestScore = byScore[0]!.finalScore;
      const scoreFloor = Number.isFinite(bestScore) ? bestScore * MIN_CHUNK_SCORE_RATIO : Number.NEGATIVE_INFINITY;

      // Keep top chunks that meet the relative score threshold, with a guaranteed minimum
      const selected = byScore.filter((c, i) =>
        i < MIN_CHUNKS_PER_PAGE || c.finalScore >= scoreFloor
      ).slice(0, MAX_CHUNKS_PER_PAGE);

      // Re-sort selected chunks by ordinal for natural reading order
      selected.sort((a, b) => (a.hit.metadata.ordinal ?? 0) - (b.hit.metadata.ordinal ?? 0));

      const first = selected[0]!.hit.metadata;
      const parts: string[] = [first.title];

      if (first.description) {
        parts.push(first.description);
      }
      if (first.keywords && first.keywords.length > 0) {
        parts.push(first.keywords.join(", "));
      }

      const body = selected
        .map((c) => c.hit.metadata.chunkText || c.hit.metadata.snippet)
        .join("\n\n");
      parts.push(body);

      pageCandidates.push({ id: url, text: parts.join("\n\n") });
    }

    // 3. Rerank page-level documents
    const reranked = await this.reranker.rerank(
      query,
      pageCandidates,
      Math.max(topK, this.config.rerank.topN)
    );
    const scoreByUrl = new Map(reranked.map((e) => [e.id, e.score]));

    // 4. Apply page rerank score to all chunks of that page
    return ranked
      .map((entry) => {
        const pageScore = scoreByUrl.get(entry.hit.metadata.url);
        const base = Number.isFinite(entry.finalScore)
          ? entry.finalScore
          : Number.NEGATIVE_INFINITY;

        if (pageScore === undefined || !Number.isFinite(pageScore)) {
          return { ...entry, finalScore: base };
        }

        const combined =
          (pageScore as number) * this.config.ranking.weights.rerank + base * 0.001;

        return {
          ...entry,
          finalScore: Number.isFinite(combined) ? combined : base
        };
      })
      .sort((a, b) => {
        const delta = b.finalScore - a.finalScore;
        return Number.isNaN(delta) ? 0 : delta;
      });
  }
}
