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
    treeshake: true
  },
  {
    entry: {
      cli: "src/cli.ts"
    },
    format: ["cjs"],
    dts: false,
    outDir: "dist",
    sourcemap: true,
    clean: false,
    target: "node20",
    outExtension() {
      return { js: ".cjs" };
    },
    banner: {
      js: "#!/usr/bin/env node"
    }
  }
]);
