import { describe, expect, it, vi } from "vitest";
import { UpstashSearchStore } from "../src/vector/upstash";
import {
  INDEX_SCHEMA_VERSION,
  assertSafeName,
  chunkId,
  chunkLogicalKey,
  filterStringLiteral,
  groupFilter,
  isSafeName,
  logicalKeyFromId,
  pageId,
  recordBelongsToScope,
  urlFromPageId
} from "../src/vector/ids";
import type { Scope } from "../src/types";

/**
 * Release-blocking invariant: a record belonging to one project or scope must
 * never be overwritten by, or returned to, another.
 *
 * Page IDs used to be the raw URL and chunk keys omitted the project id, while
 * every project shared the same two namespaces — so two sites both serving
 * `/docs` wrote to the same vector.
 */

const alpha: Scope = { projectId: "alpha", scopeName: "main", scopeId: "alpha:main" };
const beta: Scope = { projectId: "beta", scopeName: "main", scopeId: "beta:main" };
const alphaPreview: Scope = { projectId: "alpha", scopeName: "preview", scopeId: "alpha:preview" };

interface FakeVector {
  id: string;
  metadata?: Record<string, unknown>;
}

function createFakeIndex() {
  const pagesNs = {
    upsert: vi.fn(async () => "Success"),
    delete: vi.fn(async () => ({ deleted: 0 })),
    query: vi.fn(async () => []),
    fetch: vi.fn(async () => [null]),
    range: vi.fn(async () => ({ vectors: [] as FakeVector[], nextCursor: "0" }))
  };
  const chunksNs = {
    upsert: vi.fn(async () => "Success"),
    delete: vi.fn(async () => ({ deleted: 0 })),
    query: vi.fn(async () => []),
    fetch: vi.fn(async () => [null]),
    range: vi.fn(async () => ({ vectors: [] as FakeVector[], nextCursor: "0" }))
  };
  const index = {
    namespace: vi.fn((name: string) => (name === "pages" ? pagesNs : chunksNs)),
    info: vi.fn(async () => ({ vectorCount: 0 }))
  };
  return { index, pagesNs, chunksNs };
}

function createStore(index: ReturnType<typeof createFakeIndex>["index"]) {
  return new UpstashSearchStore({
    index: index as never,
    pagesNamespace: "pages",
    chunksNamespace: "chunks"
  });
}

describe("record identity", () => {
  it("gives the same URL different IDs in different projects", () => {
    expect(pageId(alpha, "/docs")).not.toBe(pageId(beta, "/docs"));
  });

  it("gives the same URL different IDs in different scopes", () => {
    expect(pageId(alpha, "/docs")).not.toBe(pageId(alphaPreview, "/docs"));
  });

  it("gives the same chunk key different IDs in different projects", () => {
    expect(chunkId(alpha, "abc")).not.toBe(chunkId(beta, "abc"));
  });

  it("round-trips a URL through a page ID", () => {
    for (const url of ["/", "/docs", "/docs/a b", "/docs/ünï", "/a?b=c#d", "/docs/:weird"]) {
      expect(urlFromPageId(pageId(alpha, url), alpha)).toBe(url);
    }
  });

  it("does not decode an ID belonging to another scope", () => {
    expect(urlFromPageId(pageId(beta, "/docs"), alpha)).toBeNull();
    expect(logicalKeyFromId(chunkId(beta, "abc"), alpha, "chunk")).toBeNull();
  });

  it("does not confuse a page ID with a chunk ID", () => {
    expect(logicalKeyFromId(pageId(alpha, "/docs"), alpha, "chunk")).toBeNull();
  });

  it("carries the schema version so an older layout is not misread", () => {
    expect(pageId(alpha, "/docs")).toContain(`:${INDEX_SCHEMA_VERSION}:`);
  });
});

describe("name safety", () => {
  it("accepts ordinary project and scope names", () => {
    for (const name of ["alpha", "my-site", "feature_x", "v1.2.3", "MAIN"]) {
      expect(isSafeName(name)).toBe(true);
    }
  });

  it("rejects names that would break an ID or escape a filter literal", () => {
    for (const name of [
      "",
      "has space",
      "has/slash",
      "has:colon",
      "quote'injection",
      "back\\slash",
      "a".repeat(81)
    ]) {
      expect(isSafeName(name)).toBe(false);
      expect(() => assertSafeName("scope name", name)).toThrow(/Invalid scope name/);
    }
  });
});

