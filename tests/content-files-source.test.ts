import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDefaultConfig } from "../src/config/defaults";
import {
  loadContentFilesPages,
  extractSvelteComponentMeta,
  buildComponentMarkdown,
  isSvelteComponentFile
} from "../src/indexing/sources/content-files";

const tempDirs: string[] = [];

async function makeFixture(): Promise<string> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "searchsocket-content-files-"));
  tempDirs.push(cwd);

  await fs.mkdir(path.join(cwd, "src", "routes", "docs", "[slug]"), { recursive: true });
  await fs.mkdir(path.join(cwd, "src", "routes", "docs", "[...rest]"), { recursive: true });
  await fs.mkdir(path.join(cwd, "src", "routes", "docs", "[[optional]]"), { recursive: true });
  await fs.mkdir(path.join(cwd, "src", "routes", "(marketing)", "pricing"), { recursive: true });
  await fs.mkdir(path.join(cwd, "content", "guides", "intro"), { recursive: true });

  await fs.writeFile(path.join(cwd, "src", "routes", "+page.svelte"), "<main>Home</main>", "utf8");
  await fs.writeFile(
    path.join(cwd, "src", "routes", "docs", "[slug]", "+page.svelte"),
    "<main>Doc slug page</main>",
    "utf8"
  );
  await fs.writeFile(
    path.join(cwd, "src", "routes", "docs", "[...rest]", "+page.svelte"),
    "<main>Doc rest page</main>",
    "utf8"
  );
  await fs.writeFile(
    path.join(cwd, "src", "routes", "docs", "[[optional]]", "+page.svelte"),
    "<main>Doc optional page</main>",
    "utf8"
  );
  await fs.writeFile(
    path.join(cwd, "src", "routes", "(marketing)", "pricing", "+page.svelte"),
    "<main>Pricing</main>",
    "utf8"
  );
  await fs.writeFile(path.join(cwd, "content", "guides", "intro", "index.md"), "# Intro\n", "utf8");

  return cwd;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("loadContentFilesPages", () => {
  it("maps Svelte route files to URL paths when baseDir is project root", async () => {
    const cwd = await makeFixture();
    const config = createDefaultConfig("searchsocket-content-test");
    config.source.mode = "content-files";
    config.source.contentFiles = {
      globs: ["src/routes/**/+page.svelte"],
      baseDir: cwd
    };

    const pages = await loadContentFilesPages(cwd, config);
    const urls = new Set(pages.map((page) => page.url));

    expect(urls.has("/")).toBe(true);
    expect(urls.has("/docs/param")).toBe(true);
    expect(urls.has("/docs/splat")).toBe(true);
    expect(urls.has("/docs/optional")).toBe(true);
    expect(urls.has("/pricing")).toBe(true);
    expect(urls.has("/src/routes")).toBe(false);
  });

  it("maps root +page.svelte to / when baseDir is src/routes", async () => {
    const cwd = await makeFixture();
    const config = createDefaultConfig("searchsocket-content-test");
    config.source.mode = "content-files";
    config.source.contentFiles = {
      globs: ["**/+page.svelte"],
      baseDir: path.join(cwd, "src", "routes")
    };

    const pages = await loadContentFilesPages(cwd, config);
    const urls = new Set(pages.map((page) => page.url));

    expect(urls.has("/")).toBe(true);
    expect(urls.has("/+page.svelte")).toBe(false);
  });

  it("maps markdown index files to clean route URLs", async () => {
    const cwd = await makeFixture();
    const config = createDefaultConfig("searchsocket-content-test");
    config.source.mode = "content-files";
    config.source.contentFiles = {
      globs: ["content/**/*.md"],
      baseDir: cwd
    };

    const pages = await loadContentFilesPages(cwd, config);
    const urls = new Set(pages.map((page) => page.url));

    expect(urls.has("/content/guides/intro")).toBe(true);
    expect(urls.has("/content/guides/intro/index")).toBe(false);
  });

  it("treats negative maxPages as zero", async () => {
    const cwd = await makeFixture();
    const config = createDefaultConfig("searchsocket-content-test");
    config.source.mode = "content-files";
    config.source.contentFiles = {
      globs: ["src/routes/**/+page.svelte"],
      baseDir: cwd
    };

    const pages = await loadContentFilesPages(cwd, config, -1);
    expect(pages).toEqual([]);
  });

  it("floors fractional maxPages values", async () => {
    const cwd = await makeFixture();
    const config = createDefaultConfig("searchsocket-content-test");
    config.source.mode = "content-files";
    config.source.contentFiles = {
      globs: ["src/routes/**/+page.svelte"],
      baseDir: cwd
    };

    const pages = await loadContentFilesPages(cwd, config, 2.9);
    expect(pages).toHaveLength(2);
  });
});

