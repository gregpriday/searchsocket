import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compile, preprocess } from "svelte/compiler";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";
import { listAvailableComponents } from "../src/add-helpers";

const templatesDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../src/templates"
);

function svelteFilesIn(dir: string): string[] {
  return fs
    .readdirSync(dir)
    .filter((file) => file.endsWith(".svelte"))
    .map((file) => path.join(dir, file));
}

const componentFiles = listAvailableComponents().flatMap((component) =>
  svelteFilesIn(path.join(templatesDir, component))
);

describe("generated stylesheet", () => {
  const stylesheets = listAvailableComponents().map((component) => [
    component,
    path.join(templatesDir, component, "search-theme.css"),
  ]);

  it.each(stylesheets)("%s ships a stylesheet that parses", (_component, file) => {
    const css = fs.readFileSync(file, "utf8");

    // Nothing else parses this file: vitest stubs CSS imports and Vite's
    // pipeline is lenient, so a syntax error would otherwise reach users.
    // Svelte's CSS parser is strict and is already a direct dependency.
    expect(() => compile(`<div></div><style>${css}</style>`, { filename: file })).not.toThrow();
  });

  it("defines the light palette and every theme mode", () => {
    const css = fs.readFileSync(stylesheets[0]![1]!, "utf8");

    expect(css).toContain("--ss-search-surface: #");
    for (const mode of ["light", "dark", "system", "inherit"]) {
      expect(css, mode).toContain(`.ss-search[data-theme="${mode}"]`);
    }
  });
});

describe("generated templates compile", () => {
  it("covers every shipped component", () => {
    expect(componentFiles.length).toBeGreaterThanOrEqual(4);
  });

  // The mounted tests already prove client compilation. Server compilation is
  // what a SvelteKit app does on every request and is otherwise untested — a
  // rune or DOM reference that only works in the browser would ship silently.
  it.each(componentFiles.map((file) => [path.relative(templatesDir, file), file]))(
    "%s compiles for the server",
    async (_name, file) => {
      const source = fs.readFileSync(file, "utf8");
      const processed = await preprocess(source, vitePreprocess(), { filename: file });

      const result = compile(processed.code, { filename: file, generate: "server" });

      const blocking = result.warnings.filter(
        (warning) => warning.code?.startsWith("a11y") || warning.code === "state_referenced_locally"
      );
      expect(blocking.map((warning) => `${warning.code}: ${warning.message}`)).toEqual([]);
      expect(result.js.code).toBeTruthy();
    }
  );

  it("emits no accessibility warnings for the browser build either", async () => {
    for (const file of componentFiles) {
      const source = fs.readFileSync(file, "utf8");
      const processed = await preprocess(source, vitePreprocess(), { filename: file });
      const result = compile(processed.code, { filename: file, generate: "client" });

      const a11y = result.warnings.filter((warning) => warning.code?.startsWith("a11y"));
      expect(a11y.map((warning) => `${path.basename(file)} ${warning.code}`)).toEqual([]);
    }
  });
});
