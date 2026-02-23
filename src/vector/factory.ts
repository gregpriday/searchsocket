import fs from "node:fs";
import path from "node:path";
import type { ResolvedSearchSocketConfig, VectorStore } from "../types";
import { TursoVectorStore } from "./turso";

export async function createVectorStore(config: ResolvedSearchSocketConfig, cwd: string): Promise<VectorStore> {
  const turso = config.vector.turso;
  const remoteUrl = process.env[turso.urlEnv];

  if (remoteUrl) {
    const authToken = process.env[turso.authTokenEnv];
    return new TursoVectorStore({
      url: remoteUrl,
      authToken,
      dimension: config.vector.dimension
    });
  }

  const localPath = path.resolve(cwd, turso.localPath);
  fs.mkdirSync(path.dirname(localPath), { recursive: true });
  return new TursoVectorStore({
    url: `file:${localPath}`,
    dimension: config.vector.dimension
  });
}
