import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  listAvailableComponents,
  isValidComponent,
  resolveTemplateDir,
  componentEntryFile,
  copyComponent,
  type ComponentName,
} from "../src/add-helpers";
import { syncTemplates, SHARED_TEMPLATE_FILES } from "../scripts/sync-templates.mjs";

const SUPPORT_FILES = ["SearchResultRow.svelte", "search-ui.ts", "search-theme.css"];

describe("add-helpers", () => {
  describe("listAvailableComponents", () => {
    it("returns the available component names", () => {
      expect(listAvailableComponents()).toEqual([
        "search-dialog",
        "search-input",
        "search-results",
        "search-trigger",
      ]);
    });

    it("does not expose the shared authoring directory as a component", () => {
      expect(listAvailableComponents()).not.toContain("_shared");
      expect(isValidComponent("_shared")).toBe(false);
    });
  });

  describe("isValidComponent", () => {
    it("returns true for valid component names", () => {
      expect(isValidComponent("search-dialog")).toBe(true);
      expect(isValidComponent("search-input")).toBe(true);
      expect(isValidComponent("search-results")).toBe(true);
      expect(isValidComponent("search-trigger")).toBe(true);
    });

    it("returns false for invalid component names", () => {
      expect(isValidComponent("unknown")).toBe(false);
      expect(isValidComponent("Search-Dialog")).toBe(false);
      expect(isValidComponent("")).toBe(false);
    });

    it("is not fooled by inherited object properties", () => {
      expect(isValidComponent("toString")).toBe(false);
      expect(isValidComponent("constructor")).toBe(false);
    });
  });

  describe("resolveTemplateDir", () => {
    it("returns a path ending with templates", () => {
      expect(resolveTemplateDir()).toMatch(/templates$/);
    });
  });

  describe("componentEntryFile", () => {
    it("names the component a consumer imports", () => {
      expect(componentEntryFile("search-dialog")).toBe("SearchDialog.svelte");
      expect(componentEntryFile("search-input")).toBe("SearchInput.svelte");
      expect(componentEntryFile("search-results")).toBe("SearchResults.svelte");
      expect(componentEntryFile("search-trigger")).toBe("SearchTrigger.svelte");
    });
  });

  describe("copyComponent", () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "ss-add-test-"));
    });

    afterEach(async () => {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    });

    it("copies the entry component plus its support files", async () => {
      const targetDir = path.join(tmpDir, "components", "search");
      const result = await copyComponent("search-dialog", targetDir);

      const names = result.written.map((file) => path.basename(file)).sort();
      expect(names).toEqual(["SearchDialog.svelte", ...SUPPORT_FILES].sort());
      expect(result.skipped).toHaveLength(0);

      for (const file of result.written) {
        expect(fs.existsSync(file)).toBe(true);
      }
    });

    it("reports the entry component rather than the first file written", async () => {
      const result = await copyComponent("search-dialog", tmpDir);

      expect(result.entry).toBe(path.join(tmpDir, "SearchDialog.svelte"));
      // The alphabetically-first written file is a support file, so the entry
      // cannot be inferred from ordering.
      expect(path.basename(result.written[0]!)).not.toBe("SearchDialog.svelte");
    });

    it("copies .ts and .css assets, not only .svelte files", async () => {
      const result = await copyComponent("search-input", tmpDir);
      const extensions = new Set(result.written.map((file) => path.extname(file)));
      expect(extensions).toEqual(new Set([".svelte", ".ts", ".css"]));
    });

    it("copies each component", async () => {
      for (const name of listAvailableComponents()) {
        const dir = path.join(tmpDir, name);
        const result = await copyComponent(name as ComponentName, dir);
        expect(fs.existsSync(result.entry)).toBe(true);
        expect(result.written.length).toBeGreaterThan(1);
      }
    });

    it("gives the trigger the theme assets but not the result row", async () => {
      const result = await copyComponent("search-trigger", tmpDir);
      const names = result.written.map((file) => path.basename(file)).sort();
      expect(names).toEqual(["SearchTrigger.svelte", "search-theme.css", "search-ui.ts"]);
    });

    it("refuses to write through a symlinked destination", async () => {
      const outside = path.join(tmpDir, "outside.ts");
      await fsp.writeFile(outside, "do not touch", "utf8");

      const targetDir = path.join(tmpDir, "out");
      await fsp.mkdir(targetDir, { recursive: true });
      await fsp.symlink(outside, path.join(targetDir, "search-ui.ts"));

      await expect(
        copyComponent("search-dialog", targetDir, { overwrite: true })
      ).rejects.toThrow(/symlink/);
      expect(await fsp.readFile(outside, "utf8")).toBe("do not touch");
    });

    it("refuses to overwrite a directory standing in for a file", async () => {
      const targetDir = path.join(tmpDir, "out");
      await fsp.mkdir(path.join(targetDir, "SearchDialog.svelte"), { recursive: true });

      await expect(copyComponent("search-dialog", targetDir)).rejects.toThrow(/directory/);
    });

    it("reports whether the entry was written or kept", async () => {
      const first = await copyComponent("search-dialog", tmpDir);
      expect(first.entryWritten).toBe(true);

      const second = await copyComponent("search-dialog", tmpDir);
      expect(second.entryWritten).toBe(false);
      expect(second.entry).toBe(first.entry);

      const forced = await copyComponent("search-dialog", tmpDir, { overwrite: true });
      expect(forced.entryWritten).toBe(true);
    });

    it("skips existing files without --overwrite, file by file", async () => {
      await copyComponent("search-dialog", tmpDir);
      await fsp.rm(path.join(tmpDir, "search-ui.ts"));

      const result = await copyComponent("search-dialog", tmpDir);
      expect(result.written.map((file) => path.basename(file))).toEqual(["search-ui.ts"]);
      expect(result.skipped).toHaveLength(SUPPORT_FILES.length);
      // The entry is still reported even though it was skipped.
      expect(result.entry).toBe(path.join(tmpDir, "SearchDialog.svelte"));
    });

    it("never clobbers a user's own file of the same name", async () => {
      await fsp.writeFile(path.join(tmpDir, "search-ui.ts"), "mine", "utf8");
      const result = await copyComponent("search-dialog", tmpDir);

      expect(await fsp.readFile(path.join(tmpDir, "search-ui.ts"), "utf8")).toBe("mine");
      expect(result.skipped.map((file) => path.basename(file))).toEqual(["search-ui.ts"]);
    });

    it("overwrites every file with the overwrite option", async () => {
      await copyComponent("search-dialog", tmpDir);
      await fsp.writeFile(path.join(tmpDir, "SearchDialog.svelte"), "modified", "utf8");
      await fsp.writeFile(path.join(tmpDir, "search-theme.css"), "modified", "utf8");

      const result = await copyComponent("search-dialog", tmpDir, { overwrite: true });
      expect(result.skipped).toHaveLength(0);
      expect(await fsp.readFile(path.join(tmpDir, "SearchDialog.svelte"), "utf8")).toContain(
        "createSearch"
      );
      expect(await fsp.readFile(path.join(tmpDir, "search-theme.css"), "utf8")).toContain(
        "--ss-search-surface"
      );
    });

    it("creates target directory recursively", async () => {
      const deepDir = path.join(tmpDir, "a", "b", "c");
      const result = await copyComponent("search-dialog", deepDir);

      expect(result.written.length).toBeGreaterThan(0);
      expect(fs.existsSync(deepDir)).toBe(true);
    });

    it("rejects an unknown component instead of resolving a path from it", async () => {
      await expect(
        copyComponent("../../etc" as ComponentName, tmpDir)
      ).rejects.toThrow(/unknown component/);
    });

    it("writes nothing outside the target directory", async () => {
      const targetDir = path.join(tmpDir, "out");
      await copyComponent("search-dialog", targetDir);

      const stray = await fsp.readdir(tmpDir);
      expect(stray).toEqual(["out"]);
    });
  });

  describe("template content validation", () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "ss-add-validate-"));
    });

    afterEach(async () => {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    });

    async function copyAll(name: ComponentName): Promise<Map<string, string>> {
      const dir = path.join(tmpDir, name);
      const result = await copyComponent(name, dir);
      const contents = new Map<string, string>();
      for (const file of result.written) {
        contents.set(path.basename(file), await fsp.readFile(file, "utf8"));
      }
      return contents;
    }

    it("templates use Svelte 5 syntax, not legacy", async () => {
      for (const name of listAvailableComponents()) {
        const files = await copyAll(name as ComponentName);

        for (const [fileName, content] of files) {
          if (!fileName.endsWith(".svelte")) continue;

          expect(content, fileName).toContain("$props()");
          expect(content, fileName).not.toContain("on:click");
          expect(content, fileName).not.toContain("on:keydown");
          expect(content, fileName).not.toContain("export let ");
          expect(content, fileName).not.toMatch(/{@html\s/);
        }
      }
    });

    it("no template reaches back into node_modules for its support files", async () => {
      for (const name of listAvailableComponents()) {
        for (const [fileName, content] of await copyAll(name as ComponentName)) {
          expect(content, fileName).not.toContain("searchsocket/dist/templates");
          expect(content, fileName).not.toMatch(/from\s+["']\.\.\//);
        }
      }
    });

    it("search-dialog has ARIA combobox and dialog attributes", async () => {
      const files = await copyAll("search-dialog");
      const content = files.get("SearchDialog.svelte")!;

      expect(content).toContain('role="combobox"');
      expect(content).toContain('role="listbox"');
      expect(content).toContain('role="option"');
      expect(content).toContain("aria-activedescendant");
      expect(content).toContain("aria-expanded");
      expect(content).toContain('aria-haspopup="listbox"');
      expect(content).toContain('aria-autocomplete="list"');
      expect(content).toContain('role="dialog"');
      expect(content).toContain('aria-modal="true"');
    });

    it("search-dialog has keyboard navigation", async () => {
      const content = (await copyAll("search-dialog")).get("SearchDialog.svelte")!;

      for (const key of ["ArrowDown", "ArrowUp", "Home", "End", "Enter", "Escape", "Tab"]) {
        expect(content, key).toContain(key);
      }
    });

    it("highlighting uses mark elements, never @html", async () => {
      const content = (await copyAll("search-dialog")).get("SearchResultRow.svelte")!;

      expect(content).toContain("<mark>");
      expect(content).toContain("highlightParts");
      expect(content).not.toMatch(/{@html\s/);
    });

    it("search-results needs no createSearch store", async () => {
      const content = (await copyAll("search-results")).get("SearchResults.svelte")!;

      expect(content).toContain("buildResultUrl");
      expect(content).not.toContain("createSearch");
      // Standalone results stay framework agnostic.
      expect(content).not.toContain("$app/navigation");
    });

    it("the stylesheet defines every documented theme mode", async () => {
      const css = (await copyAll("search-dialog")).get("search-theme.css")!;

      expect(css).toContain('.ss-search[data-theme="light"]');
      expect(css).toContain('.ss-search[data-theme="dark"]');
      expect(css).toContain('.ss-search[data-theme="system"]');
      expect(css).toContain('.ss-search[data-theme="inherit"]');
      expect(css).toContain("prefers-color-scheme: dark");
      expect(css).toContain("prefers-reduced-motion: reduce");
      expect(css).toContain("forced-colors: active");
    });

    it("the stylesheet needs no Tailwind", async () => {
      const files = await copyAll("search-dialog");

      const css = files.get("search-theme.css")!;
      expect(css).not.toContain("@tailwind");
      expect(css).not.toContain("@apply");

      const component = files.get("SearchDialog.svelte")!;
      expect(component).toContain('import "./search-theme.css"');
      expect(component).not.toMatch(/class="[^"]*\bdark:/);
    });

    it("exposes the documented public tokens", async () => {
      const css = (await copyAll("search-dialog")).get("search-theme.css")!;

      for (const token of [
        "--ss-search-surface",
        "--ss-search-surface-raised",
        "--ss-search-text",
        "--ss-search-muted",
        "--ss-search-border",
        "--ss-search-hover",
        "--ss-search-active",
        "--ss-search-accent",
        "--ss-search-mark",
        "--ss-search-error",
        "--ss-search-backdrop",
        "--ss-search-radius",
        "--ss-search-shadow",
        "--ss-search-font",
      ]) {
        expect(css, token).toContain(`${token}:`);
      }
    });
  });

  describe("shared template sync", () => {
    it("keeps every component's support files identical to _shared", () => {
      expect(syncTemplates({ check: true })).toEqual([]);
    });

    it("covers every component that ships support files", () => {
      expect(Object.keys(SHARED_TEMPLATE_FILES).sort()).toEqual(listAvailableComponents().sort());
    });
  });
});