describe("isSvelteComponentFile", () => {
  it("returns true for regular component files", () => {
    expect(isSvelteComponentFile("src/lib/Button.svelte")).toBe(true);
    expect(isSvelteComponentFile("components/Hero.svelte")).toBe(true);
  });

  it("returns false for SvelteKit route files", () => {
    expect(isSvelteComponentFile("src/routes/+page.svelte")).toBe(false);
    expect(isSvelteComponentFile("src/routes/+layout.svelte")).toBe(false);
    expect(isSvelteComponentFile("src/routes/+error.svelte")).toBe(false);
    expect(isSvelteComponentFile("src/routes/+page@nav.svelte")).toBe(false);
  });

  it("returns false for non-svelte files", () => {
    expect(isSvelteComponentFile("src/lib/utils.ts")).toBe(false);
  });
});

describe("extractSvelteComponentMeta", () => {
  it("extracts @component description from HTML comment", () => {
    const source = `<!-- @component
A responsive hero banner with optional CTA button.
-->
<script lang="ts">
  let { title } = $props();
</script>
<div>{title}</div>`;

    const meta = extractSvelteComponentMeta(source);
    expect(meta.description).toBe("A responsive hero banner with optional CTA button.");
  });

  it("extracts basic $props() destructuring", () => {
    const source = `<script lang="ts">
  let { title, subtitle, count } = $props();
</script>`;

    const meta = extractSvelteComponentMeta(source);
    expect(meta.props).toHaveLength(3);
    expect(meta.props.map((p) => p.name)).toEqual(["title", "subtitle", "count"]);
  });

  it("extracts props with default values", () => {
    const source = `<script lang="ts">
  let { theme = 'light', count = 0 } = $props();
</script>`;

    const meta = extractSvelteComponentMeta(source);
    expect(meta.props).toHaveLength(2);
    expect(meta.props[0]).toEqual({ name: "theme", default: "'light'" });
    expect(meta.props[1]).toEqual({ name: "count", default: "0" });
  });

  it("extracts props with inline type annotation", () => {
    const source = `<script lang="ts">
  let { title, count }: { title: string; count: number } = $props();
</script>`;

    const meta = extractSvelteComponentMeta(source);
    expect(meta.props).toHaveLength(2);
    expect(meta.props[0]).toEqual({ name: "title", type: "string" });
    expect(meta.props[1]).toEqual({ name: "count", type: "number" });
  });

  it("extracts props with interface type reference", () => {
    const source = `<script lang="ts">
  interface HeroProps {
    title: string;
    subtitle?: string;
    theme: 'light' | 'dark';
  }
  let { title, subtitle, theme } = $props<HeroProps>();
</script>`;

    // Note: $props<HeroProps>() is NOT valid Svelte 5 syntax.
    // The correct form is: let { title }: HeroProps = $props()
    // This test verifies we DON'T match the invalid generic form.
    const meta = extractSvelteComponentMeta(source);
    expect(meta.props).toHaveLength(0);
  });

  it("extracts props with interface reference via type annotation", () => {
    const source = `<script lang="ts">
  interface HeroProps {
    title: string;
    subtitle?: string;
  }
  let { title, subtitle }: HeroProps = $props();
</script>`;

    const meta = extractSvelteComponentMeta(source);
    expect(meta.props).toHaveLength(2);
    expect(meta.props[0]).toEqual({ name: "title", type: "string" });
    expect(meta.props[1]).toEqual({ name: "subtitle", type: "string" });
  });

  it("skips rest spread elements", () => {
    const source = `<script lang="ts">
  let { title, ...rest } = $props();
</script>`;

    const meta = extractSvelteComponentMeta(source);
    expect(meta.props).toHaveLength(1);
    expect(meta.props[0]!.name).toBe("title");
  });

  it("extracts renamed props using original name", () => {
    const source = `<script lang="ts">
  let { class: className, href: link } = $props();
</script>`;

    const meta = extractSvelteComponentMeta(source);
    expect(meta.props).toHaveLength(2);
    expect(meta.props[0]!.name).toBe("class");
    expect(meta.props[1]!.name).toBe("href");
  });

  it("handles nested default values without breaking", () => {
    const source = `<script lang="ts">
  let { config = { size: 'md' }, title } = $props();
</script>`;

    const meta = extractSvelteComponentMeta(source);
    expect(meta.props).toHaveLength(2);
    expect(meta.props[0]!.name).toBe("config");
    expect(meta.props[0]!.default).toBe("{ size: 'md' }");
    expect(meta.props[1]!.name).toBe("title");
  });

  it("returns empty when no @component or $props()", () => {
    const source = `<div>Just a template</div>`;
    const meta = extractSvelteComponentMeta(source);
    expect(meta.description).toBeUndefined();
    expect(meta.props).toHaveLength(0);
  });
});

