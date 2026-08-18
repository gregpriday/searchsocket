import { cpSync, readFileSync } from "node:fs";
import { defineConfig } from "tsup";

// Injected so the MCP server can report the real package version instead of a
// hardcoded constant that silently drifts from package.json.
const { version } = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
const define = { __SEARCHSOCKET_VERSION__: JSON.stringify(version) };

export default defineConfig([
  {
    entry: {
      index: "src/index.ts",
      sveltekit: "src/sveltekit.ts",
      client: "src/client.ts",
      scroll: "src/scroll.ts"
    },
    format: ["esm", "cjs"],
    dts: true,
    outDir: "dist",
    sourcemap: true,
    clean: true,
    target: "node20",
    splitting: false,
    shims: false,
    treeshake: true,
    define,
    // Bundle turndown and its CJS-only dependency @mixmark-io/domino so that
    // consuming bundlers (e.g. SvelteKit/Vite) never encounter the bare
    // `require("@mixmark-io/domino")` call in turndown's ES module.
    noExternal: ["turndown", "@mixmark-io/domino", "turndown-plugin-gfm"]
  },
  {
    entry: {
      cli: "src/cli.ts"
    },
    format: ["esm"],
    dts: false,
    outDir: "dist",
    sourcemap: true,
    clean: false,
    target: "node20",
    define,
    banner: {
      js: "#!/usr/bin/env node"
    },
    esbuildOptions(options) {
      options.loader = { ...options.loader, ".html": "text" };
    },
    onSuccess() {
      cpSync("src/templates", "dist/templates", { recursive: true });
    }
  }
]);
