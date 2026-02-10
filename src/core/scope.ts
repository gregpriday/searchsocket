import { execSync } from "node:child_process";
import type { ResolvedSearchSocketConfig, Scope } from "../types";
import { sanitizeScopeName } from "../utils/text";

function resolveRawScopeName(config: ResolvedSearchSocketConfig): string {
  if (config.scope.mode === "fixed") {
    return config.scope.fixed;
  }

  if (config.scope.mode === "env") {
    const value = process.env[config.scope.envVar];
    if (!value) {
      throw new Error(`Scope mode is env but ${config.scope.envVar} is not set.`);
    }

    return value;
  }

  try {
    return execSync("git rev-parse --abbrev-ref HEAD", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    return config.scope.fixed;
  }
}

export function resolveScope(config: ResolvedSearchSocketConfig, override?: string): Scope {
  const rawName = override ?? resolveRawScopeName(config);
  const scopeName = config.scope.sanitize ? sanitizeScopeName(rawName) : rawName;

  return {
    projectId: config.project.id,
    scopeName,
    scopeId: `${config.project.id}:${scopeName}`
  };
}
