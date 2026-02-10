import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildRoutePatterns, mapUrlToRoute } from "../src/indexing/route-mapper";

const tempDirs: string[] = [];

async function makeTempProject(): Promise<string> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sitescribe-routes-"));
  tempDirs.push(tempDir);

  const files = [
    "src/routes/+page.svelte",
    "src/routes/docs/+page.svelte",
    "src/routes/docs/[slug]/+page.svelte"
  ];

  for (const file of files) {
    const target = path.join(tempDir, file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, "<main>route</main>\n", "utf8");
  }

  return tempDir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("route mapping", () => {
  it("maps urls to most specific +page.svelte file", async () => {
    const cwd = await makeTempProject();
    const patterns = await buildRoutePatterns(cwd);

    expect(mapUrlToRoute("/", patterns).routeFile).toBe("src/routes/+page.svelte");
    expect(mapUrlToRoute("/docs", patterns).routeFile).toBe("src/routes/docs/+page.svelte");
    expect(mapUrlToRoute("/docs/hello", patterns).routeFile).toBe("src/routes/docs/[slug]/+page.svelte");
  });
});
