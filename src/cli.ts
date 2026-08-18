import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { execSync } from "node:child_process";
import { config as dotenvConfig } from "dotenv";
import chokidar from "chokidar";
import { Command, Option } from "commander";
import pkg from "../package.json";
import { writeMinimalConfig, loadConfig, mergeConfig } from "./config/load";
import { Logger } from "./core/logger";
import { resolveScope } from "./core/scope";
import { ensureStateDirs } from "./core/state";
import { SearchSocketError } from "./errors";
import { IndexPipeline } from "./indexing/pipeline";
import { runMcpServer } from "./mcp/server";
import { runPlaygroundServer } from "./playground/server";
import { SearchEngine } from "./search/engine";
import { reciprocalRank, mrr } from "./search/quality-metrics";
import { testFileSchema } from "./cli/test-schemas";
import { createUpstashStore } from "./vector";
import { sanitizeScopeName } from "./utils/text";
import type { IndexStats, ResolvedSearchSocketConfig, Scope, ScopeInfo, SearchResult } from "./types";
import type { UpstashSearchStore } from "./vector/upstash";
import * as clack from "@clack/prompts";
import {
  ensureMcpJson,
  injectHooksServerTs,
  injectViteConfig,
  writeEnvFile,
  HOOKS_SNIPPET,
  VITE_PLUGIN_SNIPPET,
} from "./init-helpers";
import { copyComponent, isValidComponent, listAvailableComponents } from "./add-helpers";
import { INDEX_SCHEMA_VERSION } from "./vector/ids";
import { parseRemoteBranches, selectStaleScopes, type PruneMatchMode } from "./cli/services/prune";

interface RootCommandOptions {
  cwd?: string;
  config?: string;
}

function parsePositiveInt(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new SearchSocketError("INVALID_REQUEST", `${flag} must be a positive integer`, 400);
  }
  return parsed;
}

function parseDurationMs(value: string): number {
  const match = value.trim().match(/^(\d+)(ms|s|m|h|d)$/i);
  if (!match) {
    throw new SearchSocketError(
      "INVALID_REQUEST",
      "Duration must look like 30d, 12h, 15m, 45s, or 500ms",
      400
    );
  }

  const amount = Number(match[1]);
  const unit = (match[2] ?? "").toLowerCase();

  switch (unit) {
    case "ms":
      return amount;
    case "s":
      return amount * 1000;
    case "m":
      return amount * 60_000;
    case "h":
      return amount * 3_600_000;
    case "d":
      return amount * 86_400_000;
    default:
      throw new SearchSocketError("INVALID_REQUEST", `Unsupported duration unit: ${unit}`, 400);
  }
}

function printIndexSummary(stats: IndexStats): void {
  process.stdout.write(`pages processed: ${stats.pagesProcessed}\n`);
  process.stdout.write(`pages changed: ${stats.pagesChanged}\n`);
  process.stdout.write(`pages deleted: ${stats.pagesDeleted}\n`);
  process.stdout.write(`chunks total: ${stats.chunksTotal}\n`);
  process.stdout.write(`chunks changed: ${stats.chunksChanged}\n`);
  process.stdout.write(`documents upserted: ${stats.documentsUpserted}\n`);
  process.stdout.write(`deletes: ${stats.deletes}\n`);
  process.stdout.write(`route mapping: ${stats.routeExact} exact, ${stats.routeBestEffort} best-effort\n`);
  process.stdout.write(`deletion eligible: ${stats.deletionEligible ? "yes" : "no"}\n`);
  if (stats.warnings.length > 0) {
    process.stdout.write(`warnings (${stats.warnings.length}):\n`);
    for (const warning of stats.warnings) {
      process.stdout.write(`  ${warning.kind}: ${warning.detail}\n`);
    }
  }
  if (stats.dangerousOperations.length > 0) {
    process.stdout.write("destructive operations:\n");
    for (const op of stats.dangerousOperations) {
      process.stdout.write(`  ${op}\n`);
    }
  }
  process.stdout.write("stage timings (ms):\n");
  for (const [stage, ms] of Object.entries(stats.stageTimingsMs)) {
    process.stdout.write(`  ${stage}: ${ms}\n`);
  }
}

function collectWatchPaths(config: ResolvedSearchSocketConfig, cwd: string): string[] {
  const paths = ["src/routes/**"];

  if (config.source.mode === "content-files" && config.source.contentFiles) {
    for (const pattern of config.source.contentFiles.globs) {
      paths.push(path.join(config.source.contentFiles.baseDir, pattern));
    }
  }

  if (config.source.mode === "static-output") {
    paths.push(config.source.staticOutputDir);
  }

  if (config.source.mode === "crawl") {
    paths.push("searchsocket.config.ts");
  }

  if (config.source.mode === "build" && config.source.build) {
    paths.push("searchsocket.config.ts");
    paths.push(config.source.build.outputDir);
  }

  return paths.map((value) => path.resolve(cwd, value));
}

function ensureStateDir(cwd: string): string {
  const target = path.join(cwd, ".searchsocket");
  fs.mkdirSync(target, { recursive: true });
  return target;
}

function ensureGitignore(cwd: string): void {
  const gitignorePath = path.join(cwd, ".gitignore");
  const entries = [
    ".searchsocket/manifest.json",
    ".searchsocket/registry.json"
  ];

  let content = "";
  if (fs.existsSync(gitignorePath)) {
    content = fs.readFileSync(gitignorePath, "utf8");
  }

  const lines = content.split("\n");
  const missing = entries.filter((entry) => !lines.some((line) => line.trim() === entry));

  if (missing.length === 0) {
    return;
  }

  const block = `\n# SearchSocket local state\n${missing.join("\n")}\n`;
  fs.writeFileSync(gitignorePath, content.trimEnd() + block, "utf8");
}

function readScopesFromFile(filePath: string): Set<string> {
  const raw = fs.readFileSync(filePath, "utf8");
  return new Set(
    raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
  );
}