describe("buildComponentMarkdown", () => {
  it("builds prose with description and props", () => {
    const result = buildComponentMarkdown("Hero", {
      description: "A full-width hero banner.",
      props: [
        { name: "title", type: "string" },
        { name: "theme", type: "'light' | 'dark'", default: "'light'" }
      ]
    });
    expect(result).toBe(
      "Hero component. A full-width hero banner. Props: title (string), theme ('light' | 'dark') default: 'light'."
    );
  });

  it("omits Props section when no props", () => {
    const result = buildComponentMarkdown("Logo", {
      description: "A simple logo.",
      props: []
    });
    expect(result).toBe("Logo component. A simple logo.");
  });

  it("returns empty string when no description and no props", () => {
    expect(buildComponentMarkdown("Empty", { props: [] })).toBe("");
  });

  it("includes props even without description", () => {
    const result = buildComponentMarkdown("Button", {
      props: [{ name: "label", type: "string" }]
    });
    expect(result).toBe("Button component. Props: label (string).");
  });
});

describe("component indexing integration", () => {
  it("tags component files with 'component' and extracts metadata into markdown", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "searchsocket-component-"));
    tempDirs.push(cwd);

    await fs.mkdir(path.join(cwd, "src", "lib", "components"), { recursive: true });
    await fs.writeFile(
      path.join(cwd, "src", "lib", "components", "Hero.svelte"),
      `<!-- @component
A responsive hero banner with optional CTA button.
-->
<script lang="ts">
  let { title, subtitle, ctaText = 'Learn more' }: { title: string; subtitle: string; ctaText: string } = $props();
</script>
<section>
  <h1>{title}</h1>
  <p>{subtitle}</p>
  <button>{ctaText}</button>
</section>`,
      "utf8"
    );

    const config = createDefaultConfig("test");
    config.source.mode = "content-files";
    config.source.contentFiles = {
      globs: ["src/lib/components/**/*.svelte"],
      baseDir: cwd
    };

    const pages = await loadContentFilesPages(cwd, config);
    expect(pages).toHaveLength(1);

    const hero = pages[0]!;
    expect(hero.tags).toEqual(["component"]);
    expect(hero.markdown).toContain("Hero component.");
    expect(hero.markdown).toContain("A responsive hero banner");
    expect(hero.markdown).toContain("title (string)");
    expect(hero.markdown).toContain("ctaText (string) default: 'Learn more'");
  });

  it("does not tag +page.svelte files as components", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "searchsocket-component-"));
    tempDirs.push(cwd);

    await fs.mkdir(path.join(cwd, "src", "routes"), { recursive: true });
    await fs.writeFile(
      path.join(cwd, "src", "routes", "+page.svelte"),
      "<main>Home page</main>",
      "utf8"
    );

    const config = createDefaultConfig("test");
    config.source.mode = "content-files";
    config.source.contentFiles = {
      globs: ["src/routes/**/+page.svelte"],
      baseDir: cwd
    };

    const pages = await loadContentFilesPages(cwd, config);
    expect(pages).toHaveLength(1);
    expect(pages[0]!.tags).toBeUndefined();
  });

  it("gracefully handles component files with no metadata", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "searchsocket-component-"));
    tempDirs.push(cwd);

    await fs.mkdir(path.join(cwd, "src", "lib"), { recursive: true });
    await fs.writeFile(
      path.join(cwd, "src", "lib", "Spacer.svelte"),
      "<div class=\"spacer\"></div>",
      "utf8"
    );

    const config = createDefaultConfig("test");
    config.source.mode = "content-files";
    config.source.contentFiles = {
      globs: ["src/lib/**/*.svelte"],
      baseDir: cwd
    };

    const pages = await loadContentFilesPages(cwd, config);
    expect(pages).toHaveLength(1);
    expect(pages[0]!.tags).toEqual(["component"]);
    // No component markdown generated, just normalized template content
    expect(pages[0]!.markdown).not.toContain("component.");
  });
});
