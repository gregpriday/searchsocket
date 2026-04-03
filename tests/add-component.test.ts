import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  listAvailableComponents,
  isValidComponent,
  resolveTemplateDir,
  copyComponent,
} from "../src/add-helpers";

describe("add-helpers", () => {
  describe("listAvailableComponents", () => {
    it("returns the three expected component names", () => {
      const components = listAvailableComponents();
      expect(components).toEqual(["search-dialog", "search-input", "search-results"]);
    });
  });

  describe("isValidComponent", () => {
    it("returns true for valid component names", () => {
      expect(isValidComponent("search-dialog")).toBe(true);
      expect(isValidComponent("search-input")).toBe(true);
      expect(isValidComponent("search-results")).toBe(true);
    });

    it("returns false for invalid component names", () => {
      expect(isValidComponent("unknown")).toBe(false);
      expect(isValidComponent("Search-Dialog")).toBe(false);
      expect(isValidComponent("")).toBe(false);
    });
  });

  describe("resolveTemplateDir", () => {
    it("returns a path ending with templates", () => {
      const dir = resolveTemplateDir();
      expect(dir).toMatch(/templates$/);
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

    it("copies search-dialog component to target directory", async () => {
      const targetDir = path.join(tmpDir, "components", "search");
      const result = await copyComponent("search-dialog", targetDir);

      expect(result.written).toHaveLength(1);
      expect(result.skipped).toHaveLength(0);
      expect(result.written[0]!).toMatch(/SearchDialog\.svelte$/);
      expect(fs.existsSync(result.written[0]!)).toBe(true);

      const content = await fsp.readFile(result.written[0]!, "utf8");
      expect(content).toContain("createSearch");
      expect(content).toContain('role="combobox"');
      expect(content).toContain('role="listbox"');
    });

    it("copies search-input component to target directory", async () => {
      const result = await copyComponent("search-input", tmpDir);

      expect(result.written).toHaveLength(1);
      expect(result.written[0]!).toMatch(/SearchInput\.svelte$/);

      const content = await fsp.readFile(result.written[0]!, "utf8");
      expect(content).toContain("createSearch");
      expect(content).toContain('role="combobox"');
    });

    it("copies search-results component to target directory", async () => {
      const result = await copyComponent("search-results", tmpDir);

      expect(result.written).toHaveLength(1);
      expect(result.written[0]!).toMatch(/SearchResults\.svelte$/);

      const content = await fsp.readFile(result.written[0]!, "utf8");
      expect(content).toContain("buildResultUrl");
      expect(content).not.toContain("createSearch");
    });

    it("skips existing files without --overwrite", async () => {
      // First copy
      await copyComponent("search-dialog", tmpDir);

      // Second copy — should skip
      const result = await copyComponent("search-dialog", tmpDir);
      expect(result.written).toHaveLength(0);
      expect(result.skipped).toHaveLength(1);
      expect(result.skipped[0]!).toMatch(/SearchDialog\.svelte$/);
    });

    it("overwrites existing files with overwrite option", async () => {
      await copyComponent("search-dialog", tmpDir);

      // Write some different content
      const filePath = path.join(tmpDir, "SearchDialog.svelte");
      await fsp.writeFile(filePath, "modified", "utf8");

      const result = await copyComponent("search-dialog", tmpDir, { overwrite: true });
      expect(result.written).toHaveLength(1);
      expect(result.skipped).toHaveLength(0);

      const content = await fsp.readFile(filePath, "utf8");
      expect(content).toContain("createSearch");
    });

    it("creates target directory recursively", async () => {
      const deepDir = path.join(tmpDir, "a", "b", "c");
      const result = await copyComponent("search-dialog", deepDir);

      expect(result.written).toHaveLength(1);
      expect(fs.existsSync(deepDir)).toBe(true);
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

    it("templates use Svelte 5 syntax, not legacy", async () => {
      for (const name of listAvailableComponents()) {
        const result = await copyComponent(name as "search-dialog", tmpDir);
        const content = await fsp.readFile(result.written[0]!, "utf8");

        // Svelte 5 runes
        expect(content).toContain("$props()");

        // No legacy syntax
        expect(content).not.toContain("on:click");
        expect(content).not.toContain("on:keydown");
        expect(content).not.toContain("export let ");
        expect(content).not.toMatch(/{@html\s/);
      }
    });

    it("search-dialog has ARIA combobox attributes", async () => {
      const result = await copyComponent("search-dialog", tmpDir);
      const content = await fsp.readFile(result.written[0]!, "utf8");

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
      const result = await copyComponent("search-dialog", tmpDir);
      const content = await fsp.readFile(result.written[0]!, "utf8");

      expect(content).toContain("ArrowDown");
      expect(content).toContain("ArrowUp");
      expect(content).toContain("Enter");
      expect(content).toContain("Escape");
    });

    it("search-dialog uses highlight with mark, not @html", async () => {
      const result = await copyComponent("search-dialog", tmpDir);
      const content = await fsp.readFile(result.written[0]!, "utf8");

      expect(content).toContain("<mark>");
      expect(content).toContain("highlightParts");
      expect(content).not.toMatch(/{@html\s/);
    });
  });
});
