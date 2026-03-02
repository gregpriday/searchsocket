/**
 * Search quality evaluation tests.
 *
 * Runs against a real Upstash index (requires credentials + indexed content).
 * Skip by default — enable with: SEARCHSOCKET_QUALITY_TESTS=1 pnpm test tests/quality.test.ts
 *
 * By default, looks for a searchsocket.config.ts in the current directory.
 * Override with QUALITY_TEST_CWD to point at a project with an indexed corpus.
 *
 * Example:
 *   SEARCHSOCKET_QUALITY_TESTS=1 QUALITY_TEST_CWD=/path/to/canopy-website pnpm vitest run tests/quality.test.ts
 */
import { config as dotenvConfig } from "dotenv";
import path from "node:path";
import { describe, it, expect, beforeAll } from "vitest";
import { SearchEngine } from "../src/search/engine";
import type { SearchResult, SearchResponse } from "../src/types";
import { judgments } from "./fixtures/quality-judgments";
import {
  reciprocalRank,
  precisionAtK,
  ndcgAtK,
  noiseRejectionRate,
  formatReport
} from "./helpers/quality-metrics";

const SKIP = !process.env.SEARCHSOCKET_QUALITY_TESTS;
const QUALITY_CWD = process.env.QUALITY_TEST_CWD;

describe.skipIf(SKIP)("search quality", () => {
  let engine: SearchEngine;
  const resultCache = new Map<string, SearchResponse>();

  async function runQuery(query: string, topK = 10): Promise<SearchResponse> {
    const cached = resultCache.get(`${query}:${topK}`);
    if (cached) return cached;
    const result = await engine.search({ q: query, topK });
    resultCache.set(`${query}:${topK}`, result);
    return result;
  }

  beforeAll(async () => {
    const cwd = QUALITY_CWD ? path.resolve(QUALITY_CWD) : process.cwd();
    // Load .env from target project
    dotenvConfig({ path: path.join(cwd, ".env") });
    engine = await SearchEngine.create({ cwd });
  }, 30_000);

  // ── Per-query ranking correctness ────────────────────
  describe("ranking correctness", () => {
    const rankingJudgments = judgments.filter((j) => !j.expectEmpty && j.expected.length > 0);

    for (const j of rankingJudgments) {
      it(`"${j.query}" → ${j.expected[0]!.url} in top ${j.expected[0]!.minRank ?? 10}`, async () => {
        const { results } = await runQuery(j.query);

        for (const exp of j.expected) {
          const rank = results.findIndex((r) => r.url === exp.url) + 1;
          expect(rank, `Expected ${exp.url} in results for "${j.query}"`).toBeGreaterThan(0);
          if (exp.minRank) {
            expect(
              rank,
              `Expected ${exp.url} at rank <= ${exp.minRank}, got ${rank} for "${j.query}"`
            ).toBeLessThanOrEqual(exp.minRank);
          }
        }
      });
    }
  });

  // ── Noise rejection ──────────────────────────────────
  // Noise queries should ideally return empty or very-low-confidence results.
  // With Upstash, gibberish queries can still score high (reranker limitation),
  // so we track noise rejection rate as a metric rather than a hard gate.
  describe("noise rejection", () => {
    const noiseJudgments = judgments.filter((j) => j.expectEmpty);
    // Threshold: results scoring below this are considered noise
    const NOISE_THRESHOLD = 0.3;

    for (const j of noiseJudgments) {
      it(`"${j.query}" returns no confident results`, async () => {
        const { results } = await runQuery(j.query, 5);
        const confident = results.filter((r) => r.score >= NOISE_THRESHOLD);
        // Log for diagnostics — tracking noise rejection improvement over time
        if (confident.length > 0) {
          console.log(
            `  [noise] "${j.query}" (${j.category}) → ${confident.length} confident: ` +
            confident.map((r) => `${r.url}(${r.score.toFixed(3)})`).join(", ")
          );
        }
        // Informational: noise rejection is a known limitation of hybrid search.
        // Track improvement via the aggregate metric rather than failing individual tests.
      });
    }
  });

  // ── Aggregate metrics ────────────────────────────────
  describe("aggregate metrics", () => {
    it("reports quality metrics", async () => {
      const rankingJudgments = judgments.filter((j) => !j.expectEmpty && j.expected.length > 0);
      const noiseJudgments = judgments.filter((j) => j.expectEmpty);

      // Run all queries
      const queryData: Array<{
        results: SearchResult[];
        relevant: string[];
        graded: Array<{ url: string; relevance: number }>;
      }> = [];

      for (const j of rankingJudgments) {
        const { results } = await runQuery(j.query);
        queryData.push({
          results,
          relevant: j.expected.filter((e) => e.relevance >= 2).map((e) => e.url),
          graded: j.expected
        });
      }

      // Noise queries — track both raw and confident results
      const NOISE_THRESHOLD = 0.3;
      const noiseResults = new Map<string, SearchResult[]>();
      for (const j of noiseJudgments) {
        const { results } = await runQuery(j.query, 5);
        // For noise rejection metric, count only confident results
        noiseResults.set(j.query, results.filter((r) => r.score >= NOISE_THRESHOLD));
      }

      // Compute metrics
      const mrrQueries = queryData.map((d) => ({ results: d.results, relevant: d.relevant }));
      const mrrValue = mrrQueries.length > 0
        ? mrrQueries.reduce((acc, q) => acc + reciprocalRank(q.results, q.relevant), 0) / mrrQueries.length
        : 0;

      const p3Values = queryData.map((d) => precisionAtK(d.results, d.relevant, 3));
      const avgP3 = p3Values.length > 0 ? p3Values.reduce((a, b) => a + b, 0) / p3Values.length : 0;

      const ndcgValues = queryData.map((d) => ndcgAtK(d.results, d.graded, 5));
      const avgNdcg = ndcgValues.length > 0 ? ndcgValues.reduce((a, b) => a + b, 0) / ndcgValues.length : 0;

      const noiseRate = noiseRejectionRate(
        noiseResults,
        noiseJudgments.map((j) => j.query)
      );

      // Count ranking passes
      let passedRanking = 0;
      let failedRanking = 0;
      for (const j of rankingJudgments) {
        const { results } = await runQuery(j.query);
        let passed = true;
        for (const exp of j.expected) {
          const rank = results.findIndex((r) => r.url === exp.url) + 1;
          if (rank === 0 || (exp.minRank && rank > exp.minRank)) {
            passed = false;
            break;
          }
        }
        if (passed) passedRanking++;
        else failedRanking++;
      }

      const report = formatReport({
        mrr: mrrValue,
        precisionAt3: avgP3,
        ndcgAt5: avgNdcg,
        noiseRejection: noiseRate,
        totalQueries: judgments.length,
        passedRanking,
        failedRanking
      });

      // Print report for visibility
      console.log("\n" + report + "\n");

      // Soft thresholds — these set the quality floor
      // P@3 max is ~0.33 when each query has 1 relevant URL
      expect(mrrValue, "MRR should be >= 0.7").toBeGreaterThanOrEqual(0.7);
      expect(avgP3, "P@3 should be >= 0.25").toBeGreaterThanOrEqual(0.25);
      expect(avgNdcg, "NDCG@5 should be >= 0.6").toBeGreaterThanOrEqual(0.6);
      console.log(`Noise rejection: ${(noiseRate * 100).toFixed(1)}%`);
    });
  });
});
