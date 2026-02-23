import path from "node:path";
import { loadConfig } from "../config/load";
import { resolveScope } from "../core/scope";
import { ensureStateDirs } from "../core/state";
import { createEmbeddingsProvider } from "../embeddings";
import { SearchSocketError } from "../errors";
import { createVectorStore } from "../vector";
import { chunkMirrorPage } from "./chunker";
import { extractFromHtml, extractFromMarkdown } from "./extractor";
import { cleanMirrorForScope, writeMirrorPage } from "./mirror";
import { buildRoutePatterns, mapUrlToRoute } from "./route-mapper";
import { loadContentFilesPages } from "./sources/content-files";
import { loadCrawledPages } from "./sources/crawl";
import { loadStaticOutputPages } from "./sources/static-output";
import { hrTimeMs, nowIso } from "../utils/time";
import { getUrlDepth, normalizeUrlPath } from "../utils/path";
import { Logger } from "../core/logger";
import type {
  Chunk,
  EmbeddingsProvider,
  ExtractedPage,
  IndexOptions,
  IndexStats,
  MirrorPage,
  PageRecord,
  ResolvedSearchSocketConfig,
  Scope,
  ScopeInfo,
  VectorRecord,
  VectorStore
} from "../types";

const EMBEDDING_PRICE_PER_1K_TOKENS_USD: Record<string, number> = {
  "text-embedding-3-small": 0.00002,
  "text-embedding-3-large": 0.00013,
  "text-embedding-ada-002": 0.0001
};
const DEFAULT_EMBEDDING_PRICE_PER_1K = 0.00002;

interface IndexPipelineOptions {
  cwd?: string;
  configPath?: string;
  config?: ResolvedSearchSocketConfig;
  embeddingsProvider?: EmbeddingsProvider;
  vectorStore?: VectorStore;
  logger?: Logger;
}

export class IndexPipeline {
  private readonly cwd: string;
  private readonly config: ResolvedSearchSocketConfig;
  private readonly embeddings: EmbeddingsProvider;
  private readonly vectorStore: VectorStore;
  private readonly logger: Logger;

  private constructor(options: {
    cwd: string;
    config: ResolvedSearchSocketConfig;
    embeddings: EmbeddingsProvider;
    vectorStore: VectorStore;
    logger: Logger;
  }) {
    this.cwd = options.cwd;
    this.config = options.config;
    this.embeddings = options.embeddings;
    this.vectorStore = options.vectorStore;
    this.logger = options.logger;
  }

  static async create(options: IndexPipelineOptions = {}): Promise<IndexPipeline> {
    const cwd = path.resolve(options.cwd ?? process.cwd());
    const config = options.config ?? (await loadConfig({ cwd, configPath: options.configPath }));
    const embeddings = options.embeddingsProvider ?? createEmbeddingsProvider(config);
    const vectorStore = options.vectorStore ?? await createVectorStore(config, cwd);

    return new IndexPipeline({
      cwd,
      config,
      embeddings,
      vectorStore,
      logger: options.logger ?? new Logger()
    });
  }

  getConfig(): ResolvedSearchSocketConfig {
    return this.config;
  }