/**
 * The set of branch names that exist on remotes, used by `prune` to decide
 * which scopes are orphaned.
 *
 * Returns `null` — not an empty set — whenever the inventory cannot be trusted.
 * A shallow clone, a missing remote, or a git failure all yield a short or
 * empty branch list, and treating that as "these are all the branches" marks
 * every live scope orphaned and deletes it.
 */
function readRemoteGitBranches(cwd: string): Set<string> | null {
  const git = (args: string): string =>
    execSync(`git ${args}`, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });

  try {
    // A shallow checkout does not have the full ref set. `actions/checkout`
    // defaults to fetch-depth: 1, so this is the common CI case.
    if (git("rev-parse --is-shallow-repository").trim() === "true") {
      process.stderr.write(
        "warning: repository is a shallow clone, so its branch list is incomplete.\n"
      );
      return null;
    }

    const remotes = git("remote")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    if (remotes.length === 0) {
      process.stderr.write("warning: repository has no configured remotes.\n");
      return null;
    }

    const scopes = parseRemoteBranches(git("branch -r --format='%(refname:short)'"), remotes);
    if (scopes === null) {
      process.stderr.write("warning: no remote branches found.\n");
      return null;
    }

    return scopes;
  } catch {
    return null;
  }
}

async function loadResolvedConfigForDev(cwd: string, configPath?: string): Promise<ResolvedSearchSocketConfig> {
  const resolvedConfigPath = path.resolve(cwd, configPath ?? "searchsocket.config.ts");
  if (fs.existsSync(resolvedConfigPath)) {
    return loadConfig({ cwd, configPath });
  }

  return mergeConfig(cwd, {});
}

function getRootOptions(command: Command): RootCommandOptions {
  const maybeParent = command.parent as Command | undefined;
  const optsFn = maybeParent?.opts;
  if (typeof optsFn !== "function") {
    return {};
  }

  return optsFn.call(maybeParent) as RootCommandOptions;
}

/**
 * Stable process exit codes. Machine consumers (CI, the prune workflow) branch
 * on these, so the meanings must not be reassigned.
 */
const EXIT_OPERATIONAL_FAILURE = 1;
const EXIT_INVALID_USAGE = 2;
const EXIT_QUALITY_GATE = 3;
const EXIT_DESTRUCTIVE_REFUSED = 4;
const EXIT_BACKEND_UNAVAILABLE = 5;

