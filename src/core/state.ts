import fs from "node:fs";
import path from "node:path";
import type { Scope } from "../types";

export function ensureStateDirs(cwd: string, stateDir: string, scope: Scope): {
  statePath: string;
  pagesPath: string;
} {
  const statePath = path.resolve(cwd, stateDir);
  const pagesPath = path.join(statePath, "pages", scope.scopeName);
  fs.mkdirSync(pagesPath, { recursive: true });
  return { statePath, pagesPath };
}
