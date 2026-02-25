import fs from "node:fs";
import path from "node:path";
import type { Scope } from "../types";

export function ensureStateDirs(cwd: string, stateDir: string, scope: Scope): {
  statePath: string;
} {
  const statePath = path.resolve(cwd, stateDir);
  fs.mkdirSync(statePath, { recursive: true });
  return { statePath };
}