async function runIndexCommand(opts: {
  cwd: string;
  configPath?: string;
  scope?: string;
  changedOnly: boolean;
  force: boolean;
  dryRun: boolean;
  source?: "static-output" | "crawl" | "content-files" | "build";
  maxPages?: number;
  maxChunks?: number;
  quiet?: boolean;
  verbose?: boolean;
  json?: boolean;
  allowEmpty?: boolean;
  acceptLargeDeletion?: boolean;
  /**
   * Treat a missing backend as a skip rather than a failure. The Vite plugin
   * sets this so an unconfigured local build still succeeds; an explicit
   * `searchsocket index` must fail instead of silently doing nothing.
   */
  allowUnconfigured?: boolean;
}): Promise<void> {
  const logger = new Logger({
    quiet: opts.quiet,
    verbose: opts.verbose,
    json: opts.json
  });

  let pipeline: IndexPipeline;
  try {
    pipeline = await IndexPipeline.create({
      cwd: opts.cwd,
      configPath: opts.configPath,
      logger
    });
  } catch (error) {
    if (error instanceof SearchSocketError && error.code === "VECTOR_BACKEND_UNAVAILABLE") {
      if (opts.allowUnconfigured) {
        logger.warn("Search backend not configured — skipping indexing. Set UPSTASH_VECTOR_REST_URL and UPSTASH_VECTOR_REST_TOKEN to enable.");
        return;
      }
      // An explicit index run that indexes nothing must not report success:
      // CI would treat a missing credential as a green deploy.
      logger.error(
        "Search backend not configured. Set UPSTASH_VECTOR_REST_URL and UPSTASH_VECTOR_REST_TOKEN, " +
          "or pass --allow-unconfigured to skip indexing without failing."
      );
      process.exitCode = EXIT_BACKEND_UNAVAILABLE;
      return;
    }
    throw error;
  }

  const stats = await pipeline.run({
    scopeOverride: opts.scope,
    changedOnly: opts.changedOnly,
    force: opts.force,
    dryRun: opts.dryRun,
    sourceOverride: opts.source,
    maxPages: opts.maxPages,
    maxChunks: opts.maxChunks,
    verbose: opts.verbose,
    allowEmpty: opts.allowEmpty,
    acceptLargeDeletion: opts.acceptLargeDeletion
  });

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(stats, null, 2)}\n`);
    return;
  }

  if (!opts.quiet) {
    printIndexSummary(stats);
  }
}

async function runInteractiveInit(cwd: string): Promise<void> {
  clack.intro("searchsocket setup");

  // Step 1: Config file + state dir + gitignore + MCP
  const s = clack.spinner();
  s.start("Creating config files");
  const configPath = writeMinimalConfig(cwd);
  ensureStateDir(cwd);
  ensureGitignore(cwd);
  ensureMcpJson(cwd);
  s.stop("Config files created");

  // Step 2: Check for Upstash credentials
  const hasUrl = Boolean(process.env.UPSTASH_VECTOR_REST_URL);
  const hasToken = Boolean(process.env.UPSTASH_VECTOR_REST_TOKEN);

  if (!hasUrl || !hasToken) {
    clack.log.warn("Upstash Search credentials not found in environment.");

    const shouldConfigure = await clack.confirm({
      message: "Would you like to configure Upstash credentials now?",
      initialValue: true,
    });

    if (clack.isCancel(shouldConfigure)) {
      clack.cancel("Setup cancelled.");
      process.exit(0);
    }

    if (shouldConfigure) {
      const url = hasUrl
        ? process.env.UPSTASH_VECTOR_REST_URL!
        : await clack.text({
            message: "Upstash Search REST URL:",
            placeholder: "https://your-index.upstash.io",
            validate: (v) => (!v ? "URL is required" : undefined),
          });

      if (clack.isCancel(url)) {
        clack.cancel("Setup cancelled.");
        process.exit(0);
      }

      const token = hasToken
        ? process.env.UPSTASH_VECTOR_REST_TOKEN!
        : await clack.text({
            message: "Upstash Search REST Token:",
            placeholder: "AX...",
            validate: (v) => (!v ? "Token is required" : undefined),
          });

      if (clack.isCancel(token)) {
        clack.cancel("Setup cancelled.");
        process.exit(0);
      }

      writeEnvFile(cwd, url as string, token as string);
      clack.log.success("Credentials written to .env");
    }
  } else {
    clack.log.success("Upstash credentials found in environment.");
  }

  // Step 3: Inject hooks.server.ts
  s.start("Configuring hooks.server.ts");
  const hookResult = injectHooksServerTs(cwd);
  s.stop("hooks.server.ts configured");

  switch (hookResult) {
    case "created":
      clack.log.success("Created src/hooks.server.ts with searchsocketHandle.");
      break;
    case "injected":
      clack.log.success("Added searchsocketHandle to src/hooks.server.ts.");
      break;
    case "composed":
      clack.log.success("Composed searchsocketHandle with existing handle using sequence().");
      break;
    case "already-present":
      clack.log.info("searchsocketHandle already configured in hooks.server.ts.");
      break;
    case "fallback":
      clack.log.warn("Could not auto-inject hooks.server.ts. Add manually:");
      clack.log.message(HOOKS_SNIPPET);
      break;
  }

  // Step 4: Inject vite config
  s.start("Configuring Vite plugin");
  const viteResult = injectViteConfig(cwd);
  s.stop("Vite plugin configured");

  switch (viteResult) {
    case "injected":
      clack.log.success("Added searchsocketVitePlugin to Vite config.");
      break;
    case "already-present":
      clack.log.info("searchsocketVitePlugin already in Vite config.");
      break;
    case "no-config":
      clack.log.warn("No vite.config.ts/js found. Add the plugin manually:");
      clack.log.message(VITE_PLUGIN_SNIPPET);
      break;
    case "fallback":
      clack.log.warn("Could not auto-inject Vite config. Add manually:");
      clack.log.message(VITE_PLUGIN_SNIPPET);
      break;
  }

  clack.log.info("Run `searchsocket doctor` to verify your setup.");
  clack.outro("SearchSocket initialized! Run `searchsocket index` to index your site.");
}

async function runSilentInit(cwd: string): Promise<void> {
  const configPath = writeMinimalConfig(cwd);
  const stateDir = ensureStateDir(cwd);
  ensureGitignore(cwd);
  ensureMcpJson(cwd);

  process.stdout.write(`created/verified config: ${configPath}\n`);
  process.stdout.write(`created/verified state dir: ${stateDir}\n`);
  process.stdout.write("created/verified .mcp.json (MCP server config for Claude Code)\n\n");

  // Attempt auto-injection
  const hookResult = injectHooksServerTs(cwd);
  switch (hookResult) {
    case "created":
      process.stdout.write("created src/hooks.server.ts with searchsocketHandle\n");
      break;
    case "injected":
      process.stdout.write("added searchsocketHandle to src/hooks.server.ts\n");
      break;
    case "composed":
      process.stdout.write("composed searchsocketHandle with existing handle via sequence()\n");
      break;
    case "already-present":
      process.stdout.write("searchsocketHandle already present in hooks.server.ts\n");
      break;
    case "fallback":
      process.stdout.write("could not auto-inject hooks.server.ts — add manually:\n\n");
      process.stdout.write(HOOKS_SNIPPET + "\n\n");
      break;
  }

  const viteResult = injectViteConfig(cwd);
  switch (viteResult) {
    case "injected":
      process.stdout.write("added searchsocketVitePlugin to Vite config\n");
      break;
    case "already-present":
      process.stdout.write("searchsocketVitePlugin already in Vite config\n");
      break;
    case "no-config":
      process.stdout.write("no vite.config.ts/js found — add plugin manually:\n\n");
      process.stdout.write(VITE_PLUGIN_SNIPPET + "\n\n");
      break;
    case "fallback":
      process.stdout.write("could not auto-inject Vite config — add manually:\n\n");
      process.stdout.write(VITE_PLUGIN_SNIPPET + "\n\n");
      break;
  }
}

const program = new Command();

program
  .name("searchsocket")
  .description("Semantic site search and MCP retrieval for SvelteKit")
  .version(pkg.version)
  .option("-C, --cwd <path>", "working directory", process.cwd())
  .option("--config <path>", "config path (defaults to searchsocket.config.ts)");

program
  .command("init")
  .description("Initialize SearchSocket in a SvelteKit project")
  .option("--non-interactive", "skip interactive prompts")
  .action(async (opts, command) => {
    const root = getRootOptions(command).cwd ?? process.cwd();
    const cwd = path.resolve(root);
    const isInteractive = Boolean(process.stdout.isTTY) && !opts.nonInteractive;

    if (isInteractive) {
      await runInteractiveInit(cwd);
    } else {
      await runSilentInit(cwd);
    }
  });

program
  .command("index")
  .description("Index site content into Upstash Search")
  .option("--scope <name>", "scope override")
  .option("--changed-only", "only process changed chunks", true)
  .option("--no-changed-only", "re-index regardless of previous manifest")
  .option("--force", "force full rebuild", false)
  .option("--dry-run", "compute plan, no writes", false)
  .option("--source <mode>", "source mode override: static-output|crawl|content-files|build")
  .option("--max-pages <n>", "limit pages processed")
  .option("--max-chunks <n>", "limit chunks processed")
  .option("--quiet", "suppress all output except errors and warnings", false)
  .option("--verbose", "verbose output", false)
  .option("--json", "emit JSON logs and summary", false)
  .option("--allow-empty", "permit deleting all records when the source legitimately produced zero pages", false)
  .option("--accept-large-deletion", "permit a deletion exceeding indexing.maxDeletionRatio", false)
  .option("--allow-unconfigured", "exit 0 instead of failing when no vector backend is configured", false)
  .action(async (opts, command) => {
    const rootOpts = getRootOptions(command);
    const cwd = path.resolve(rootOpts?.cwd ?? process.cwd());

    await runIndexCommand({
      cwd,
      configPath: rootOpts?.config,
      scope: opts.scope,
      changedOnly: opts.changedOnly,
      force: opts.force || /^(1|true|yes)$/i.test(process.env.SEARCHSOCKET_FORCE_REINDEX ?? ""),
      dryRun: opts.dryRun,
      source: opts.source,
      maxPages: opts.maxPages ? parsePositiveInt(opts.maxPages, "--max-pages") : undefined,
      maxChunks: opts.maxChunks ? parsePositiveInt(opts.maxChunks, "--max-chunks") : undefined,
      quiet: opts.quiet,
      verbose: opts.verbose,
      json: opts.json,
      allowEmpty: opts.allowEmpty,
      acceptLargeDeletion: opts.acceptLargeDeletion,
      allowUnconfigured: opts.allowUnconfigured
    });
  });

program
  .command("status")
  .description("Show scope, indexing state, and backend health")
  .option("--scope <name>", "scope override")
  .action(async (opts, command) => {
    const rootOpts = getRootOptions(command);
    const cwd = path.resolve(rootOpts?.cwd ?? process.cwd());

    const config = await loadConfig({ cwd, configPath: rootOpts?.config });
    const scope = resolveScope(config, opts.scope);

    let store: UpstashSearchStore;
    let health: { ok: boolean; details?: string } = { ok: false, details: "not checked" };
    try {
      store = await createUpstashStore(config);
      health = await store.health();
    } catch (error) {
      health = {
        ok: false,
        details: error instanceof Error ? error.message : "unknown error"
      };
      process.stdout.write(`project: ${config.project.id}\n`);
      process.stdout.write(`backend health: error (${health.details})\n`);
      process.exitCode = 1;
      return;
    }

    let scopeRegistry: ScopeInfo[] = [];
    let scopeInfo: ScopeInfo | undefined;

    try {
      scopeRegistry = await store.listScopes(config.project.id);
      scopeInfo = scopeRegistry.find((entry) => entry.scopeName === scope.scopeName);
    } catch (error) {
      process.stdout.write(`project: ${config.project.id}\n`);
      process.stdout.write(`resolved scope: ${scope.scopeName}\n`);
      process.stdout.write(`backend health: error (${error instanceof Error ? error.message : "unknown error"})\n`);
      process.exitCode = 1;
      return;
    }

    process.stdout.write(`project: ${config.project.id}\n`);
    process.stdout.write(`resolved scope: ${scope.scopeName}\n`);
    process.stdout.write(`backend: upstash-vector\n`);
    process.stdout.write(`backend health: ${health.ok ? "ok" : `error (${health.details ?? "n/a"})`}\n`);

    if (scopeInfo) {
      process.stdout.write(`last indexed (${scope.scopeName}): ${scopeInfo.lastIndexedAt ?? "never"}\n`);
      if (scopeInfo.documentCount != null) {
        process.stdout.write(`documents: ${scopeInfo.documentCount}\n`);
      }
    } else {
      process.stdout.write(`last indexed (${scope.scopeName}): never\n`);
    }

    if (scopeRegistry.length > 0) {
      process.stdout.write("\nregistry scopes:\n");
      for (const item of scopeRegistry) {
        process.stdout.write(
          `  - ${item.scopeName} lastIndexedAt=${item.lastIndexedAt} documents=${item.documentCount ?? "unknown"}\n`
        );
      }
    }
  });

program
  .command("dev")
  .description("Watch content files/routes and incrementally reindex on changes")
  .option("--scope <name>", "scope override")
  .option("--playground", "serve playground UI at /_searchsocket (default: true)", true)
  .option("--no-playground", "disable playground UI")
  .option("--playground-port <n>", "playground HTTP port", "3337")
  .option("--mcp", "start MCP server (http transport) alongside watcher", false)
  .option("--mcp-port <n>", "MCP HTTP port", "3338")
  .option("--mcp-path <path>", "MCP HTTP path", "/mcp")
  .option("--verbose", "verbose logs", false)
  .action(async (opts, command) => {
    const rootOpts = getRootOptions(command);
    const cwd = path.resolve(rootOpts?.cwd ?? process.cwd());

    const config = await loadResolvedConfigForDev(cwd, rootOpts?.config);
    const watchPaths = collectWatchPaths(config, cwd);

    process.stdout.write("starting searchsocket dev watcher...\n");
    process.stdout.write(`watching:\n${watchPaths.map((entry) => `  - ${entry}`).join("\n")}\n`);

    const upstashUrl = config.upstash.url ?? process.env[config.upstash.urlEnv];
    const upstashToken = config.upstash.token ?? process.env[config.upstash.tokenEnv];
    const backendMissing = !upstashUrl || !upstashToken;

    if (backendMissing) {
      process.stdout.write(
        `Search backend not configured — set ${config.upstash.urlEnv} and ${config.upstash.tokenEnv} to enable indexing. Watching for file changes only.\n`
      );
    }

    let running = false;
    let pending = false;
    let timer: NodeJS.Timeout | null = null;

    const run = async (): Promise<void> => {
      if (backendMissing) {
        return;
      }

      if (running) {
        pending = true;
        return;
      }

      running = true;
      try {
        await runIndexCommand({
          cwd,
          configPath: rootOpts?.config,
          scope: opts.scope,
          changedOnly: true,
          force: false,
          dryRun: false,
          verbose: opts.verbose,
          json: false
        });
      } catch (error) {
        process.stderr.write(`index error: ${error instanceof Error ? error.message : String(error)}\n`);
      } finally {
        running = false;
        if (pending) {
          pending = false;
          await run();
        }
      }
    };

    await run();

    const watcher = chokidar.watch(watchPaths, {
      ignoreInitial: true
    });

    watcher.on("all", (event, changedPath) => {
      process.stdout.write(`detected ${event}: ${changedPath}\n`);

      if (timer) {
        clearTimeout(timer);
      }

      timer = setTimeout(() => {
        void run();
      }, 350);
    });

    if (opts.mcp) {
      void runMcpServer({
        cwd,
        configPath: rootOpts?.config,
        transport: "http",
        httpPort: parsePositiveInt(opts.mcpPort, "--mcp-port"),
        httpPath: opts.mcpPath
      });
    }

    let closePlayground: (() => Promise<void>) | undefined;

    if (opts.playground) {
      if (backendMissing) {
        process.stdout.write("playground disabled: search backend not configured\n");
      } else {
        void runPlaygroundServer({
          cwd,
          configPath: rootOpts?.config,
          config,
          port: parsePositiveInt(opts.playgroundPort, "--playground-port")
        }).then(({ port, close }) => {
          closePlayground = close;
          process.stdout.write(`playground available at http://127.0.0.1:${port}/_searchsocket\n`);
        }).catch((err) => {
          process.stderr.write(`playground error: ${err instanceof Error ? err.message : String(err)}\n`);
        });
      }
    }

    await new Promise<void>((resolve) => {
      process.on("SIGINT", () => {
        const cleanups = [watcher.close()];
        if (closePlayground) cleanups.push(closePlayground());
        void Promise.all(cleanups).then(() => resolve());
      });
    });
  });

