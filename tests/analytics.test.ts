import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { logAnalyticsEvent } from "../src/analytics/logger";
import { readAnalyticsLog, computeReport } from "../src/analytics/report";
import type { AnalyticsEntry } from "../src/types";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "searchsocket-analytics-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => fsp.rm(d, { recursive: true, force: true })));
});

const sampleEntry: AnalyticsEntry = {
  ts: "2026-04-01T12:00:00.000Z",
  q: "test query",
  results: 5,
  latencyMs: 120
};

describe("logAnalyticsEvent", () => {
  it("writes a valid JSONL line", async () => {
    const dir = await makeTempDir();
    const logPath = path.join(dir, "analytics.jsonl");

    logAnalyticsEvent(logPath, sampleEntry);
    // Wait for the fire-and-forget write
    await new Promise((r) => setTimeout(r, 100));

    const content = await fsp.readFile(logPath, "utf8");
    const parsed = JSON.parse(content.trim());
    expect(parsed).toEqual(sampleEntry);
  });

  it("appends on subsequent calls", async () => {
    const dir = await makeTempDir();
    const logPath = path.join(dir, "analytics.jsonl");

    logAnalyticsEvent(logPath, sampleEntry);
    logAnalyticsEvent(logPath, { ...sampleEntry, q: "second query" });
    await new Promise((r) => setTimeout(r, 100));

    const lines = (await fsp.readFile(logPath, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1]!).q).toBe("second query");
  });

  it("creates parent directories if missing", async () => {
    const dir = await makeTempDir();
    const logPath = path.join(dir, "nested", "dir", "analytics.jsonl");

    logAnalyticsEvent(logPath, sampleEntry);
    await new Promise((r) => setTimeout(r, 100));

    expect(fs.existsSync(logPath)).toBe(true);
  });

  it("does not throw on non-writable path", () => {
    // Should not throw — errors are swallowed
    expect(() => {
      logAnalyticsEvent("/nonexistent-root/analytics.jsonl", sampleEntry);
    }).not.toThrow();
  });
});

describe("readAnalyticsLog", () => {
  it("reads all valid entries", async () => {
    const dir = await makeTempDir();
    const logPath = path.join(dir, "analytics.jsonl");

    const entries = [
      sampleEntry,
      { ...sampleEntry, q: "another", results: 0, latencyMs: 50 }
    ];
    await fsp.writeFile(logPath, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");

    const result = [];
    for await (const entry of readAnalyticsLog(logPath)) {
      result.push(entry);
    }
    expect(result).toHaveLength(2);
    expect(result[0]!.q).toBe("test query");
    expect(result[1]!.results).toBe(0);
  });

  it("skips malformed lines", async () => {
    const dir = await makeTempDir();
    const logPath = path.join(dir, "analytics.jsonl");

    const content = [
      JSON.stringify(sampleEntry),
      "not json",
      '{"ts":"2026-04-01","q":123}', // wrong type for q (number instead of string)
      "",
      JSON.stringify({ ...sampleEntry, q: "valid" })
    ].join("\n") + "\n";
    await fsp.writeFile(logPath, content);

    const result = [];
    for await (const entry of readAnalyticsLog(logPath)) {
      result.push(entry);
    }
    expect(result).toHaveLength(2);
    expect(result[0]!.q).toBe("test query");
    expect(result[1]!.q).toBe("valid");
  });

  it("returns empty for non-existent file", async () => {
    const result = [];
    for await (const entry of readAnalyticsLog("/nonexistent/path.jsonl")) {
      result.push(entry);
    }
    expect(result).toHaveLength(0);
  });
});

describe("computeReport", () => {
  it("computes top queries sorted by count", () => {
    const entries: AnalyticsEntry[] = [
      { ts: "2026-04-01T12:00:00Z", q: "alpha", results: 3, latencyMs: 100 },
      { ts: "2026-04-01T12:01:00Z", q: "beta", results: 2, latencyMs: 200 },
      { ts: "2026-04-01T12:02:00Z", q: "alpha", results: 1, latencyMs: 150 },
      { ts: "2026-04-01T12:03:00Z", q: "alpha", results: 4, latencyMs: 80 }
    ];

    const report = computeReport(entries);
    expect(report.topQueries[0]).toEqual({ q: "alpha", count: 3 });
    expect(report.topQueries[1]).toEqual({ q: "beta", count: 1 });
  });

  it("computes zero-result queries only", () => {
    const entries: AnalyticsEntry[] = [
      { ts: "2026-04-01T12:00:00Z", q: "found", results: 3, latencyMs: 100 },
      { ts: "2026-04-01T12:01:00Z", q: "missing", results: 0, latencyMs: 200 },
      { ts: "2026-04-01T12:02:00Z", q: "missing", results: 0, latencyMs: 150 },
      { ts: "2026-04-01T12:03:00Z", q: "also-missing", results: 0, latencyMs: 80 }
    ];

    const report = computeReport(entries);
    expect(report.zeroResultQueries).toHaveLength(2);
    expect(report.zeroResultQueries[0]).toEqual({ q: "missing", count: 2 });
    expect(report.zeroResultQueries[1]).toEqual({ q: "also-missing", count: 1 });
  });

  it("groups daily volume by date", () => {
    const entries: AnalyticsEntry[] = [
      { ts: "2026-04-01T12:00:00Z", q: "a", results: 1, latencyMs: 100 },
      { ts: "2026-04-01T18:00:00Z", q: "b", results: 1, latencyMs: 100 },
      { ts: "2026-04-02T06:00:00Z", q: "c", results: 1, latencyMs: 100 }
    ];

    const report = computeReport(entries);
    expect(report.dailyVolume).toEqual([
      { date: "2026-04-01", count: 2 },
      { date: "2026-04-02", count: 1 }
    ]);
  });

  it("computes latency percentiles with linear interpolation", () => {
    // 10 values: 10, 20, 30, 40, 50, 60, 70, 80, 90, 100
    const entries: AnalyticsEntry[] = Array.from({ length: 10 }, (_, i) => ({
      ts: "2026-04-01T12:00:00Z",
      q: "test",
      results: 1,
      latencyMs: (i + 1) * 10
    }));

    const report = computeReport(entries);
    // p50: index = 0.5 * 9 = 4.5 → interpolate 50 and 60 → 55
    expect(report.latency.p50).toBe(55);
    // p95: index = 0.95 * 9 = 8.55 → interpolate 90 and 100 → 95.5 → rounded
    expect(report.latency.p95).toBe(95);
    expect(report.latency.count).toBe(10);
  });

  it("handles empty entries", () => {
    const report = computeReport([]);
    expect(report.topQueries).toEqual([]);
    expect(report.zeroResultQueries).toEqual([]);
    expect(report.dailyVolume).toEqual([]);
    expect(report.latency).toEqual({ p50: 0, p95: 0, p99: 0, count: 0 });
  });

  it("handles single entry", () => {
    const entries: AnalyticsEntry[] = [
      { ts: "2026-04-01T12:00:00Z", q: "solo", results: 3, latencyMs: 42 }
    ];

    const report = computeReport(entries);
    expect(report.latency.p50).toBe(42);
    expect(report.latency.p95).toBe(42);
    expect(report.latency.p99).toBe(42);
  });
});
