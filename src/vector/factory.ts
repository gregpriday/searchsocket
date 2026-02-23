import fs from "node:fs";
import path from "node:path";
import { isServerless } from "../core/serverless";
import { SearchSocketError } from "../errors";
import type { ResolvedSearchSocketConfig, VectorStore } from "../types";
import { TursoVectorStore } from "./turso";

export async function createVectorStore(config: ResolvedSearchSocketConfig, cwd: string): Promise<VectorStore> {
  const turso = config.vector.turso;
  const remoteUrl = process.env[turso.urlEnv];

  if (remoteUrl) {
    // Use HTTP-only client for remote URLs — avoids native libsql/node:sqlite dependency.
    // This makes SearchSocket work on serverless platforms (Vercel, Cloudflare, etc.)
    // regardless of Node version.
    const { createClient } = await import("@libsql/client/http");
    const authToken = process.env[turso.authTokenEnv];
    const client = createClient({
      url: remoteUrl,
      authToken
    });
    return new TursoVectorStore({
      client,
      dimension: config.vector.dimension
    });
  }

  // Local file DB — uses native libsql addon (requires Node with native module support)
  if (isServerless()) {
    throw new SearchSocketError(
      "VECTOR_BACKEND_UNAVAILABLE",
      `No remote vector database URL found (checked env var "${turso.urlEnv}"). ` +
        "Local SQLite storage is not available in serverless environments. " +
        `Set ${turso.urlEnv} to your Turso database URL.`
    );
  }

  const { createClient } = await import("@libsql/client");
  const localPath = path.resolve(cwd, turso.localPath);
  fs.mkdirSync(path.dirname(localPath), { recursive: true });
  const client = createClient({
    url: `file:${localPath}`
  });
  return new TursoVectorStore({
    client,
    dimension: config.vector.dimension
  });
}