program
  .command("clean")
  .description("Delete local state and optionally delete remote indexes (dry-run by default for remote)")
  .option("--scope <name>", "scope to delete remotely (defaults to the resolved scope)")
  .option("--remote", "delete remote indexes for a single scope", false)
  .option("--all-scopes", "delete every scope in the project (requires --confirm-project)", false)
  .option("--confirm-project <id>", "confirmation token for --all-scopes; must equal the project id")
  .option("--apply", "actually perform remote deletions", false)
  .option("--keep-local", "do not delete the local state directory", false)
  .action(async (opts, command) => {
    const rootOpts = getRootOptions(command);
    const cwd = path.resolve(rootOpts?.cwd ?? process.cwd());

    const config = await loadConfig({ cwd, configPath: rootOpts?.config });

    if (opts.allScopes && !opts.remote) {
      process.stderr.write("error: --all-scopes requires --remote\n");
      process.exitCode = EXIT_INVALID_USAGE;
      return;
    }

    if (!opts.keepLocal) {
      const statePath = path.join(cwd, config.state.dir);
      await fsp.rm(statePath, { recursive: true, force: true });
      process.stdout.write(`deleted local state directory: ${statePath}\n`);
    }

    if (!opts.remote) return;

    // --all-scopes is the only path that may touch scopes other than the one
    // named. Previously `clean --remote --scope foo` resolved the scope flag
    // and then dropped the entire project regardless.
    if (opts.allScopes) {
      if (opts.confirmProject !== config.project.id) {
        process.stderr.write(
          `error: --all-scopes deletes every scope in project "${config.project.id}". ` +
            `Re-run with --confirm-project ${config.project.id} to acknowledge.\n`
        );
        process.exitCode = EXIT_DESTRUCTIVE_REFUSED;
        return;
      }

      process.stdout.write(`plan: drop ALL scopes in project ${config.project.id}\n`);
      if (!opts.apply) {
        process.stdout.write("dry-run only. pass --apply to delete.\n");
        return;
      }

      const store = await createUpstashStore(config);
      await store.dropAllIndexes(config.project.id);
      process.stdout.write(`dropped all remote indexes for project ${config.project.id}\n`);
      return;
    }

    const scope = resolveScope(config, opts.scope);
    process.stdout.write(
      `plan: delete remote records for project ${scope.projectId}, scope ${scope.scopeName}\n`
    );
    if (!opts.apply) {
      process.stdout.write("dry-run only. pass --apply to delete.\n");
      return;
    }

    const store = await createUpstashStore(config);
    await store.deleteScope(scope);
    process.stdout.write(`deleted remote records for scope ${scope.scopeName}\n`);
  });