describe("filter literals", () => {
  // Upstash documents single-quoted string literals but specifies no escape
  // sequence for a quote or backslash, so the only provably safe handling is
  // to reject those characters rather than guess at an escaping rule.
  it("quotes a safe value", () => {
    expect(filterStringLiteral("main", "scope name")).toBe("'main'");
  });

  it("rejects a value containing a quote or backslash", () => {
    expect(() => filterStringLiteral("o'brien", "url")).toThrow(/quote or backslash/);
    expect(() => filterStringLiteral("a\\b", "url")).toThrow(/quote or backslash/);
  });

  it("rejects an injection-shaped value outright", () => {
    expect(() => filterStringLiteral("main' OR projectId = 'other", "scope name")).toThrow(
      /quote or backslash/
    );
  });
});

describe("caller filter grouping", () => {
  it("parenthesises a caller filter", () => {
    // Upstash gives AND higher precedence than OR, so an ungrouped
    // `a = 1 OR b = 2` appended to the scope predicates becomes
    // `(scope AND a = 1) OR b = 2` and matches every project.
    expect(groupFilter("a = 1 OR b = 2")).toBe("(a = 1 OR b = 2)");
  });
});

describe("scope ownership on direct fetch", () => {
  it("accepts a record from the requested scope", () => {
    expect(
      recordBelongsToScope(
        { projectId: "alpha", scopeName: "main", schemaVersion: INDEX_SCHEMA_VERSION },
        alpha
      )
    ).toBe(true);
  });

  it("rejects another project, another scope, and an older schema", () => {
    expect(
      recordBelongsToScope(
        { projectId: "beta", scopeName: "main", schemaVersion: INDEX_SCHEMA_VERSION },
        alpha
      )
    ).toBe(false);
    expect(
      recordBelongsToScope(
        { projectId: "alpha", scopeName: "preview", schemaVersion: INDEX_SCHEMA_VERSION },
        alpha
      )
    ).toBe(false);
    expect(recordBelongsToScope({ projectId: "alpha", scopeName: "main" }, alpha)).toBe(false);
    expect(recordBelongsToScope(undefined, alpha)).toBe(false);
  });
});

describe("store isolation", () => {
  it("writes the same URL to different records for two projects", async () => {
    const a = createFakeIndex();
    const b = createFakeIndex();

    await createStore(a.index).upsertPages(
      [{ id: "/docs", data: "Alpha docs", metadata: { url: "/docs" } }],
      alpha
    );
    await createStore(b.index).upsertPages(
      [{ id: "/docs", data: "Beta docs", metadata: { url: "/docs" } }],
      beta
    );

    const alphaId = (a.pagesNs.upsert.mock.lastCall as unknown as [Array<{ id: string }>])[0][0]!.id;
    const betaId = (b.pagesNs.upsert.mock.lastCall as unknown as [Array<{ id: string }>])[0][0]!.id;

    expect(alphaId).not.toBe(betaId);
  });

  it("stamps every written record with its project, scope, and schema version", async () => {
    const { index, pagesNs, chunksNs } = createFakeIndex();
    const store = createStore(index);

    await store.upsertPages([{ id: "/docs", data: "d", metadata: {} }], alpha);
    await store.upsertChunks([{ id: "k1", data: "d", metadata: {} }], alpha);

    const page = (pagesNs.upsert.mock.lastCall as unknown as [Array<{ metadata: Record<string, unknown> }>])[0][0]!;
    const chunk = (chunksNs.upsert.mock.lastCall as unknown as [Array<{ metadata: Record<string, unknown> }>])[0][0]!;

    for (const meta of [page.metadata, chunk.metadata]) {
      expect(meta.projectId).toBe("alpha");
      expect(meta.scopeName).toBe("main");
      expect(meta.schemaVersion).toBe(INDEX_SCHEMA_VERSION);
    }
  });

  it("does not return another project's page from getPage", async () => {
    const { index, pagesNs } = createFakeIndex();
    // The backend returns a record — but it belongs to `beta`.
    pagesNs.fetch.mockResolvedValueOnce([
      {
        id: pageId(beta, "/docs"),
        metadata: {
          projectId: "beta",
          scopeName: "main",
          schemaVersion: INDEX_SCHEMA_VERSION,
          url: "/docs",
          title: "Beta docs"
        }
      }
    ] as never);

    expect(await createStore(index).getPage("/docs", alpha)).toBeNull();
  });

  it("does not return another scope's page from getPage", async () => {
    const { index, pagesNs } = createFakeIndex();
    pagesNs.fetch.mockResolvedValueOnce([
      {
        id: pageId(alphaPreview, "/docs"),
        metadata: {
          projectId: "alpha",
          scopeName: "preview",
          schemaVersion: INDEX_SCHEMA_VERSION,
          url: "/docs",
          title: "Preview docs"
        }
      }
    ] as never);

    expect(await createStore(index).getPage("/docs", alpha)).toBeNull();
  });

  it("ignores a record written under an older schema version", async () => {
    const { index, pagesNs } = createFakeIndex();
    pagesNs.fetch.mockResolvedValueOnce([
      {
        id: "/docs",
        metadata: { projectId: "alpha", scopeName: "main", url: "/docs", title: "Legacy" }
      }
    ] as never);

    expect(await createStore(index).getPage("/docs", alpha)).toBeNull();
  });

  it("constrains every scan to the requesting scope's prefix", async () => {
    const { index, pagesNs, chunksNs } = createFakeIndex();
    const store = createStore(index);

    await store.getPageHashes(alpha);
    await store.scanChunkIds(alpha);

    const pageRange = (pagesNs.range.mock.lastCall as unknown as [{ prefix?: string }])[0];
    const chunkRange = (chunksNs.range.mock.lastCall as unknown as [{ prefix?: string }])[0];

    expect(pageRange.prefix).toContain("alpha");
    expect(pageRange.prefix).toContain("main");
    expect(chunkRange.prefix).toContain("alpha");
    expect(chunkRange.prefix).not.toBe(pageRange.prefix);
  });

  it("includes project, scope, and schema version in every query filter", async () => {
    const { index, pagesNs, chunksNs } = createFakeIndex();
    const store = createStore(index);

    await store.searchPagesByText("q", { limit: 5 }, alpha);
    await store.search("q", { limit: 5 }, alpha);

    for (const ns of [pagesNs, chunksNs]) {
      const filter = (ns.query.mock.lastCall as unknown as [{ filter: string }])[0].filter;
      expect(filter).toContain("projectId = 'alpha'");
      expect(filter).toContain("scopeName = 'main'");
      expect(filter).toContain(`schemaVersion = ${INDEX_SCHEMA_VERSION}`);
    }
  });
});

