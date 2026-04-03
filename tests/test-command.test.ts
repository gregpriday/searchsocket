import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { reciprocalRank, mrr } from "../src/search/quality-metrics";
import type { SearchResult } from "../src/types";

function makeResult(url: string, score = 0.5): SearchResult {
  return { url, title: "", snippet: "", score, routeFile: "" };
}

// ── Quality metrics unit tests ──────────────────────────

describe("reciprocalRank", () => {
  it("returns 1 when the relevant URL is rank 1", () => {
    const results = [makeResult("/a"), makeResult("/b"), makeResult("/c")];
    expect(reciprocalRank(results, ["/a"])).toBe(1);
  });

  it("returns 0.5 when the relevant URL is rank 2", () => {
    const results = [makeResult("/a"), makeResult("/b"), makeResult("/c")];
    expect(reciprocalRank(results, ["/b"])).toBe(0.5);
  });

  it("returns 0 when no relevant URL is found", () => {
    const results = [makeResult("/a"), makeResult("/b")];
    expect(reciprocalRank(results, ["/z"])).toBe(0);
  });

  it("returns rank of the first matching URL from relevant set", () => {
    const results = [makeResult("/a"), makeResult("/b"), makeResult("/c")];
    expect(reciprocalRank(results, ["/c", "/b"])).toBe(0.5);
  });

  it("handles empty results", () => {
    expect(reciprocalRank([], ["/a"])).toBe(0);
  });
});

describe("mrr", () => {
  it("computes mean reciprocal rank across queries", () => {
    const queries = [
      { results: [makeResult("/a"), makeResult("/b")], relevant: ["/a"] },
      { results: [makeResult("/x"), makeResult("/y")], relevant: ["/y"] }
    ];
    // (1/1 + 1/2) / 2 = 0.75
    expect(mrr(queries)).toBe(0.75);
  });

  it("returns 0 for empty queries array", () => {
    expect(mrr([])).toBe(0);
  });

  it("includes 0 contribution for unfound results", () => {
    const queries = [
      { results: [makeResult("/a")], relevant: ["/a"] },
      { results: [makeResult("/b")], relevant: ["/z"] }
    ];
    // (1 + 0) / 2 = 0.5
    expect(mrr(queries)).toBe(0.5);
  });
});

// ── Test command integration tests ──────────────────────

