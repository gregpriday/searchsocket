import path from "node:path";
import { loadConfig } from "../config/load";
import { resolveScope } from "../core/scope";
import { ensureStateDirs } from "../core/state";
import { createEmbeddingsProvider } from "../embeddings";
import { SearchSocketError } from "../errors";
import { createVectorStore } from "../vector";
import { buildEmbeddingText, chunkMirrorPage } from "./chunker";
import { extractFromHtml, extractFromMarkdown } from "./extractor";
import { cleanMirrorForScope, writeMirrorPage } from "./mirror";
import { buildRoutePatterns, mapUrlToRoute } from "./route-mapper";
import { loadBuildPages } from "./sources/build";
import { loadContentFilesPages } from "./sources/content-files";
import { loadCrawledPages } from "./sources/crawl";
import { loadStaticOutputPages } from "./sources/static-output";
import { loadRobotsTxtFromDir, fetchRobotsTxt, isBlockedByRobots } from "./robots";
import { findPageWeight } from "../search/ranking";
import { matchUrlPatterns } from "../utils/pattern";
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
  RouteMatch,
  Scope,
  ScopeInfo,
  VectorRecord,
  VectorStore
} from "../types";

const EMBEDDING_PRICE_PER_1K_TOKENS_USD: Record<string, number> = {
  "jina-embeddings-v3": 0.00002,
  "jina-embeddings-v5-text-small": 0.00005
};
const DEFAULT_EMBEDDING_PRICE_PER_1K = 0.00005;

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

    const sourceMode = options.sourceOverride ?? this.config.source.mode;
    this.logger.info(`Indexing scope "${scope.scopeName}" (source: ${sourceMode}, model: ${this.config.embeddings.model})`);

    if (options.force) {
      this.logger.info("Force mode enabled — full rebuild");
      await cleanMirrorForScope(statePath, scope);
    }

    if (options.dryRun) {
      this.logger.info("Dry run — no writes will be performed");
    }

    const manifestStart = stageStart();
    const existingHashes = await this.vectorStore.getContentHashes(scope);
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
    this.logger.debug(`Manifest: ${existingHashes.size} existing chunk hashes loaded`);

    const sourceStart = stageStart();
    this.logger.info(`Loading pages (source: ${sourceMode})...`);
    let sourcePages;

    if (sourceMode === "static-output") {
      sourcePages = await loadStaticOutputPages(this.cwd, this.config, options.maxPages);
    } else if (sourceMode === "crawl") {
      sourcePages = await loadCrawledPages(this.config, options.maxPages);
    } else if (sourceMode === "build") {
      sourcePages = await loadBuildPages(this.cwd, this.config, options.maxPages);
    } else {
      sourcePages = await loadContentFilesPages(this.cwd, this.config, options.maxPages);
    }
    stageEnd("source", sourceStart);
    this.logger.info(`Loaded ${sourcePages.length} page${sourcePages.length === 1 ? "" : "s"} (${stageTimingsMs["source"]}ms)`);

    // --- Pre-extraction filtering: robots.txt + top-level exclude ---
    const filterStart = stageStart();
    let filteredSourcePages = sourcePages;

    // Apply top-level exclude patterns (works across all source modes)
    if (this.config.exclude.length > 0) {
      const beforeExclude = filteredSourcePages.length;
      filteredSourcePages = filteredSourcePages.filter((p) => {
        const url = normalizeUrlPath(p.url);
        if (matchUrlPatterns(url, this.config.exclude)) {
          this.logger.debug(`Excluding ${url} (matched exclude pattern)`);
          return false;
        }
        return true;
      });
      const excludedCount = beforeExclude - filteredSourcePages.length;
      if (excludedCount > 0) {
        this.logger.info(`Excluded ${excludedCount} page${excludedCount === 1 ? "" : "s"} by config exclude patterns`);
      }
    }

    // Apply robots.txt filtering
    if (this.config.respectRobotsTxt) {
      let robotsRules = null;
      if (sourceMode === "static-output") {
        robotsRules = await loadRobotsTxtFromDir(
          path.resolve(this.cwd, this.config.source.staticOutputDir)
        );
      } else if (sourceMode === "build" && this.config.source.build) {
        robotsRules = await loadRobotsTxtFromDir(
          path.resolve(this.cwd, this.config.source.build.outputDir)
        );
      } else if (sourceMode === "crawl" && this.config.source.crawl) {
        robotsRules = await fetchRobotsTxt(this.config.source.crawl.baseUrl);
      }

      if (robotsRules) {
        const beforeRobots = filteredSourcePages.length;
        filteredSourcePages = filteredSourcePages.filter((p) => {
          const url = normalizeUrlPath(p.url);
          if (isBlockedByRobots(url, robotsRules!)) {
            this.logger.debug(`Excluding ${url} (blocked by robots.txt)`);
            return false;
          }
          return true;
        });
        const robotsExcluded = beforeRobots - filteredSourcePages.length;
        if (robotsExcluded > 0) {
          this.logger.info(`Excluded ${robotsExcluded} page${robotsExcluded === 1 ? "" : "s"} by robots.txt`);
        }
      }
    }
    stageEnd("filter", filterStart);

    const routeStart = stageStart();
    const routePatterns = await buildRoutePatterns(this.cwd);
    stageEnd("route_map", routeStart);
    this.logger.debug(`Route mapping: ${routePatterns.length} pattern${routePatterns.length === 1 ? "" : "s"} discovered (${stageTimingsMs["route_map"]}ms)`);

    const extractStart = stageStart();
    this.logger.info("Extracting content...");
    const extractedPages: ExtractedPage[] = [];

    for (const sourcePage of filteredSourcePages) {
      const extracted = sourcePage.html
        ? extractFromHtml(sourcePage.url, sourcePage.html, this.config)
        : extractFromMarkdown(sourcePage.url, sourcePage.markdown ?? "", sourcePage.title);

      if (!extracted) {
        this.logger.warn(
          `Page ${sourcePage.url} produced no extractable content and was skipped. ` +
            "Check extract.mainSelector, extract.dropTags, and extract.dropSelectors settings."
        );
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

    // Filter out zero-weight pages at index time.
    // Effective weight: per-page meta tag (ExtractedPage.weight) > config pageWeights > default (1.0)
    const indexablePages: ExtractedPage[] = [];
    for (const page of uniquePages) {
      const effectiveWeight = page.weight ?? findPageWeight(page.url, this.config.ranking.pageWeights);
      if (effectiveWeight === 0) {
        this.logger.debug(`Excluding ${page.url} (zero weight)`);
        continue;
      }
      indexablePages.push(page);
    }

    const zeroWeightCount = uniquePages.length - indexablePages.length;
    if (zeroWeightCount > 0) {
      this.logger.info(`Excluded ${zeroWeightCount} page${zeroWeightCount === 1 ? "" : "s"} with zero weight`);
    }

    stageEnd("extract", extractStart);
    const skippedPages = filteredSourcePages.length - indexablePages.length;
    this.logger.info(`Extracted ${indexablePages.length} page${indexablePages.length === 1 ? "" : "s"}${skippedPages > 0 ? ` (${skippedPages} skipped)` : ""} (${stageTimingsMs["extract"]}ms)`);

    const linkStart = stageStart();
    const pageSet = new Set(indexablePages.map((page) => normalizeUrlPath(page.url)));
    const incomingLinkCount = new Map<string, number>();

    for (const page of indexablePages) {
      incomingLinkCount.set(page.url, incomingLinkCount.get(page.url) ?? 0);
    }

    for (const page of indexablePages) {
      for (const outgoing of page.outgoingLinks) {
        if (!pageSet.has(outgoing)) {
          continue;
        }

        incomingLinkCount.set(outgoing, (incomingLinkCount.get(outgoing) ?? 0) + 1);
      }
    }
    stageEnd("links", linkStart);
    this.logger.debug(`Link analysis: computed incoming links for ${incomingLinkCount.size} pages (${stageTimingsMs["links"]}ms)`);

    const mirrorStart = stageStart();
    this.logger.info("Writing mirror pages...");
    const mirrorPages: MirrorPage[] = [];
    let routeExact = 0;
    let routeBestEffort = 0;

    const precomputedRoutes = new Map<string, RouteMatch>();
    for (const sp of sourcePages) {
      if (sp.routeFile) {
        precomputedRoutes.set(normalizeUrlPath(sp.url), {
          routeFile: sp.routeFile,
          routeResolution: sp.routeResolution ?? "exact"
        });
      }
    }

    for (const page of indexablePages) {
      const routeMatch = precomputedRoutes.get(normalizeUrlPath(page.url)) ?? mapUrlToRoute(page.url, routePatterns);

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
        markdown: page.markdown,
        description: page.description,
        keywords: page.keywords
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
    this.logger.info(`Mirrored ${mirrorPages.length} page${mirrorPages.length === 1 ? "" : "s"} (${routeExact} exact, ${routeBestEffort} best-effort) (${stageTimingsMs["mirror"]}ms)`);

    const chunkStart = stageStart();
    this.logger.info("Chunking pages...");
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
    this.logger.info(`Chunked into ${chunks.length} chunk${chunks.length === 1 ? "" : "s"} (${stageTimingsMs["chunk"]}ms)`);

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

    this.logger.info(`Changes detected: ${changedChunks.length} changed, ${deletes.length} deleted, ${chunks.length - changedChunks.length} unchanged`);

    const embedStart = stageStart();

    const chunkTokenEstimates = new Map<string, number>();
    for (const chunk of changedChunks) {
      chunkTokenEstimates.set(chunk.chunkKey, this.embeddings.estimateTokens(buildEmbeddingText(chunk, this.config.chunking.prependTitle)));
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
      this.logger.info(`Embedding ${changedChunks.length} chunk${changedChunks.length === 1 ? "" : "s"} (~${estimatedTokens.toLocaleString()} tokens, ~$${estimatedCostUSD.toFixed(6)})...`);
      const embeddings = await this.embeddings.embedTexts(
        changedChunks.map((chunk) => buildEmbeddingText(chunk, this.config.chunking.prependTitle)),
        this.config.embeddings.model,
        "retrieval.passage"
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
        if (!chunk || !embedding || embedding.length === 0 || embedding.some((value) => !Number.isFinite(value))) {
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
    if (changedChunks.length > 0) {
      this.logger.info(`Embedded ${newEmbeddings} chunk${newEmbeddings === 1 ? "" : "s"} (${stageTimingsMs["embedding"]}ms)`);
    } else {
      this.logger.info("No chunks to embed — all up to date");
    }

    const syncStart = stageStart();
    if (!options.dryRun) {
      this.logger.info("Syncing vectors...");
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
            chunkText: chunk.chunkText.slice(0, 4000),
            ordinal: chunk.ordinal,
            contentHash: chunk.contentHash,
            modelId: this.config.embeddings.model,
            depth: chunk.depth,
            incomingLinks: chunk.incomingLinks,
            routeFile: chunk.routeFile,
            tags: chunk.tags,
            description: chunk.description,
            keywords: chunk.keywords
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
    this.logger.debug(`Sync complete (${stageTimingsMs["sync"]}ms)`);

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

    this.logger.info("Done.");

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