describe("chunk key stability", () => {
  const base = { url: "/docs", headingPath: ["Intro"], text: "Some body text.", collisionOrdinal: 0 };

  it("is independent of the chunk's position on the page", () => {
    // The old key hashed the chunk's index, so inserting a paragraph above a
    // section changed that section's key and every key after it.
    expect(chunkLogicalKey(base)).toBe(chunkLogicalKey({ ...base }));
  });

  it("changes when the text changes", () => {
    expect(chunkLogicalKey(base)).not.toBe(chunkLogicalKey({ ...base, text: "Different." }));
  });

  it("changes when the heading path changes", () => {
    expect(chunkLogicalKey(base)).not.toBe(
      chunkLogicalKey({ ...base, headingPath: ["Intro", "Detail"] })
    );
  });

  it("ignores heading case and surrounding whitespace", () => {
    expect(chunkLogicalKey(base)).toBe(chunkLogicalKey({ ...base, headingPath: ["  INTRO "] }));
  });

  it("separates identical repeated sections", () => {
    expect(chunkLogicalKey(base)).not.toBe(chunkLogicalKey({ ...base, collisionOrdinal: 1 }));
  });

  it("separates the same section on different pages", () => {
    expect(chunkLogicalKey(base)).not.toBe(chunkLogicalKey({ ...base, url: "/guide" }));
  });
});

