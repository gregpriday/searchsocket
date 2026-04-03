import { describe, expect, it } from "vitest";
import { buildTree } from "../src/search/engine";

describe("buildTree", () => {
  it("returns empty root for no pages", () => {
    const root = buildTree([]);
    expect(root.url).toBe("/");
    expect(root.isIndexed).toBe(false);
    expect(root.children).toEqual([]);
    expect(root.childCount).toBe(0);
    expect(root.depth).toBe(0);
  });

  it("handles root page only", () => {
    const root = buildTree([{ url: "/", title: "Home", routeFile: "src/routes/+page.svelte" }]);
    expect(root.url).toBe("/");
    expect(root.title).toBe("Home");
    expect(root.routeFile).toBe("src/routes/+page.svelte");
    expect(root.isIndexed).toBe(true);
    expect(root.childCount).toBe(0);
    expect(root.depth).toBe(0);
  });

  it("builds a nested tree from multiple pages", () => {
    const root = buildTree([
      { url: "/", title: "Home", routeFile: "src/routes/+page.svelte" },
      { url: "/docs", title: "Docs", routeFile: "src/routes/docs/+page.svelte" },
      { url: "/docs/getting-started", title: "Getting Started", routeFile: "src/routes/docs/getting-started/+page.svelte" }
    ]);

    expect(root.isIndexed).toBe(true);
    expect(root.childCount).toBe(1);
    expect(root.children[0]!.url).toBe("/docs");
    expect(root.children[0]!.title).toBe("Docs");
    expect(root.children[0]!.isIndexed).toBe(true);
    expect(root.children[0]!.depth).toBe(1);
    expect(root.children[0]!.childCount).toBe(1);
    expect(root.children[0]!.children[0]!.url).toBe("/docs/getting-started");
    expect(root.children[0]!.children[0]!.title).toBe("Getting Started");
    expect(root.children[0]!.children[0]!.depth).toBe(2);
  });

  it("creates implicit parent nodes for missing intermediates", () => {
    const root = buildTree([
      { url: "/blog/post-1", title: "Post 1", routeFile: "src/routes/blog/post-1/+page.svelte" },
      { url: "/blog/post-2", title: "Post 2", routeFile: "src/routes/blog/post-2/+page.svelte" }
    ]);

    expect(root.childCount).toBe(1);
    const blog = root.children[0]!;
    expect(blog.url).toBe("/blog");
    expect(blog.isIndexed).toBe(false);
    expect(blog.title).toBe("");
    expect(blog.routeFile).toBe("");
    expect(blog.childCount).toBe(2);
    expect(blog.children[0]!.url).toBe("/blog/post-1");
    expect(blog.children[0]!.isIndexed).toBe(true);
    expect(blog.children[1]!.url).toBe("/blog/post-2");
  });

  it("sorts children alphabetically", () => {
    const root = buildTree([
      { url: "/zebra", title: "Zebra", routeFile: "" },
      { url: "/apple", title: "Apple", routeFile: "" },
      { url: "/mango", title: "Mango", routeFile: "" }
    ]);

    expect(root.children.map((c) => c.url)).toEqual(["/apple", "/mango", "/zebra"]);
  });

  it("scopes to pathPrefix subtree", () => {
    const subtree = buildTree(
      [
        { url: "/docs", title: "Docs", routeFile: "" },
        { url: "/docs/api", title: "API", routeFile: "" },
        { url: "/docs/guides", title: "Guides", routeFile: "" },
        { url: "/blog", title: "Blog", routeFile: "" }
      ],
      "/docs"
    );

    expect(subtree.url).toBe("/docs");
    expect(subtree.isIndexed).toBe(true);
    expect(subtree.childCount).toBe(2);
    expect(subtree.children.map((c) => c.url)).toEqual(["/docs/api", "/docs/guides"]);
  });

  it("returns empty placeholder when pathPrefix has no matching node", () => {
    const subtree = buildTree(
      [{ url: "/about", title: "About", routeFile: "" }],
      "/nonexistent"
    );

    expect(subtree.url).toBe("/nonexistent");
    expect(subtree.isIndexed).toBe(false);
    expect(subtree.childCount).toBe(0);
  });

  it("handles deeply nested URLs with multiple implicit parents", () => {
    const root = buildTree([
      { url: "/a/b/c/d", title: "Deep Page", routeFile: "" }
    ]);

    expect(root.childCount).toBe(1);
    const a = root.children[0]!;
    expect(a.url).toBe("/a");
    expect(a.isIndexed).toBe(false);
    expect(a.children[0]!.url).toBe("/a/b");
    expect(a.children[0]!.isIndexed).toBe(false);
    expect(a.children[0]!.children[0]!.url).toBe("/a/b/c");
    expect(a.children[0]!.children[0]!.isIndexed).toBe(false);
    expect(a.children[0]!.children[0]!.children[0]!.url).toBe("/a/b/c/d");
    expect(a.children[0]!.children[0]!.children[0]!.isIndexed).toBe(true);
    expect(a.children[0]!.children[0]!.children[0]!.title).toBe("Deep Page");
  });

  it("normalizes trailing slashes and double slashes", () => {
    const root = buildTree([
      { url: "/docs/", title: "Docs", routeFile: "" },
      { url: "//about", title: "About", routeFile: "" }
    ]);

    expect(root.children.map((c) => c.url)).toEqual(["/about", "/docs"]);
    expect(root.children[0]!.isIndexed).toBe(true);
    expect(root.children[1]!.isIndexed).toBe(true);
  });

  it("childCount always matches children.length", () => {
    const root = buildTree([
      { url: "/", title: "Home", routeFile: "" },
      { url: "/a", title: "A", routeFile: "" },
      { url: "/b", title: "B", routeFile: "" },
      { url: "/b/c", title: "C", routeFile: "" }
    ]);

    const checkCounts = (node: typeof root): void => {
      expect(node.childCount).toBe(node.children.length);
      for (const child of node.children) {
        checkCounts(child);
      }
    };
    checkCounts(root);
  });
});
