import fs from "node:fs";
import path from "node:path";
import type { ManifestFile, RegistryFile, Scope, ScopeInfo, ScopeManifest } from "../types";

const MANIFEST_VERSION = 1;
const REGISTRY_VERSION = 1;

export function ensureStateDirs(cwd: string, stateDir: string, scope: Scope): {
  statePath: string;
  pagesPath: string;
} {
  const statePath = path.resolve(cwd, stateDir);
  const pagesPath = path.join(statePath, "pages", scope.scopeName);
  fs.mkdirSync(pagesPath, { recursive: true });
  return { statePath, pagesPath };
}

export function readManifest(statePath: string): ManifestFile {
  const target = path.join(statePath, "manifest.json");

  if (!fs.existsSync(target)) {
    return {
      version: MANIFEST_VERSION,
      scopes: {}
    };
  }

  return JSON.parse(fs.readFileSync(target, "utf8")) as ManifestFile;
}

export function writeManifest(statePath: string, manifest: ManifestFile): void {
  const target = path.join(statePath, "manifest.json");
  fs.writeFileSync(target, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

export function getScopeManifest(manifest: ManifestFile, scope: Scope, modelId: string): ScopeManifest {
  const found = manifest.scopes[scope.scopeName];
  if (found) {
    return found;
  }

  const created: ScopeManifest = {
    projectId: scope.projectId,
    scopeName: scope.scopeName,
    embeddingModel: modelId,
    chunks: {}
  };

  manifest.scopes[scope.scopeName] = created;
  return created;
}

export function readRegistry(statePath: string): RegistryFile {
  const target = path.join(statePath, "registry.json");

  if (!fs.existsSync(target)) {
    return {
      version: REGISTRY_VERSION,
      scopes: []
    };
  }

  return JSON.parse(fs.readFileSync(target, "utf8")) as RegistryFile;
}

export function writeRegistry(statePath: string, registry: RegistryFile): void {
  const target = path.join(statePath, "registry.json");
  fs.writeFileSync(target, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
}

export function upsertRegistryScope(statePath: string, info: ScopeInfo): void {
  const registry = readRegistry(statePath);
  const existingIndex = registry.scopes.findIndex(
    (scope) => scope.projectId === info.projectId && scope.scopeName === info.scopeName
  );

  if (existingIndex >= 0) {
    registry.scopes[existingIndex] = info;
  } else {
    registry.scopes.push(info);
  }

  writeRegistry(statePath, registry);
}
