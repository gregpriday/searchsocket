import path from "node:path";
import { IndexPipeline } from "../indexing/pipeline";
import { Logger } from "../core/logger";

interface MinimalVitePlugin {
  name: string;
  apply?: "build" | "serve";
  config?: () => Record<string, unknown>;
  closeBundle?: () => Promise<void> | void;
}

export interface SearchSocketAutoIndexOptions {
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

function shouldRunAutoIndex(options: SearchSocketAutoIndexOptions): boolean {
  if (options.enabled === true) {
    return true;
  }

  if (options.enabled === false) {
    return false;
  }

  const triggerEnvVar = options.triggerEnvVar ?? "SEARCHSOCKET_AUTO_INDEX";
  const disableEnvVar = options.disableEnvVar ?? "SEARCHSOCKET_DISABLE_AUTO_INDEX";

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

export function searchsocketViteConfig(): MinimalVitePlugin {
  return {
    name: "searchsocket:config",
    config() {
      return {
        ssr: {
          external: ["@libsql/client", "libsql"]
        }
      };
    }
  };
}

export function searchsocketVitePlugin(options: SearchSocketAutoIndexOptions = {}): MinimalVitePlugin {
  let executed = false;
  let running = false;

  return {
    name: "searchsocket:auto-index",
    config() {
      return {
        ssr: {
          external: ["@libsql/client", "libsql"]
        }
      };
    },
    async closeBundle() {
      if (executed || running) {
        return;
      }

      if (!shouldRunAutoIndex(options)) {
        return;
      }

      running = true;

      const cwd = path.resolve(options.cwd ?? process.cwd());
      const logger = new Logger({
        verbose: options.verbose ?? true
      });

      try {
        logger.info("[searchsocket] build completed, starting incremental index...");

        const pipeline = await IndexPipeline.create({
          cwd,
          configPath: options.configPath,
          logger
        });

        const stats = await pipeline.run({
          changedOnly: options.changedOnly ?? true,
          force: (options.force ?? false) || /^(1|true|yes)$/i.test(process.env.SEARCHSOCKET_FORCE_REINDEX ?? ""),
          dryRun: options.dryRun ?? false,
          scopeOverride: options.scope,
          verbose: options.verbose
        });

        logger.info(
          `[searchsocket] indexed pages=${stats.pagesProcessed} chunks=${stats.chunksTotal} changed=${stats.chunksChanged} embedded=${stats.newEmbeddings}`
        );
        executed = true;
      } finally {
        running = false;
      }
    }
  };
}
