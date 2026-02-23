import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: {
      index: "src/index.ts",
      sveltekit: "src/sveltekit.ts",
      client: "src/client.ts"
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
    banner: {
      js: "#!/usr/bin/env node"
    }
  }
]);