const migrate = program
  .command("migrate")
  .description("Index schema migration helpers");

migrate
  .command("cleanup-legacy")
  .description(
    "Delete records written under an older index schema (dry-run by default). " +
      "Run only after a successful reindex on the current schema."
  )
  .option("--apply", "actually delete the legacy records", false)
  .option("--confirm-project <id>", "confirmation token; must equal the project id")
  .action(async (opts, command) => {
    const rootOpts = getRootOptions(command.parent?.parent as Command);
    const cwd = path.resolve(rootOpts?.cwd ?? process.cwd());
    const config = await loadConfig({ cwd, configPath: rootOpts?.config });

    let store: UpstashSearchStore;
    let legacy: { pages: string[]; chunks: string[] };
    try {
      store = await createUpstashStore(config);
      legacy = await store.scanLegacyRecords(config.project.id);
    } catch (error) {
      process.stderr.write(
        `error: failed to scan for legacy records: ${error instanceof Error ? error.message : String(error)}\n`
      );
      process.exitCode = EXIT_BACKEND_UNAVAILABLE;
      return;
    }

    const total = legacy.pages.length + legacy.chunks.length;
    if (total === 0) {
      process.stdout.write(`no legacy records found for project ${config.project.id}\n`);
      return;
    }

    process.stdout.write(
      `legacy records in project ${config.project.id} (schema older than ${INDEX_SCHEMA_VERSION}):\n` +
        `  pages: ${legacy.pages.length}\n` +
        `  chunks: ${legacy.chunks.length}\n`
    );
    for (const id of [...legacy.pages, ...legacy.chunks].slice(0, 20)) {
      process.stdout.write(`  - ${id}\n`);
    }
    if (total > 20) process.stdout.write(`  ... and ${total - 20} more\n`);

    if (!opts.apply) {
      process.stdout.write(
        "dry-run only. Verify the current schema is fully indexed and searching correctly, " +
          `then re-run with --apply --confirm-project ${config.project.id}.\n`
      );
      return;
    }

    if (opts.confirmProject !== config.project.id) {
      process.stderr.write(
        `error: this permanently deletes ${total} record(s). ` +
          `Re-run with --confirm-project ${config.project.id} to acknowledge.\n`
      );
      process.exitCode = EXIT_DESTRUCTIVE_REFUSED;
      return;
    }

    const result = await store.deleteLegacyRecords(config.project.id, legacy);
    process.stdout.write(`deleted ${result.deleted} legacy record(s)\n`);
    if (result.skipped > 0) {
      process.stdout.write(
        `skipped ${result.skipped} record(s) that were no longer legacy at deletion time\n`
      );
    }
  });

