import { defineConfig } from "vitest/config";
import { svelte } from "@sveltejs/vite-plugin-svelte";

export default defineConfig({
  plugins: [
    svelte({ hot: false })
  ],
  test: {
    projects: [
      {
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