describe("searchsocket test command", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "ss-test-cmd-"));
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  async function writeTestFile(content: unknown, filename = "searchsocket.test.json"): Promise<string> {
    const filePath = path.join(tmpDir, filename);
    await fsp.writeFile(filePath, JSON.stringify(content), "utf8");
    return filePath;
  }

  describe("test file validation", () => {
    it("rejects an empty array", async () => {
      const filePath = await writeTestFile([]);
      const { z } = await import("zod");

      const testCaseSchema = z.object({
        query: z.string().min(1),
        expect: z
          .object({
            topResult: z.string().optional(),
            inTop5: z.array(z.string()).optional(),
            maxResults: z.number().int().nonnegative().optional()
          })
          .refine(
            (e) => e.topResult !== undefined || e.inTop5 !== undefined || e.maxResults !== undefined,
            { message: "expect must contain at least one of topResult, inTop5, or maxResults" }
          )
      });
      const testFileSchema = z.array(testCaseSchema).min(1, "test file must contain at least one test case");

      const raw = JSON.parse(await fsp.readFile(filePath, "utf8"));
      const result = testFileSchema.safeParse(raw);
      expect(result.success).toBe(false);
    });

    it("rejects a test case with empty expect", async () => {
      const { z } = await import("zod");

      const testCaseSchema = z.object({
        query: z.string().min(1),
        expect: z
          .object({
            topResult: z.string().optional(),
            inTop5: z.array(z.string()).optional(),
            maxResults: z.number().int().nonnegative().optional()
          })
          .refine(
            (e) => e.topResult !== undefined || e.inTop5 !== undefined || e.maxResults !== undefined,
            { message: "expect must contain at least one of topResult, inTop5, or maxResults" }
          )
      });
      const testFileSchema = z.array(testCaseSchema).min(1);

      const result = testFileSchema.safeParse([{ query: "hello", expect: {} }]);
      expect(result.success).toBe(false);
    });

    it("accepts a valid test file", async () => {
      const { z } = await import("zod");

      const testCaseSchema = z.object({
        query: z.string().min(1),
        expect: z
          .object({
            topResult: z.string().optional(),
            inTop5: z.array(z.string()).optional(),
            maxResults: z.number().int().nonnegative().optional()
          })
          .refine(
            (e) => e.topResult !== undefined || e.inTop5 !== undefined || e.maxResults !== undefined,
            { message: "expect must contain at least one of topResult, inTop5, or maxResults" }
          )
      });
      const testFileSchema = z.array(testCaseSchema).min(1);

      const result = testFileSchema.safeParse([
        { query: "getting started", expect: { topResult: "/docs/getting-started" } },
        { query: "gibberish", expect: { maxResults: 0 } },
        { query: "api", expect: { inTop5: ["/docs/api", "/docs/api-ref"] } }
      ]);
      expect(result.success).toBe(true);
    });
  });

  describe("assertion logic", () => {
    it("topResult passes when URL is at rank 1", () => {
      const results = [makeResult("/docs/foo"), makeResult("/docs/bar")];
      const rank = results.findIndex((r) => r.url === "/docs/foo") + 1;
      expect(rank).toBe(1);
    });

    it("topResult fails when URL is at rank 3", () => {
      const results = [makeResult("/a"), makeResult("/b"), makeResult("/docs/foo")];
      const rank = results.findIndex((r) => r.url === "/docs/foo") + 1;
      expect(rank).toBe(3);
    });

    it("topResult fails when URL is not found", () => {
      const results = [makeResult("/a"), makeResult("/b")];
      const rank = results.findIndex((r) => r.url === "/docs/foo") + 1;
      expect(rank).toBe(0); // findIndex returns -1, +1 = 0
    });

    it("inTop5 passes when all URLs appear in top 5", () => {
      const results = [
        makeResult("/a"),
        makeResult("/b"),
        makeResult("/c"),
        makeResult("/d"),
        makeResult("/e")
      ];
      const expectedUrls = ["/b", "/d"];
      const top5Urls = results.slice(0, 5).map((r) => r.url);
      const missing = expectedUrls.filter((url) => !top5Urls.includes(url));
      expect(missing).toEqual([]);
    });

    it("inTop5 fails when a URL is outside top 5", () => {
      const results = [
        makeResult("/a"),
        makeResult("/b"),
        makeResult("/c"),
        makeResult("/d"),
        makeResult("/e"),
        makeResult("/target")
      ];
      const expectedUrls = ["/target"];
      const top5Urls = results.slice(0, 5).map((r) => r.url);
      const missing = expectedUrls.filter((url) => !top5Urls.includes(url));
      expect(missing).toEqual(["/target"]);
    });

    it("maxResults passes when result count is within limit", () => {
      const results = [makeResult("/a"), makeResult("/b")];
      expect(results.length <= 3).toBe(true);
    });

    it("maxResults: 0 fails when results are non-empty", () => {
      const results = [makeResult("/a")];
      expect(results.length <= 0).toBe(false);
    });

    it("maxResults: 0 passes when results are empty", () => {
      const results: SearchResult[] = [];
      expect(results.length <= 0).toBe(true);
    });
  });

  describe("MRR excludes maxResults-only tests", () => {
    it("only includes topResult and inTop5 tests in MRR", () => {
      // Simulate collecting MRR data as the CLI does:
      // topResult test, inTop5 test, maxResults-only test
      const mrrData: Array<{ results: SearchResult[]; relevant: string[] }> = [];

      // topResult test — push to MRR
      const results1 = [makeResult("/a"), makeResult("/b")];
      mrrData.push({ results: results1, relevant: ["/a"] });

      // inTop5 test — push to MRR
      const results2 = [makeResult("/x"), makeResult("/y")];
      mrrData.push({ results: results2, relevant: ["/y"] });

      // maxResults test — NOT pushed to MRR
      // (the CLI code only pushes to mrrData for topResult and inTop5)

      const mrrValue = mrr(mrrData);
      // (1/1 + 1/2) / 2 = 0.75
      expect(mrrValue).toBe(0.75);
    });
  });
});