  async run(rawOptions: IndexOptions = {}): Promise<IndexStats> {
    const options: Required<Pick<IndexOptions, "changedOnly" | "force" | "dryRun">> & IndexOptions = {
      changedOnly: rawOptions.changedOnly ?? true,
      force: rawOptions.force ?? false,
      dryRun: rawOptions.dryRun ?? false,
      ...rawOptions
    };

    const stageTimingsMs: Record<string, number> = {};
    const stageStart = (): bigint => process.hrtime.bigint();
    const stageEnd = (name: string, start: bigint): void => {
      stageTimingsMs[name] = Math.round(hrTimeMs(start));
    };

    const scope = resolveScope(this.config, options.scopeOverride);
    const { statePath } = ensureStateDirs(this.cwd, this.config.state.dir, scope);

    if (options.force) {
      await cleanMirrorForScope(statePath, scope);
    }

    const manifestStart = stageStart();
    const existingHashes = options.force ? new Map<string, string>() : await this.vectorStore.getContentHashes(scope);
    const existingModelId = await this.vectorStore.getScopeModelId(scope);

    if (
      existingModelId &&
      existingModelId !== this.config.embeddings.model &&
      !options.force
    ) {
      throw new SearchSocketError(
        "EMBEDDING_MODEL_MISMATCH",
        `Scope ${scope.scopeName} uses model ${existingModelId}. Re-run with --force to migrate.`
      );
    }

    stageEnd("manifest", manifestStart);

    const sourceStart = stageStart();
    const sourceMode = options.sourceOverride ?? this.config.source.mode;
    let sourcePages;

    if (sourceMode === "static-output") {
      sourcePages = await loadStaticOutputPages(this.cwd, this.config, options.maxPages);
    } else if (sourceMode === "crawl") {
      sourcePages = await loadCrawledPages(this.config, options.maxPages);
    } else {
      sourcePages = await loadContentFilesPages(this.cwd, this.config, options.maxPages);
    }
    stageEnd("source", sourceStart);

    const routeStart = stageStart();
    const routePatterns = await buildRoutePatterns(this.cwd);
    stageEnd("route_map", routeStart);

    const extractStart = stageStart();
    const extractedPages: ExtractedPage[] = [];

    for (const sourcePage of sourcePages) {
      const extracted = sourcePage.html
        ? extractFromHtml(sourcePage.url, sourcePage.html, this.config)
        : extractFromMarkdown(sourcePage.url, sourcePage.markdown ?? "", sourcePage.title);

      if (!extracted) {
        continue;
      }

      extractedPages.push(extracted);
      this.logger.event("page_extracted", {
        url: extracted.url
      });
    }

    extractedPages.sort((a, b) => a.url.localeCompare(b.url));
    const uniquePages: ExtractedPage[] = [];
    const seenUrls = new Set<string>();
    for (const page of extractedPages) {
      if (seenUrls.has(page.url)) {
        this.logger.warn(
          `Duplicate page source for ${page.url}; keeping first extracted page and skipping the duplicate.`
        );
        continue;
      }
      seenUrls.add(page.url);
      uniquePages.push(page);
    }
    stageEnd("extract", extractStart);

    const linkStart = stageStart();
    const pageSet = new Set(uniquePages.map((page) => normalizeUrlPath(page.url)));
    const incomingLinkCount = new Map<string, number>();

    for (const page of uniquePages) {
      incomingLinkCount.set(page.url, incomingLinkCount.get(page.url) ?? 0);
    }

    for (const page of uniquePages) {
      for (const outgoing of page.outgoingLinks) {
        if (!pageSet.has(outgoing)) {
          continue;
        }

        incomingLinkCount.set(outgoing, (incomingLinkCount.get(outgoing) ?? 0) + 1);
      }
    }
    stageEnd("links", linkStart);

    const mirrorStart = stageStart();
    const mirrorPages: MirrorPage[] = [];
    let routeExact = 0;
    let routeBestEffort = 0;

    for (const page of uniquePages) {
      const routeMatch = mapUrlToRoute(page.url, routePatterns);

      if (routeMatch.routeResolution === "best-effort") {
        if (this.config.source.strictRouteMapping) {
          throw new SearchSocketError(
            "ROUTE_MAPPING_FAILED",
            `Strict route mapping enabled: no exact route match for ${page.url} (resolved to ${routeMatch.routeFile}). ` +
              "Disable source.strictRouteMapping or add the missing route file.",
            400
          );
        }

        this.logger.warn(
          `No exact route match for ${page.url}, falling back to ${routeMatch.routeFile}.`
        );
        routeBestEffort += 1;
      } else {
        routeExact += 1;
      }

      const mirror: MirrorPage = {
        url: page.url,
        title: page.title,
        scope: scope.scopeName,
        routeFile: routeMatch.routeFile,
        routeResolution: routeMatch.routeResolution,
        generatedAt: nowIso(),
        incomingLinks: incomingLinkCount.get(page.url) ?? 0,
        outgoingLinks: page.outgoingLinks.length,
        depth: getUrlDepth(page.url),
        tags: page.tags,
        markdown: page.markdown
      };

      mirrorPages.push(mirror);
      if (this.config.state.writeMirror) {
        await writeMirrorPage(statePath, scope, mirror);
      }
      this.logger.event("markdown_written", { url: page.url });
    }

    // Store pages in Turso (replace entire scope to remove stale pages)
    if (!options.dryRun) {
      const pageRecords: PageRecord[] = mirrorPages.map((mp) => ({
        url: mp.url,
        title: mp.title,
        markdown: mp.markdown,
        projectId: scope.projectId,
        scopeName: scope.scopeName,
        routeFile: mp.routeFile,
        routeResolution: mp.routeResolution,
        incomingLinks: mp.incomingLinks,
        outgoingLinks: mp.outgoingLinks,
        depth: mp.depth,
        tags: mp.tags,
        indexedAt: mp.generatedAt
      }));
      // Delete old pages first, then insert new ones to avoid stale data
      await this.vectorStore.deletePages(scope);
      await this.vectorStore.upsertPages(pageRecords, scope);
    }

    stageEnd("mirror", mirrorStart);

    const chunkStart = stageStart();
    let chunks: Chunk[] = mirrorPages.flatMap((page) => chunkMirrorPage(page, this.config, scope));

    const maxChunks = typeof options.maxChunks === "number" ? Math.max(0, Math.floor(options.maxChunks)) : undefined;
    if (typeof maxChunks === "number") {
      chunks = chunks.slice(0, maxChunks);
    }

    for (const chunk of chunks) {
      this.logger.event("chunked", {
        url: chunk.url,
        chunkKey: chunk.chunkKey
      });
    }

    stageEnd("chunk", chunkStart);

    const currentChunkMap = new Map<string, Chunk>();
    for (const chunk of chunks) {
      currentChunkMap.set(chunk.chunkKey, chunk);
    }

    const changedChunks = chunks.filter((chunk) => {
      if (options.force) {
        return true;
      }

      const existingHash = existingHashes.get(chunk.chunkKey);
      if (!existingHash) {
        return true;
      }

      if (!options.changedOnly) {
        return true;
      }

      return existingHash !== chunk.contentHash;
    });

    const deletes = [...existingHashes.keys()].filter((chunkKey) => !currentChunkMap.has(chunkKey));

    const embedStart = stageStart();

    const chunkTokenEstimates = new Map<string, number>();
    for (const chunk of changedChunks) {
      chunkTokenEstimates.set(chunk.chunkKey, this.embeddings.estimateTokens(chunk.chunkText));
    }

    const estimatedTokens = changedChunks.reduce(
      (sum, chunk) => sum + (chunkTokenEstimates.get(chunk.chunkKey) ?? 0),
      0
    );

    const pricePer1k = this.config.embeddings.pricePer1kTokens
      ?? EMBEDDING_PRICE_PER_1K_TOKENS_USD[this.config.embeddings.model]
      ?? DEFAULT_EMBEDDING_PRICE_PER_1K;

    const estimatedCostUSD = (estimatedTokens / 1000) * pricePer1k;

    let newEmbeddings = 0;
    const vectorsByChunk = new Map<string, number[]>();

    if (!options.dryRun && changedChunks.length > 0) {
      const embeddings = await this.embeddings.embedTexts(
        changedChunks.map((chunk) => chunk.chunkText),
        this.config.embeddings.model
      );

      if (embeddings.length !== changedChunks.length) {
        throw new SearchSocketError(
          "VECTOR_BACKEND_UNAVAILABLE",
          `Embedding provider returned ${embeddings.length} vectors for ${changedChunks.length} chunks.`
        );
      }

      for (let i = 0; i < changedChunks.length; i += 1) {
        const chunk = changedChunks[i];
        const embedding = embeddings[i];
        if (!chunk || !embedding || embedding.length === 0) {
          throw new SearchSocketError(
            "VECTOR_BACKEND_UNAVAILABLE",
            `Embedding provider returned an invalid vector for chunk index ${i}.`
          );
        }
        vectorsByChunk.set(chunk.chunkKey, embedding);
        newEmbeddings += 1;
        this.logger.event("embedded_new", { chunkKey: chunk.chunkKey });
      }
    }

    stageEnd("embedding", embedStart);

    const syncStart = stageStart();
    if (!options.dryRun) {
      const upserts: VectorRecord[] = [];
      for (const chunk of changedChunks) {
        const vector = vectorsByChunk.get(chunk.chunkKey);
        if (!vector) {
          continue;
        }

        upserts.push({
          id: chunk.chunkKey,
          vector,
          metadata: {
            projectId: scope.projectId,
            scopeName: scope.scopeName,
            url: chunk.url,
            path: chunk.path,
            title: chunk.title,
            sectionTitle: chunk.sectionTitle ?? "",
            headingPath: chunk.headingPath,
            snippet: chunk.snippet,
            contentHash: chunk.contentHash,
            modelId: this.config.embeddings.model,
            depth: chunk.depth,
            incomingLinks: chunk.incomingLinks,
            routeFile: chunk.routeFile,
            tags: chunk.tags
          }
        });
      }

      if (upserts.length > 0) {
        await this.vectorStore.upsert(upserts, scope);
        this.logger.event("upserted", { count: upserts.length });
      }

      if (deletes.length > 0) {
        await this.vectorStore.deleteByIds(deletes, scope);
        this.logger.event("deleted", { count: deletes.length });
      }
    }

    stageEnd("sync", syncStart);

    const finalizeStart = stageStart();

    if (!options.dryRun) {
      const scopeInfo: ScopeInfo = {
        projectId: scope.projectId,
        scopeName: scope.scopeName,
        modelId: this.config.embeddings.model,
        lastIndexedAt: nowIso(),
        vectorCount: chunks.length,
        lastEstimateTokens: estimatedTokens,
        lastEstimateCostUSD: Number(estimatedCostUSD.toFixed(8)),
        lastEstimateChangedChunks: changedChunks.length
      };

      await this.vectorStore.recordScope(scopeInfo);
      this.logger.event("registry_updated", {
        scope: scope.scopeName,
        vectorCount: chunks.length
      });
    }

    stageEnd("finalize", finalizeStart);

    return {
      pagesProcessed: mirrorPages.length,
      chunksTotal: chunks.length,
      chunksChanged: changedChunks.length,
      newEmbeddings,
      deletes: deletes.length,
      estimatedTokens,
      estimatedCostUSD: Number(estimatedCostUSD.toFixed(8)),
      routeExact,
      routeBestEffort,
      stageTimingsMs
    };
  }
}
