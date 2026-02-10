import path from "node:path";
import { IndexPipeline } from "../indexing/pipeline";
import { Logger } from "../core/logger";

interface MinimalVitePlugin {
  name: string;
  apply?: "build" | "serve";
  closeBundle?: () => Promise<void> | void;
}

export interface SiteScribeAutoIndexOptions {
  cwd?: string;
  configPath?: string;
  enabled?: boolean;
  triggerEnvVar?: string;
  disableEnvVar?: string;
  changedOnly?: boolean;
  force?: boolean;
  dryRun?: boolean;
  scope?: string;
  verbose?: boolean;
}

function shouldRunAutoIndex(options: SiteScribeAutoIndexOptions): boolean {
  if (options.enabled === true) {
    return true;
  }

  if (options.enabled === false) {
    return false;
  }

  const triggerEnvVar = options.triggerEnvVar ?? "SITESCRIBE_AUTO_INDEX";
  const disableEnvVar = options.disableEnvVar ?? "SITESCRIBE_DISABLE_AUTO_INDEX";

  const disabled = process.env[disableEnvVar];
  if (disabled && /^(1|true|yes)$/i.test(disabled)) {
    return false;
  }

  const explicit = process.env[triggerEnvVar];
  if (explicit && /^(1|true|yes)$/i.test(explicit)) {
    return true;
  }

  // CI defaults to enabled when explicitly configured for content deployments.
  if (process.env.CI && /^(1|true)$/i.test(process.env.CI)) {
    return true;
  }

  return false;
}

export function sitescribeVitePlugin(options: SiteScribeAutoIndexOptions = {}): MinimalVitePlugin {
  let executed = false;

  return {
    name: "sitescribe:auto-index",
    apply: "build",
    async closeBundle() {
      if (executed) {
        return;
      }

      if (!shouldRunAutoIndex(options)) {
        return;
      }

      executed = true;

      const cwd = path.resolve(options.cwd ?? process.cwd());
      const logger = new Logger({
        verbose: options.verbose ?? true
      });

      logger.info("[sitescribe] build completed, starting incremental index...");

      const pipeline = await IndexPipeline.create({
        cwd,
        configPath: options.configPath,
        logger
      });

      const stats = await pipeline.run({
        changedOnly: options.changedOnly ?? true,
        force: options.force ?? false,
        dryRun: options.dryRun ?? false,
        scopeOverride: options.scope,
        verbose: options.verbose
      });

      logger.info(
        `[sitescribe] indexed pages=${stats.pagesProcessed} chunks=${stats.chunksTotal} changed=${stats.chunksChanged} cached=${stats.cachedEmbeddings} new=${stats.newEmbeddings}`
      );
      logger.info("[sitescribe] markdown mirror written under .sitescribe/pages/<scope> (safe to commit for content workflows).");
    }
  };
}