program
  .command("prune")
  .description("List/delete stale scopes (dry-run by default)")
  .option("--apply", "apply deletions", false)
  .option("--scopes-file <path>", "file containing active scopes")
  .option("--older-than <duration>", "ttl cutoff like 30d")
  .option(
    "--match <mode>",
    "when both --scopes-file/git branches and --older-than are given: 'any' or 'all'",
    "all"
  )
  .option("--protect <names>", "comma-separated scopes that must never be pruned")
  .action(async (opts, command) => {
    const rootOpts = getRootOptions(command);
    const cwd = path.resolve(rootOpts?.cwd ?? process.cwd());

    const config = await loadConfig({ cwd, configPath: rootOpts?.config });
    const baseScope = resolveScope(config);

    let store: UpstashSearchStore;
    let scopes: ScopeInfo[];
    try {
      store = await createUpstashStore(config);
      scopes = await store.listScopes(config.project.id);
    } catch (error) {
      process.stderr.write(
        `error: failed to access Upstash Vector: ${error instanceof Error ? error.message : String(error)}\n`
      );
      process.exitCode = 1;
      return;
    }

    process.stdout.write(`using Upstash Vector\n`);

    if (opts.match !== "any" && opts.match !== "all") {
      process.stderr.write(`error: --match must be "any" or "all", got "${opts.match}"\n`);
      process.exitCode = EXIT_INVALID_USAGE;
      return;
    }

    // Scopes that must survive regardless of any rule: the scope this checkout
    // resolves to, the conventional production scope, and anything the caller
    // explicitly protected.
    const protectedScopes = new Set<string>(["main", baseScope.scopeName]);
    if (typeof opts.protect === "string") {
      for (const name of opts.protect.split(",").map((n: string) => n.trim()).filter(Boolean)) {
        protectedScopes.add(config.scope.sanitize ? sanitizeScopeName(name) : name);
      }
    }

    let keepScopes = new Set<string>();
    if (opts.scopesFile) {
      keepScopes = readScopesFromFile(path.resolve(cwd, opts.scopesFile));
      if (keepScopes.size === 0) {
        // An empty keep-list would mark every scope orphaned.
        process.stderr.write(
          `error: scopes file ${opts.scopesFile} listed no scopes. Refusing to treat every scope as orphaned.\n`
        );
        process.exitCode = EXIT_DESTRUCTIVE_REFUSED;
        return;
      }
    } else {
      const branches = readRemoteGitBranches(cwd);
      if (branches === null) {
        // Fail closed: the branch inventory could not be established, so every
        // scope would look orphaned.
        process.stderr.write(
          "error: could not establish a trustworthy remote branch list. " +
            "Refusing to prune. Use --scopes-file to supply the active scopes explicitly, " +
            "or check out with full history (actions/checkout with fetch-depth: 0).\n"
        );
        process.exitCode = EXIT_DESTRUCTIVE_REFUSED;
        return;
      }
      keepScopes = branches;
    }

    if (config.scope.sanitize) {
      keepScopes = new Set([...keepScopes].map(sanitizeScopeName));
    }

    let olderThanMs: number | undefined;
    if (opts.olderThan) {
      olderThanMs = parseDurationMs(opts.olderThan);
      if (!Number.isFinite(olderThanMs) || olderThanMs <= 0) {
        process.stderr.write(`error: could not parse --older-than "${opts.olderThan}"\n`);
        process.exitCode = EXIT_INVALID_USAGE;
        return;
      }
    }
    const now = Date.now();

    const { stale, skipped } = selectStaleScopes({
      scopes,
      keepScopes,
      protectedScopes,
      olderThanMs,
      matchMode: opts.match as PruneMatchMode,
      now
    });

    if (skipped.length > 0) {
      process.stdout.write(`skipped ${skipped.length} scope(s) with unusable timestamps:\n`);
      for (const entry of skipped) {
        process.stdout.write(`  - ${entry.scopeName}: ${entry.reason}\n`);
      }
    }

    if (stale.length === 0) {
      process.stdout.write("no stale scopes found\n");
      return;
    }

    process.stdout.write(`stale scopes (${stale.length}):\n`);
    for (const entry of stale) {
      process.stdout.write(`  - ${entry.scopeName} lastIndexedAt=${entry.lastIndexedAt}\n`);
    }

    if (!opts.apply) {
      process.stdout.write("dry-run only. pass --apply to delete these scopes.\n");
      return;
    }

    let deleted = 0;
    for (const entry of stale) {
      const scope: Scope = {
        projectId: config.project.id,
        scopeName: entry.scopeName,
        scopeId: `${config.project.id}:${entry.scopeName}`
      };

      try {
        await store.deleteScope(scope);
        deleted += 1;
      } catch (error) {
        process.stdout.write(
          `failed to delete scope ${entry.scopeName}: ${error instanceof Error ? error.message : String(error)}\n`
        );
      }
    }

    process.stdout.write(`deleted scopes: ${deleted}\n`);
    if (baseScope.scopeName === "main") {
      process.stdout.write("main scope retained\n");
    }
  });

