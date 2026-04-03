import fs from "node:fs";
import { createReadStream } from "node:fs";
import readline from "node:readline";
import { z } from "zod";
import type { AnalyticsEntry, AnalyticsReport } from "../types";

const analyticsEntrySchema = z.object({
  ts: z.string(),
  q: z.string(),
  results: z.number(),
  latencyMs: z.number()
});

export async function* readAnalyticsLog(logPath: string): AsyncGenerator<AnalyticsEntry> {
  if (!fs.existsSync(logPath)) {
    return;
  }

  const rl = readline.createInterface({
    input: createReadStream(logPath, "utf8"),
    crlfDelay: Infinity
  });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      const parsed = JSON.parse(trimmed);
      const result = analyticsEntrySchema.safeParse(parsed);
      if (result.success) {
        yield result.data;
      }
    } catch {
      continue;
    }
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0]!;

  const i = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  const weight = i - lo;

  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * weight;
}

export function computeReport(entries: AnalyticsEntry[]): AnalyticsReport {
  const queryCounts = new Map<string, number>();
  const zeroResultCounts = new Map<string, number>();
  const dailyCounts = new Map<string, number>();
  const latencies: number[] = [];

  for (const entry of entries) {
    const q = entry.q.trim();

    queryCounts.set(q, (queryCounts.get(q) ?? 0) + 1);

    if (entry.results === 0) {
      zeroResultCounts.set(q, (zeroResultCounts.get(q) ?? 0) + 1);
    }

    const date = entry.ts.slice(0, 10);
    dailyCounts.set(date, (dailyCounts.get(date) ?? 0) + 1);

    latencies.push(entry.latencyMs);
  }

  const topQueries = [...queryCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([q, count]) => ({ q, count }));

  const zeroResultQueries = [...zeroResultCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([q, count]) => ({ q, count }));

  const dailyVolume = [...dailyCounts.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, count]) => ({ date, count }));

  const sorted = [...latencies].sort((a, b) => a - b);

  return {
    topQueries,
    zeroResultQueries,
    dailyVolume,
    latency: {
      p50: Math.round(percentile(sorted, 50)),
      p95: Math.round(percentile(sorted, 95)),
      p99: Math.round(percentile(sorted, 99)),
      count: latencies.length
    }
  };
}
