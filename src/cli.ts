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
import { ensureMcpJson } from "./init-helpers";
import { readAnalyticsLog, computeReport } from "./analytics/report";
import { copyComponent, isValidComponent, listAvailableComponents } from "./add-helpers";

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
    ".searchsocket/registry.json",
    ".searchsocket/analytics.jsonl"
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

function readRemoteGitBranches(cwd: string): Set<string> {
  try {
    const output = execSync("git branch -r --format='%(refname:short)'", {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });

    const scopes = output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => line.replace(/^origin\//, ""));

    if (scopes.length <= 1) {
      process.stdout.write(
        "warning: git branch -r returned 1 or fewer branches. " +
          "If running in CI, ensure the checkout step uses fetch-depth: 0 " +
          "to avoid accidentally pruning active branch scopes.\n"
      );
    }

    return new Set(scopes);
  } catch {
    return new Set();
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
}): Promise<void> {
  const logger = new Logger({
    quiet: opts.quiet,
    verbose: opts.verbose,
    json: opts.json
  });

  const pipeline = await IndexPipeline.create({
    cwd: opts.cwd,
    configPath: opts.configPath,
    logger
  });

  const stats = await pipeline.run({
    scopeOverride: opts.scope,
    changedOnly: opts.changedOnly,
    force: opts.force,
    dryRun: opts.dryRun,
    sourceOverride: opts.source,
    maxPages: opts.maxPages,
    maxChunks: opts.maxChunks,
    verbose: opts.verbose
  });

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(stats, null, 2)}\n`);
    return;
  }

  if (!opts.quiet) {
    printIndexSummary(stats);
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
  .description("Create searchsocket.config.ts and .searchsocket state directory")
  .action(async (_opts, command) => {
    const root = getRootOptions(command).cwd ?? process.cwd();
    const cwd = path.resolve(root);

    const configPath = writeMinimalConfig(cwd);
    const stateDir = ensureStateDir(cwd);
    ensureGitignore(cwd);
    ensureMcpJson(cwd);

    process.stdout.write(`created/verified config: ${configPath}\n`);
    process.stdout.write(`created/verified state dir: ${stateDir}\n`);
    process.stdout.write("created/verified .mcp.json (MCP server config for Claude Code)\n\n");

    process.stdout.write("SvelteKit hook snippet:\n\n");
    process.stdout.write('import { searchsocketHandle } from "searchsocket/sveltekit";\n\n');
    process.stdout.write("export const handle = searchsocketHandle();\n\n");

    process.stdout.write("Optional build-triggered indexing plugin:\n\n");
    process.stdout.write('import { searchsocketVitePlugin } from "searchsocket/sveltekit";\n\n');
    process.stdout.write("// svelte.config.js / vite plugins:\n");
    process.stdout.write("// searchsocketVitePlugin({ enabled: true, changedOnly: true })\n");
    process.stdout.write("// or env-driven: SEARCHSOCKET_AUTO_INDEX=1 pnpm build\n");
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
      json: opts.json
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
    process.stdout.write(`backend: upstash-search\n`);
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
  .description("Delete local state and optionally delete remote indexes for a scope")
  .option("--scope <name>", "scope override")
  .option("--remote", "delete remote scope indexes", false)
  .action(async (opts, command) => {
    const rootOpts = getRootOptions(command);
    const cwd = path.resolve(rootOpts?.cwd ?? process.cwd());

    const config = await loadConfig({ cwd, configPath: rootOpts?.config });

    const statePath = path.join(cwd, config.state.dir);
    await fsp.rm(statePath, { recursive: true, force: true });
    process.stdout.write(`deleted local state directory: ${statePath}\n`);

    if (opts.remote) {
      const store = await createUpstashStore(config);
      await store.dropAllIndexes(config.project.id);
      process.stdout.write(`dropped all remote indexes for project ${config.project.id}\n`);
    }
  });

program
  .command("prune")
  .description("List/delete stale scopes (dry-run by default)")
  .option("--apply", "apply deletions", false)
  .option("--scopes-file <path>", "file containing active scopes")
  .option("--older-than <duration>", "ttl cutoff like 30d")
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
        `error: failed to access Upstash Search: ${error instanceof Error ? error.message : String(error)}\n`
      );
      process.exitCode = 1;
      return;
    }

    process.stdout.write(`using Upstash Search\n`);

    let keepScopes = new Set<string>();
    if (opts.scopesFile) {
      keepScopes = readScopesFromFile(path.resolve(cwd, opts.scopesFile));
    } else {
      keepScopes = readRemoteGitBranches(cwd);
    }

    if (config.scope.sanitize && keepScopes.size > 0) {
      keepScopes = new Set([...keepScopes].map(sanitizeScopeName));
    }

    const olderThanMs = opts.olderThan ? parseDurationMs(opts.olderThan) : undefined;
    const now = Date.now();

    const stale = scopes.filter((entry) => {
      if (entry.scopeName === "main") {
        return false;
      }

      let staleByList = false;
      if (keepScopes.size > 0) {
        staleByList = !keepScopes.has(entry.scopeName);
      }

      let staleByTtl = false;
      if (olderThanMs && entry.lastIndexedAt !== "unknown") {
        staleByTtl = now - Date.parse(entry.lastIndexedAt) > olderThanMs;
      }

      if (keepScopes.size > 0 && olderThanMs) {
        return staleByList || staleByTtl;
      }

      if (keepScopes.size > 0) {
        return staleByList;
      }

      if (olderThanMs) {
        return staleByTtl;
      }

      return false;
    });

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
  .command("report")
  .description("Show search analytics report")
  .option("--json", "emit report as JSON", false)
  .action(async (opts, command) => {
    const rootOpts = getRootOptions(command);
    const cwd = path.resolve(rootOpts?.cwd ?? process.cwd());

    const config = await loadConfig({ cwd, configPath: rootOpts?.config, allowMissing: true });
    const logPath = path.join(cwd, config.state.dir, "analytics.jsonl");

    if (!fs.existsSync(logPath)) {
      process.stdout.write("No analytics data found. Enable analytics in your config and run some searches first.\n");
      return;
    }

    const entries = [];
    for await (const entry of readAnalyticsLog(logPath)) {
      entries.push(entry);
    }

    if (entries.length === 0) {
      process.stdout.write("Analytics log is empty.\n");
      return;
    }

    const report = computeReport(entries);

    if (opts.json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      return;
    }

    process.stdout.write("TOP QUERIES\n");
    for (let i = 0; i < report.topQueries.length; i++) {
      const { q, count } = report.topQueries[i]!;
      process.stdout.write(`  ${i + 1}. "${q}" — ${count} searches\n`);
    }

    process.stdout.write("\nZERO-RESULT QUERIES\n");
    if (report.zeroResultQueries.length === 0) {
      process.stdout.write("  (none)\n");
    } else {
      for (let i = 0; i < report.zeroResultQueries.length; i++) {
        const { q, count } = report.zeroResultQueries[i]!;
        process.stdout.write(`  ${i + 1}. "${q}" — ${count} searches\n`);
      }
    }

    process.stdout.write("\nDAILY VOLUME\n");
    for (const { date, count } of report.dailyVolume) {
      process.stdout.write(`  ${date}  ${count} searches\n`);
    }

    process.stdout.write("\nLATENCY (ms)\n");
    process.stdout.write(`  p50: ${report.latency.p50}   p95: ${report.latency.p95}   p99: ${report.latency.p99}   (from ${report.latency.count} events)\n`);
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
