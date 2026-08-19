import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { svelte } from "@sveltejs/vite-plugin-svelte";

const resolvePath = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));

// The generated templates import the package by its public specifiers and, for
// the interactive ones, `$app/navigation`. Aliasing both lets the real template
// files be mounted in tests instead of only string-matched.
const templateAliases = {
  "searchsocket/svelte": resolvePath("./src/svelte/index.svelte.ts"),
  "searchsocket/client": resolvePath("./src/client.ts"),
  searchsocket: resolvePath("./src/index.ts"),
  "$app/navigation": resolvePath("./tests/helpers/app-navigation.ts")
};

export default defineConfig({
  plugins: [
    svelte({ hot: false })
  ],
  test: {
    projects: [
      {
        plugins: [
          {
            name: "html-raw",
            transform(_code: string, id: string) {
              if (id.endsWith(".html")) {
                return { code: `export default ${JSON.stringify(_code)};`, map: null };
              }
            }
          }
        ],
        test: {
          name: "node",
          environment: "node",
          include: ["tests/**/*.test.ts"],
          exclude: ["tests/svelte/**"]
        }
      },
      {
        plugins: [svelte({ hot: false })],
        // jsdom needs Svelte's browser build; without the condition, `mount()`
        // resolves to the server entry and throws.
        resolve: { alias: templateAliases, conditions: ["browser"] },
        test: {
          name: "svelte",
          environment: "jsdom",
          include: ["tests/svelte/**/*.test.ts"]
        }
      }
    ]
  }
});
