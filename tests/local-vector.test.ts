import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LocalVectorStore } from "../src/vector/local";
import type { Scope, VectorRecord } from "../src/types";

const scope: Scope = {
  projectId: "searchsocket-test",
  scopeName: "main",
  scopeId: "searchsocket-test:main"
};

function record(id: string, vector: number[], url: string, tags: string[]): VectorRecord {
  return {
    id,
    vector,
    metadata: {
      projectId: scope.projectId,
      scopeName: scope.scopeName,
      url,
      path: url,
      title: id,
      sectionTitle: "",
      headingPath: [],
      snippet: id,
      contentHash: id,
      modelId: "text-embedding-3-small",
      depth: url.split("/").filter(Boolean).length,
      incomingLinks: 0,
      routeFile: "src/routes/+page.svelte",
      tags
    }
  };
}

describe("LocalVectorStore", () => {
  it("supports query filtering by pathPrefix and tags", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "searchsocket-local-"));
    const dbPath = path.join(dir, "local-vectors.json");

    const store = new LocalVectorStore(dbPath);

    await store.upsert(
      [
        record("a", [1, 0, 0], "/docs/a", ["docs"]),
        record("b", [0.9, 0, 0], "/docs/b", ["guides"]),
        record("c", [0, 1, 0], "/blog/c", ["blog"])
      ],
      scope
    );

    const hits = await store.query([1, 0, 0], { topK: 10, pathPrefix: "/docs", tags: ["docs"] }, scope);

    expect(hits.length).toBe(1);
    expect(hits[0]?.metadata.url).toBe("/docs/a");
  });
});
