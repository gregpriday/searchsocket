import path from "node:path";
import { loadConfig } from "../config/load";
import { resolveScope } from "../core/scope";
import { ensureStateDirs } from "../core/state";
import { SearchSocketError } from "../errors";
import { createUpstashStore } from "../vector";
import { UpstashSearchStore } from "../vector/upstash";
import { buildEmbeddingText, chunkPage } from "./chunker";
import { extractFromHtml, extractFromMarkdown } from "./extractor";
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
  ExtractedPage,
  IndexedPage,
  IndexOptions,
  IndexStats,
  PageRecord,
  ResolvedSearchSocketConfig,
  RouteMatch,
  Scope
} from "../types";

/**
 * Build a plain-text summary of a page for the page search index.
 * Combines title, description, and stripped markdown body (truncated to maxChars).
 */
export function buildPageSummary(page: IndexedPage, maxChars = 3500): string {
  const parts: string[] = [page.title];

  if (page.description) {
    parts.push(page.description);
  }

  if (page.keywords && page.keywords.length > 0) {
    parts.push(page.keywords.join(", "));
  }

  // Strip markdown formatting to get plain body text
  const plainBody = page.markdown
    .replace(/```[\s\S]*?```/g, " ")   // remove code blocks
    .replace(/`([^`]+)`/g, "$1")       // inline code → text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1") // links/images → text
    .replace(/^#{1,6}\s+/gm, "")       // headings → text
    .replace(/[>*_|~\-]/g, " ")        // strip formatting chars
    .replace(/\s+/g, " ")
    .trim();

  if (plainBody) {
    parts.push(plainBody);
  }

  const joined = parts.join("\n\n");
  if (joined.length <= maxChars) return joined;
  return joined.slice(0, maxChars).trim();
}

interface IndexPipelineOptions {
  cwd?: string;
  configPath?: string;
  config?: ResolvedSearchSocketConfig;
  store?: UpstashSearchStore;
  logger?: Logger;
}

export class IndexPipeline {
  private readonly cwd: string;
  private readonly config: ResolvedSearchSocketConfig;
  private readonly store: UpstashSearchStore;
  private readonly logger: Logger;

  private constructor(options: {
    cwd: string;
    config: ResolvedSearchSocketConfig;
    store: UpstashSearchStore;
    logger: Logger;
  }) {
    this.cwd = options.cwd;
    this.config = options.config;
    this.store = options.store;
    this.logger = options.logger;
  }

  static async create(options: IndexPipelineOptions = {}): Promise<IndexPipeline> {
    const cwd = path.resolve(options.cwd ?? process.cwd());
    const config = options.config ?? (await loadConfig({ cwd, configPath: options.configPath }));
    const store = options.store ?? await createUpstashStore(config);

    return new IndexPipeline({
      cwd,
      config,
      store,
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
    ensureStateDirs(this.cwd, this.config.state.dir, scope);

    const sourceMode = options.sourceOverride ?? this.config.source.mode;
    this.logger.info(`Indexing scope "${scope.scopeName}" (source: ${sourceMode}, backend: upstash-search)`);

    if (options.force) {
      this.logger.info("Force mode enabled — full rebuild");
    }

    if (options.dryRun) {
      this.logger.info("Dry run — no writes will be performed");
    }

    const manifestStart = stageStart();
    const existingHashes = options.force ? new Map<string, string>() : await this.store.getContentHashes(scope);
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

    const pagesStart = stageStart();
    this.logger.info("Building indexed pages...");
    const pages: IndexedPage[] = [];
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

      const indexedPage: IndexedPage = {
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

      pages.push(indexedPage);
      this.logger.event("page_indexed", { url: page.url });
    }

    // Store pages in Upstash (replace entire scope to remove stale pages)
    if (!options.dryRun) {
      const pageRecords: PageRecord[] = pages.map((p) => {
        const summary = buildPageSummary(p);
        return {
          url: p.url,
          title: p.title,
          markdown: p.markdown,
          projectId: scope.projectId,
          scopeName: scope.scopeName,
          routeFile: p.routeFile,
          routeResolution: p.routeResolution,
          incomingLinks: p.incomingLinks,
          outgoingLinks: p.outgoingLinks,
          depth: p.depth,
          tags: p.tags,
          indexedAt: p.generatedAt,
          summary,
          description: p.description,
          keywords: p.keywords
        };
      });
      await this.store.deletePages(scope);
      await this.store.upsertPages(pageRecords, scope);
    }

    stageEnd("pages", pagesStart);
    this.logger.info(`Indexed ${pages.length} page${pages.length === 1 ? "" : "s"} (${routeExact} exact, ${routeBestEffort} best-effort) (${stageTimingsMs["pages"]}ms)`);

    const chunkStart = stageStart();
    this.logger.info("Chunking pages...");
    let chunks: Chunk[] = pages.flatMap((page) => chunkPage(page, this.config, scope));

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

    // Upsert changed chunks directly to Upstash Search (no embedding step needed)
    const upsertStart = stageStart();
    let documentsUpserted = 0;

    if (!options.dryRun && changedChunks.length > 0) {
      this.logger.info(`Upserting ${changedChunks.length} chunk${changedChunks.length === 1 ? "" : "s"} to Upstash Search...`);

      // Upstash Search has a 4096-char limit on total content across all fields.
      // Reserve space for non-text fields, then truncate text to fit.
      const UPSTASH_CONTENT_LIMIT = 4096;
      const FIELD_OVERHEAD = 200; // buffer for title, sectionTitle, url, tags, headingPath
      const MAX_TEXT_CHARS = UPSTASH_CONTENT_LIMIT - FIELD_OVERHEAD;

      const docs = changedChunks.map((chunk) => {
        const title = chunk.title;
        const sectionTitle = chunk.sectionTitle ?? "";
        const url = chunk.url;
        const tags = chunk.tags.join(",");
        const headingPath = chunk.headingPath.join(" > ");
        const otherFieldsLen = title.length + sectionTitle.length + url.length + tags.length + headingPath.length;
        const textBudget = Math.max(500, UPSTASH_CONTENT_LIMIT - otherFieldsLen - 50);
        const text = buildEmbeddingText(chunk, this.config.chunking.prependTitle).slice(0, textBudget);

        return {
          id: chunk.chunkKey,
          content: { title, sectionTitle, text, url, tags, headingPath },
          metadata: {
            projectId: scope.projectId,
            scopeName: scope.scopeName,
            path: chunk.path,
            snippet: chunk.snippet,
            ordinal: chunk.ordinal,
            contentHash: chunk.contentHash,
            depth: chunk.depth,
            incomingLinks: chunk.incomingLinks,
            routeFile: chunk.routeFile,
            description: chunk.description ?? "",
            keywords: (chunk.keywords ?? []).join(",")
          }
        };
      });

      await this.store.upsertChunks(docs, scope);
      documentsUpserted = docs.length;
      this.logger.event("upserted", { count: docs.length });
    }

    if (!options.dryRun && deletes.length > 0) {
      await this.store.deleteByIds(deletes, scope);
      this.logger.event("deleted", { count: deletes.length });
    }

    stageEnd("upsert", upsertStart);
    if (changedChunks.length > 0) {
      this.logger.info(`Upserted ${documentsUpserted} document${documentsUpserted === 1 ? "" : "s"} (${stageTimingsMs["upsert"]}ms)`);
    } else {
      this.logger.info("No chunks to upsert — all up to date");
    }

    this.logger.info("Done.");

    return {
      pagesProcessed: pages.length,
      chunksTotal: chunks.length,
      chunksChanged: changedChunks.length,
      documentsUpserted,
      deletes: deletes.length,
      routeExact,
      routeBestEffort,
      stageTimingsMs
    };
  }
}
