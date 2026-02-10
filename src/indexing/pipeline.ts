import path from "node:path";
import { loadConfig } from "../config/load";
import { resolveScope } from "../core/scope";
import {
  ensureStateDirs,
  getScopeManifest,
  readManifest,
  upsertRegistryScope,
  writeManifest
} from "../core/state";
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
    const manifestFile = readManifest(statePath);
    const scopeManifest = getScopeManifest(manifestFile, scope, this.config.embeddings.model);

    if (
      scopeManifest.embeddingModel &&
      scopeManifest.embeddingModel !== this.config.embeddings.model &&
      !options.force
    ) {
      throw new SearchSocketError(
        "EMBEDDING_MODEL_MISMATCH",
        `Scope ${scope.scopeName} uses model ${scopeManifest.embeddingModel}. Re-run with --force to migrate.`
      );
    }

    if (options.force) {
      scopeManifest.chunks = {};
    }

    // Preflight: detect manifest vs remote desynchronization.
    // If the local manifest has chunks but the remote registry shows vectorCount=0,
    // the remote was likely wiped externally and we need a full re-sync.
    const manifestChunkCount = Object.keys(scopeManifest.chunks).length;
    if (manifestChunkCount > 0 && !options.force && !options.dryRun) {
      try {
        const remoteScopes = await this.vectorStore.listScopes(scope.projectId);
        const remoteScope = remoteScopes.find(
          (s) => s.scopeName === scope.scopeName
        );

        if (remoteScope && remoteScope.vectorCount === 0) {
          this.logger.warn(
            `Local manifest has ${manifestChunkCount} chunks but remote reports 0 vectors. ` +
              "The remote index may have been wiped. Re-running with --force to re-sync."
          );
          scopeManifest.chunks = {};
        } else if (!remoteScope && manifestChunkCount > 0) {
          this.logger.warn(
            `Local manifest has ${manifestChunkCount} chunks but no remote registry entry found. ` +
              "The remote index may have been wiped. Re-running with --force to re-sync."
          );
          scopeManifest.chunks = {};
        }
      } catch {
        // If we cannot reach the remote to verify, proceed normally.
        // The worst case is unchanged chunks are skipped (existing behavior).
      }
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
    stageEnd("extract", extractStart);

    const linkStart = stageStart();
    const pageSet = new Set(extractedPages.map((page) => normalizeUrlPath(page.url)));
    const incomingLinkCount = new Map<string, number>();

    for (const page of extractedPages) {
      incomingLinkCount.set(page.url, incomingLinkCount.get(page.url) ?? 0);
    }

    for (const page of extractedPages) {
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

    for (const page of extractedPages) {
      const routeMatch = mapUrlToRoute(page.url, routePatterns);

      if (routeMatch.routeResolution === "best-effort") {
        if (this.config.source.strictRouteMapping) {
          throw new SearchSocketError(
            "INVALID_REQUEST",
            `Strict route mapping enabled: no exact route match for ${page.url} (resolved to ${routeMatch.routeFile}). ` +
              "Disable source.strictRouteMapping or add the missing route file."
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
      await writeMirrorPage(statePath, scope, mirror);
      this.logger.event("markdown_written", { url: page.url });
    }
    stageEnd("mirror", mirrorStart);

    const chunkStart = stageStart();
    let chunks: Chunk[] = mirrorPages.flatMap((page) => chunkMirrorPage(page, this.config, scope));

    if (typeof options.maxChunks === "number") {
      chunks = chunks.slice(0, options.maxChunks);
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

      const existing = scopeManifest.chunks[chunk.chunkKey];
      if (!existing) {
        return true;
      }

      if (!options.changedOnly) {
        return true;
      }

      return existing.contentHash !== chunk.contentHash;
    });

    const deletes = Object.keys(scopeManifest.chunks).filter((chunkKey) => !currentChunkMap.has(chunkKey));

    const embedStart = stageStart();

    const chunkTokenEstimates = new Map<string, number>();
    for (const chunk of changedChunks) {
      chunkTokenEstimates.set(chunk.chunkKey, this.embeddings.estimateTokens(chunk.chunkText));
    }

    const estimatedTokens = changedChunks.reduce(
      (sum, chunk) => sum + (chunkTokenEstimates.get(chunk.chunkKey) ?? 0),
      0
    );

    const estimatedCostUSD =
      (estimatedTokens / 1000) *
      (EMBEDDING_PRICE_PER_1K_TOKENS_USD[this.config.embeddings.model] ??
        EMBEDDING_PRICE_PER_1K_TOKENS_USD["text-embedding-3-small"] ??
        DEFAULT_EMBEDDING_PRICE_PER_1K);

    let newEmbeddings = 0;
    const vectorsByChunk = new Map<string, number[]>();

    if (!options.dryRun && changedChunks.length > 0) {
      const embeddings = await this.embeddings.embedTexts(
        changedChunks.map((chunk) => chunk.chunkText),
        this.config.embeddings.model
      );

      for (let i = 0; i < changedChunks.length; i += 1) {
        const chunk = changedChunks[i];
        const embedding = embeddings[i];
        if (!chunk || !embedding) {
          continue;
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
      const nextChunkMap: Record<string, { contentHash: string; url: string }> = {};

      for (const chunk of chunks) {
        nextChunkMap[chunk.chunkKey] = {
          contentHash: chunk.contentHash,
          url: chunk.url
        };
      }

      scopeManifest.projectId = scope.projectId;
      scopeManifest.scopeName = scope.scopeName;
      scopeManifest.embeddingModel = this.config.embeddings.model;
      scopeManifest.lastIndexedAt = nowIso();
      scopeManifest.lastEstimate = {
        changedChunks: changedChunks.length,
        estimatedTokens,
        estimatedCostUSD: Number(estimatedCostUSD.toFixed(8))
      };
      scopeManifest.chunks = nextChunkMap;

      writeManifest(statePath, manifestFile);

      const scopeInfo: ScopeInfo = {
        projectId: scope.projectId,
        scopeName: scope.scopeName,
        modelId: this.config.embeddings.model,
        lastIndexedAt: scopeManifest.lastIndexedAt,
        vectorCount: chunks.length
      };

      upsertRegistryScope(statePath, scopeInfo);
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
