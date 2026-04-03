import fs from "node:fs";
import path from "node:path";
import type { AnalyticsEntry } from "../types";

export function logAnalyticsEvent(logPath: string, entry: AnalyticsEntry): void {
  const line = JSON.stringify(entry) + "\n";
  const dir = path.dirname(logPath);

  fs.promises
    .mkdir(dir, { recursive: true })
    .then(() => fs.promises.appendFile(logPath, line, "utf8"))
    .catch(() => {});
}
