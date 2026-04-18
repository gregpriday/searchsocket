import path from "node:path";
import { IndexPipeline } from "../indexing/pipeline";
import { Logger } from "../core/logger";
import type { IndexingHooks } from "../types";

interface MinimalResolvedConfig {
  build?: { ssr?: unknown };
}

interface MinimalHookContext {
  environment?: {
    name?: string;
    config?: { build?: { ssr?: unknown } };
  };
}

interface MinimalVitePlugin {
  name: string;
  apply?: "build" | "serve";
  enforce?: "pre" | "post";
  config?: () => Record<string, unknown>;
  configResolved?: (config: MinimalResolvedConfig) => void;
  closeBundle?: {
    sequential?: boolean;
    order?: "pre" | "post";
    handler: (this: MinimalHookContext) => Promise<void> | void;
  };
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
  hooks?: IndexingHooks;
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

  return false;
}

export function searchsocketVitePlugin(options: SearchSocketAutoIndexOptions = {}): MinimalVitePlugin {
  let executed = false;
  let running = false;
  // Fallback for Vite <6 where `this.environment` isn't available in hooks.
  let resolvedIsSsrBuild = false;

  return {
    name: "searchsocket:auto-index",
    apply: "build",
    enforce: "post",
    configResolved(config) {
      resolvedIsSsrBuild = Boolean(config.build?.ssr);
    },
    closeBundle: {
      // Rollup runs `closeBundle` hooks in parallel by default. Without
      // `sequential: true`, we race against the SvelteKit adapter (which runs
      // inside sveltekit's own closeBundle on the SSR pass) and may fire
      // before `.vercel/output/` exists. Sequential + order:'post' forces us
      // to wait for all non-post closeBundles to finish first.
      sequential: true,
      order: "post",
      async handler() {
        // SvelteKit splits `vite build` into two passes (client, then SSR)
        // and only runs its adapter on the SSR pass. If we ran on the client
        // pass we'd see an empty `.vercel/output/` (adapter hasn't run yet),
        // fall back to vite preview, and crash. Prefer Vite 6+ environment
        // API; fall back to the build.ssr flag captured in configResolved.
        const envName = this.environment?.name;
        const envIsSsr = Boolean(this.environment?.config?.build?.ssr);
        const isSsrBuild = envName === "ssr" || envIsSsr || resolvedIsSsrBuild;

        if (!isSsrBuild) {
          return;
        }

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
            logger,
            hooks: options.hooks
          });

          const stats = await pipeline.run({
            changedOnly: options.changedOnly ?? true,
            force: (options.force ?? false) || /^(1|true|yes)$/i.test(process.env.SEARCHSOCKET_FORCE_REINDEX ?? ""),
            dryRun: options.dryRun ?? false,
            scopeOverride: options.scope,
            verbose: options.verbose
          });

          logger.info(
            `[searchsocket] indexed pages=${stats.pagesProcessed} chunks=${stats.chunksTotal} changed=${stats.chunksChanged} upserted=${stats.documentsUpserted}`
          );
          executed = true;
        } finally {
          running = false;
        }
      }
    }
  };
}