program
  .command("doctor")
  .description("Validate config, env vars, provider connectivity, and local write access")
  .action(async (_opts, command) => {
    const rootOpts = getRootOptions(command);
    const cwd = path.resolve(rootOpts?.cwd ?? process.cwd());

    const checks: Array<{ name: string; ok: boolean; details?: string }> = [];

    let config: ResolvedSearchSocketConfig | null = null;
    try {
      config = await loadConfig({ cwd, configPath: rootOpts?.config });
      checks.push({ name: "config parse", ok: true });
    } catch (error) {
      checks.push({
        name: "config parse",
        ok: false,
        details: error instanceof Error ? error.message : "unknown error"
      });
    }

    if (config) {
      const upstashUrl = config.upstash.url ?? process.env[config.upstash.urlEnv];
      const upstashToken = config.upstash.token ?? process.env[config.upstash.tokenEnv];
      checks.push({
        name: `env ${config.upstash.urlEnv}`,
        ok: Boolean(upstashUrl),
        details: upstashUrl ? undefined : "missing"
      });
      checks.push({
        name: `env ${config.upstash.tokenEnv}`,
        ok: Boolean(upstashToken),
        details: upstashToken ? undefined : "missing"
      });

      // Validate source mode prerequisites
      if (config.source.mode === "static-output") {
        const outputDir = path.resolve(cwd, config.source.staticOutputDir);
        const exists = fs.existsSync(outputDir);
        checks.push({
          name: "source: static output dir",
          ok: exists,
          details: exists ? outputDir : `${outputDir} not found (run your build first)`
        });
      } else if (config.source.mode === "build") {
        const buildConfig = config.source.build;
        if (buildConfig) {
          const manifestPath = path.resolve(cwd, buildConfig.outputDir, "server", "manifest-full.js");
          const manifestExists = fs.existsSync(manifestPath);
          checks.push({
            name: "source: build manifest",
            ok: manifestExists,
            details: manifestExists
              ? manifestPath
              : `${manifestPath} not found (run \`vite build\` first)`
          });

          const viteBin = path.resolve(cwd, "node_modules", ".bin", "vite");
          const viteExists = fs.existsSync(viteBin);
          checks.push({
            name: "source: vite binary",
            ok: viteExists,
            details: viteExists ? viteBin : `${viteBin} not found (install vite)`
          });
        } else {
          checks.push({
            name: "source: build config",
            ok: false,
            details: "source.build config missing"
          });
        }
      } else if (config.source.mode === "content-files") {
        const contentConfig = config.source.contentFiles;
        if (contentConfig) {
          const fg = await import("fast-glob");
          const baseDir = path.resolve(cwd, contentConfig.baseDir);
          const files = await fg.default(contentConfig.globs, { cwd: baseDir, onlyFiles: true });
          checks.push({
            name: "source: content files",
            ok: files.length > 0,
            details: files.length > 0
              ? `${files.length} files matched`
              : `no files matched globs ${contentConfig.globs.join(", ")} in ${baseDir}`
          });
        } else {
          checks.push({
            name: "source: content files",
            ok: false,
            details: "source.contentFiles config missing"
          });
        }
      }

      let store: UpstashSearchStore | null = null;
      try {
        store = await createUpstashStore(config);
        const health = await store.health();
        checks.push({
          name: "upstash search connectivity",
          ok: health.ok,
          details: health.details
        });
      } catch (error) {
        checks.push({
          name: "upstash search connectivity",
          ok: false,
          details: error instanceof Error ? error.message : "unknown error"
        });
      }

      try {
        const scope = resolveScope(config);
        const { statePath } = ensureStateDirs(cwd, config.state.dir, scope);
        const testPath = path.join(statePath, ".write-test");
        await fsp.writeFile(testPath, "ok\n", "utf8");
        await fsp.rm(testPath, { force: true });
        checks.push({ name: "state directory writable", ok: true });
      } catch (error) {
        checks.push({
          name: "state directory writable",
          ok: false,
          details: error instanceof Error ? error.message : "unknown error"
        });
      }
    }

    let hasFailure = false;
    for (const check of checks) {
      process.stdout.write(`${check.ok ? "PASS" : "FAIL"} ${check.name}`);
      if (check.details) {
        process.stdout.write(` (${check.details})`);
      }
      process.stdout.write("\n");

      if (!check.ok) {
        hasFailure = true;
      }
    }

    if (hasFailure) {
      process.exitCode = 1;
    }
  });

program
  .command("mcp")
  .description("Run SearchSocket MCP server")
  .option("--transport <transport>", "stdio|http", "stdio")
  .option("--port <n>", "HTTP port", "3338")
  .option("--path <path>", "HTTP path", "/mcp")
  .addOption(new Option("--access <mode>", "access mode").choices(["public", "private"]))
  .option("--api-key <key>", "API key for public access mode")
  .action(async (opts, command) => {
    const rootOpts = getRootOptions(command);
    const cwd = path.resolve(rootOpts?.cwd ?? process.cwd());

    await runMcpServer({
      cwd,
      configPath: rootOpts?.config,
      transport: opts.transport,
      httpPort: parsePositiveInt(opts.port, "--port"),
      httpPath: opts.path,
      access: opts.access,
      apiKey: opts.apiKey
    });
  });

program
  .command("search")
  .description("Quick CLI search against Upstash Search")
  .requiredOption("--q <query>", "search query")
  .option("--scope <name>", "scope override")
  .option("--top-k <n>", "top K results", "10")
  .option("--path-prefix <prefix>", "path prefix filter")
  .action(async (opts, command) => {
    const rootOpts = getRootOptions(command);
    const cwd = path.resolve(rootOpts?.cwd ?? process.cwd());

    const engine = await SearchEngine.create({
      cwd,
      configPath: rootOpts?.config
    });

    const result = await engine.search({
      q: opts.q,
      scope: opts.scope,
      topK: parsePositiveInt(opts.topK, "--top-k"),
      pathPrefix: opts.pathPrefix
    });

    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  });

