import { cpSync, readFileSync } from "node:fs";
import { defineConfig } from "tsup";

// Injected so the MCP server can report the real package version instead of a
// hardcoded constant that silently drifts from package.json.
const { version } = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
const define = { __SEARCHSOCKET_VERSION__: JSON.stringify(version) };

// Source maps are excluded from the published tarball (see the `files` field in
// package.json — they tripled the unpacked size), so emitting them here only
// leaves every consumer's bundler chasing a `sourceMappingURL` that ships to
// nobody. Vite logs "Failed to load source map" for each entry on every dev
// start. Don't generate what we don't publish.
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
    sourcemap: false,
    clean: true,
    target: "node22",
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
    sourcemap: false,
    clean: false,
    target: "node22",
    define,
    banner: {
      js: "#!/usr/bin/env node"
    },
    esbuildOptions(options) {
      options.loader = { ...options.loader, ".html": "text" };
    },
    onSuccess() {
      // `_shared` is the authoring source for the per-component support files;
      // the copies inside each template directory are what actually ships.
      cpSync("src/templates", "dist/templates", {
        recursive: true,
        filter: (source) => !/[\\/]templates[\\/]_shared([\\/]|$)/.test(source)
      });
    }
  }
]);
