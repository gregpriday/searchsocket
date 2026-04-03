import { defineConfig } from "vitest/config";
import { svelte } from "@sveltejs/vite-plugin-svelte";

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
        test: {
          name: "svelte",
          environment: "jsdom",
          include: ["tests/svelte/**/*.test.ts"]
        }
      }
    ]
  }
});