describe("regressions fixed after review", () => {
  it("fetches related pages by encoded ID, not raw URL", async () => {
    // fetchPageWithVector/fetchPagesBatch still fetched `[url]` after the ID
    // change, so related-pages found nothing once legacy records were removed —
    // and accepted a legacy record while one still existed.
    const { index, pagesNs } = createFakeIndex();
    const store = createStore(index);

    await store.fetchPageWithVector("/docs", alpha);
    expect(pagesNs.fetch).toHaveBeenCalledWith([pageId(alpha, "/docs")], expect.anything());

    await store.fetchPagesBatch(["/a", "/b"], alpha);
    expect(pagesNs.fetch).toHaveBeenLastCalledWith(
      [pageId(alpha, "/a"), pageId(alpha, "/b")],
      expect.anything()
    );
  });

  it("rejects a legacy record from fetchPageWithVector", async () => {
    const { index, pagesNs } = createFakeIndex();
    pagesNs.fetch.mockResolvedValueOnce([
      {
        id: "/docs",
        vector: [0.1],
        metadata: { projectId: "alpha", scopeName: "main", url: "/docs", title: "Legacy" }
      }
    ] as never);

    expect(await createStore(index).fetchPageWithVector("/docs", alpha)).toBeNull();
  });

  it("groups a caller-supplied filter inside the scope predicates", async () => {
    const { index, chunksNs } = createFakeIndex();

    await createStore(index).search("q", { limit: 5, filter: "a = 1 OR b = 2" }, alpha);

    const filter = (chunksNs.query.mock.lastCall as unknown as [{ filter: string }])[0].filter;
    expect(filter).toContain("(a = 1 OR b = 2)");
    // Without the parentheses the trailing OR escapes the tenant predicates.
    expect(filter).not.toMatch(/AND a = 1 OR b = 2$/);
  });

  it("drops a result the backend returned outside the requested scope", async () => {
    const { index, chunksNs } = createFakeIndex();
    chunksNs.query.mockResolvedValueOnce([
      {
        id: chunkId(beta, "k1"),
        score: 0.9,
        metadata: {
          projectId: "beta",
          scopeName: "main",
          schemaVersion: INDEX_SCHEMA_VERSION,
          url: "/docs"
        }
      }
    ] as never);

    expect(await createStore(index).search("q", { limit: 5 }, alpha)).toEqual([]);
  });

  it("returns logical keys from queries so they round-trip into deletes", async () => {
    const { index, chunksNs } = createFakeIndex();
    chunksNs.query.mockResolvedValueOnce([
      {
        id: chunkId(alpha, "k1"),
        score: 0.9,
        metadata: {
          projectId: "alpha",
          scopeName: "main",
          schemaVersion: INDEX_SCHEMA_VERSION,
          url: "/docs"
        }
      }
    ] as never);

    const hits = await createStore(index).search("q", { limit: 5 }, alpha);
    expect(hits[0]!.id).toBe("k1");
  });

  it("deletes the real records in deletePages rather than double-encoding them", async () => {
    // deletePages collected physical IDs and handed them to deletePagesByIds,
    // which encodes URLs — producing pageId(scope, "ss:1:...") and deleting
    // nothing at all.
    const { index, pagesNs } = createFakeIndex();
    const physical = pageId(alpha, "/docs");
    pagesNs.range.mockResolvedValueOnce({
      vectors: [
        {
          id: physical,
          metadata: {
            projectId: "alpha",
            scopeName: "main",
            schemaVersion: INDEX_SCHEMA_VERSION,
            url: "/docs"
          }
        }
      ],
      nextCursor: "0"
    } as never);

    await createStore(index).deletePages(alpha);
    expect(pagesNs.delete).toHaveBeenCalledWith([physical]);
  });

  it("does not treat a newer schema version as legacy", async () => {
    // `!== current` would make a 1.0 cleanup delete records written by a
    // future version sharing the index.
    const { index, pagesNs } = createFakeIndex();
    pagesNs.range.mockResolvedValueOnce({
      vectors: [
        { id: "old", metadata: { projectId: "alpha" } },
        { id: "current", metadata: { projectId: "alpha", schemaVersion: INDEX_SCHEMA_VERSION } },
        { id: "future", metadata: { projectId: "alpha", schemaVersion: INDEX_SCHEMA_VERSION + 1 } }
      ],
      nextCursor: "0"
    } as never);

    const found = await createStore(index).scanLegacyRecords("alpha");
    expect(found.pages).toEqual(["old"]);
  });

  it("re-verifies ownership before deleting a legacy record", async () => {
    const { index, pagesNs } = createFakeIndex();
    pagesNs.fetch.mockResolvedValueOnce([
      { id: "mine", metadata: { projectId: "alpha" } },
      { id: "theirs", metadata: { projectId: "beta" } },
      { id: "now-current", metadata: { projectId: "alpha", schemaVersion: INDEX_SCHEMA_VERSION } }
    ] as never);

    const result = await createStore(index).deleteLegacyRecords("alpha", {
      pages: ["mine", "theirs", "now-current"],
      chunks: []
    });

    expect(pagesNs.delete).toHaveBeenCalledWith(["mine"]);
    expect(result).toEqual({ deleted: 1, skipped: 2 });
  });

  it("refuses to build a prefix from unvalidated scope names", () => {
    // `Scope` is public, so ("a:b","c") and ("a","b:c") would otherwise share
    // an ID prefix and collide.
    const unsafe: Scope = { projectId: "a:b", scopeName: "c", scopeId: "x" };
    expect(() => pageId(unsafe, "/docs")).toThrow(/Invalid project id/);
  });
});

describe("chunk key collision resistance", () => {
  it("does not confuse a delimiter in the URL with one in the heading path", () => {
    // A delimiter-joined preimage made url "/a|b" + heading "c" and
    // url "/a" + heading "b|c" hash identically. Both are legal inputs.
    const a = chunkLogicalKey({ url: "/a|b", headingPath: ["c"], text: "t", collisionOrdinal: 0 });
    const b = chunkLogicalKey({ url: "/a", headingPath: ["b|c"], text: "t", collisionOrdinal: 0 });
    expect(a).not.toBe(b);
  });

  it("does not confuse heading-path segmentation", () => {
    const a = chunkLogicalKey({ url: "/x", headingPath: ["a > b"], text: "t", collisionOrdinal: 0 });
    const b = chunkLogicalKey({ url: "/x", headingPath: ["a", "b"], text: "t", collisionOrdinal: 0 });
    expect(a).not.toBe(b);
  });
});
