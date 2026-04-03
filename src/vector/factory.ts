import { SearchSocketError } from "../errors";
import type { ResolvedSearchSocketConfig } from "../types";
import { UpstashSearchStore } from "./upstash";

export async function createUpstashStore(config: ResolvedSearchSocketConfig): Promise<UpstashSearchStore> {
  const url = config.upstash.url ?? process.env[config.upstash.urlEnv];
  const token = config.upstash.token ?? process.env[config.upstash.tokenEnv];

  if (!url || !token) {
    throw new SearchSocketError(
      "VECTOR_BACKEND_UNAVAILABLE",
      `Missing Upstash Vector credentials. Set ${config.upstash.urlEnv} and ${config.upstash.tokenEnv} environment variables, ` +
        "or pass upstash.url and upstash.token in your config."
    );
  }

  const { Index } = await import("@upstash/vector");
  const index = new Index({ url, token });

  return new UpstashSearchStore({ index });
}
