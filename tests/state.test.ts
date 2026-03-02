import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureStateDirs } from "../src/core/state";
import type { Scope } from "../src/types";

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
  it("creates state directory", async () => {
    const cwd = await makeTempDir();
    const { statePath } = ensureStateDirs(cwd, ".searchsocket", scope);
    expect(fs.existsSync(statePath)).toBe(true);
  });
});