program
  .command("test")
  .description("Run search quality assertions against the live index")
  .option("--file <path>", "path to test file", "searchsocket.test.json")
  .option("--scope <name>", "scope override")
  .option("--top-k <n>", "results per query", "10")
  .action(async (opts, command) => {
    const rootOpts = getRootOptions(command);
    const cwd = path.resolve(rootOpts?.cwd ?? process.cwd());
    const topK = parsePositiveInt(opts.topK, "--top-k");

    const filePath = path.resolve(cwd, opts.file);
    let rawContent: string;
    try {
      rawContent = await fsp.readFile(filePath, "utf8");
    } catch {
      process.stderr.write(`error: test file not found: ${filePath}\n`);
      process.exitCode = 1;
      return;
    }

    let rawJson: unknown;
    try {
      rawJson = JSON.parse(rawContent);
    } catch {
      process.stderr.write(`error: invalid JSON in ${filePath}\n`);
      process.exitCode = 1;
      return;
    }

    const parsed = testFileSchema.safeParse(rawJson);
    if (!parsed.success) {
      process.stderr.write(`error: invalid test file: ${parsed.error.issues[0]?.message ?? "unknown error"}\n`);
      process.exitCode = 1;
      return;
    }

    const testCases = parsed.data;

    const engine = await SearchEngine.create({
      cwd,
      configPath: rootOpts?.config
    });

    let passed = 0;
    let failed = 0;
    const mrrData: Array<{ results: SearchResult[]; relevant: string[] }> = [];

    for (const tc of testCases) {
      let results: SearchResult[];
      try {
        const response = await engine.search({
          q: tc.query,
          topK,
          scope: opts.scope
        });
        results = response.results;
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        process.stdout.write(`FAIL "${tc.query}" → search error: ${msg}\n`);
        failed++;
        continue;
      }

      if (tc.expect.topResult !== undefined) {
        const expectedUrl = tc.expect.topResult;
        const rank = results.findIndex((r) => r.url === expectedUrl) + 1;

        mrrData.push({ results, relevant: [expectedUrl] });

        if (rank === 1) {
          process.stdout.write(`PASS "${tc.query}" → ${expectedUrl} at rank 1\n`);
          passed++;
        } else {
          const detail = rank === 0 ? "not found" : `got rank ${rank}`;
          process.stdout.write(`FAIL "${tc.query}" → expected ${expectedUrl} at rank 1, ${detail}\n`);
          failed++;
        }
      }

      if (tc.expect.inTop5 !== undefined) {
        const expectedUrls = tc.expect.inTop5;
        const top5Urls = results.slice(0, 5).map((r) => r.url);
        const missing = expectedUrls.filter((url) => !top5Urls.includes(url));

        mrrData.push({ results, relevant: expectedUrls });

        if (missing.length === 0) {
          process.stdout.write(`PASS "${tc.query}" → all expected URLs in top 5\n`);
          passed++;
        } else {
          const missingDetail = missing
            .map((url) => {
              const rank = results.findIndex((r) => r.url === url) + 1;
              return rank === 0 ? `${url} (not found)` : `${url} (rank ${rank})`;
            })
            .join(", ");
          process.stdout.write(`FAIL "${tc.query}" → missing from top 5: ${missingDetail}\n`);
          failed++;
        }
      }

      if (tc.expect.maxResults !== undefined) {
        const max = tc.expect.maxResults;
        const actual = results.length;

        if (actual <= max) {
          process.stdout.write(`PASS "${tc.query}" → ${actual} results (max ${max})\n`);
          passed++;
        } else {
          process.stdout.write(`FAIL "${tc.query}" → expected at most ${max} results, got ${actual}\n`);
          failed++;
        }
      }
    }

    const total = passed + failed;
    process.stdout.write(`\nresults: ${passed} passed, ${failed} failed of ${total} assertions\n`);

    if (mrrData.length > 0) {
      const mrrValue = mrr(mrrData);
      process.stdout.write(`MRR: ${mrrValue.toFixed(4)}\n`);
    }

    process.stdout.write(`pass rate: ${total > 0 ? ((passed / total) * 100).toFixed(1) : "0.0"}%\n`);

    if (failed > 0) {
      process.exitCode = 1;
    }
  });

program
  .command("add <component>")
  .description("Copy a Svelte 5 search component template into your project")
  .option("--dir <path>", "output directory", "src/lib/components/search")
  .option("--overwrite", "overwrite existing files", false)
  .action(async (component: string, opts: { dir: string; overwrite: boolean }, command) => {
    const root = getRootOptions(command).cwd ?? process.cwd();
    const cwd = path.resolve(root);

    if (!isValidComponent(component)) {
      const available = listAvailableComponents();
      process.stderr.write(`unknown component: ${component}\n`);
      process.stderr.write(`available components: ${available.join(", ")}\n`);
      process.exit(1);
    }

    const targetDir = path.resolve(cwd, opts.dir);
    const result = await copyComponent(component, targetDir, { overwrite: opts.overwrite });

    for (const filePath of result.written) {
      process.stdout.write(`created: ${path.relative(cwd, filePath)}\n`);
    }
    for (const filePath of result.skipped) {
      process.stdout.write(`skipped (exists): ${path.relative(cwd, filePath)}\n`);
    }

    const firstWritten = result.written[0];
    if (firstWritten) {
      process.stdout.write(`\nUsage:\n`);
      const fileName = path.basename(firstWritten, ".svelte");
      process.stdout.write(`  import ${fileName} from "${path.relative(cwd, firstWritten).replace(/\\/g, "/")}";\n`);
    }
  });

async function main(): Promise<void> {
  dotenvConfig({ path: path.resolve(process.cwd(), ".env") });
  await program.parseAsync(process.argv);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`searchsocket error: ${message}\n`);
  process.exit(1);
});
