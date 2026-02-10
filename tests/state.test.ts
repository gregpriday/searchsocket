import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensureStateDirs,
  readManifest,
  writeManifest,
  getScopeManifest,
  readRegistry,
  upsertRegistryScope
} from "../src/core/state";
import type { Scope, ScopeInfo } from "../src/types";

const tempDirs: string[] = [];
const scope: Scope = {
  projectId: "test",
  scopeName: "main",
  scopeId: "test:main"
};

async function makeTempDir(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "searchsocket-state-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => fsp.rm(d, { recursive: true, force: true })));
});

describe("ensureStateDirs", () => {
  it("creates state and pages directories", async () => {
    const cwd = await makeTempDir();
    const { statePath, pagesPath } = ensureStateDirs(cwd, ".searchsocket", scope);
    expect(fs.existsSync(statePath)).toBe(true);
    expect(fs.existsSync(pagesPath)).toBe(true);
    expect(pagesPath).toContain("pages/main");
  });
});

describe("manifest", () => {
  it("returns empty manifest when file missing", async () => {
    const cwd = await makeTempDir();
    const manifest = readManifest(cwd);
    expect(manifest.version).toBe(1);
    expect(Object.keys(manifest.scopes)).toHaveLength(0);
  });

  it("round-trips write and read", async () => {
    const cwd = await makeTempDir();
    const manifest = readManifest(cwd);
    const scopeManifest = getScopeManifest(manifest, scope, "text-embedding-3-small");
    scopeManifest.chunks["key1"] = { contentHash: "abc", url: "/test" };
    writeManifest(cwd, manifest);

    const reloaded = readManifest(cwd);
    expect(reloaded.scopes["main"]?.chunks["key1"]?.contentHash).toBe("abc");
  });
});

describe("registry", () => {
  it("returns empty registry when file missing", async () => {
    const cwd = await makeTempDir();
    const registry = readRegistry(cwd);
    expect(registry.version).toBe(1);
    expect(registry.scopes).toHaveLength(0);
  });

  it("upserts and reads scopes", async () => {
    const cwd = await makeTempDir();
    const info: ScopeInfo = {
      projectId: "test",
      scopeName: "main",
      modelId: "text-embedding-3-small",
      lastIndexedAt: "2026-01-01T00:00:00.000Z",
      vectorCount: 42
    };

    upsertRegistryScope(cwd, info);
    const registry = readRegistry(cwd);
    expect(registry.scopes).toHaveLength(1);
    expect(registry.scopes[0]?.vectorCount).toBe(42);

    // Update same scope
    info.vectorCount = 100;
    upsertRegistryScope(cwd, info);
    const updated = readRegistry(cwd);
    expect(updated.scopes).toHaveLength(1);
    expect(updated.scopes[0]?.vectorCount).toBe(100);
  });
});
