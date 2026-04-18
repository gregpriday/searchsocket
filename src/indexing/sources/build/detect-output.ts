import fs from "node:fs/promises";
import path from "node:path";

export type BuildAdapter = "vercel" | "cloudflare" | "node" | "netlify" | "static";

export interface DetectedBuildOutput {
  /** Adapter that produced the output, identified from marker files. */
  adapter: BuildAdapter;
  /** Absolute path to the prerendered HTML directory. */
  absolutePath: string;
  /** Path relative to cwd, for logging. */
  relativePath: string;
}

interface Candidate {
  adapter: BuildAdapter;
  dir: string;
  marker: string;
}

/**
 * Ordered list of prerendered-output locations we check for. Order matters:
 * Vercel/Cloudflare/Node have strict markers, so they win over the generic
 * `build/` fallback (which could itself be adapter-static or adapter-netlify).
 */
const CANDIDATES: Candidate[] = [
  { adapter: "vercel",     dir: ".vercel/output/static", marker: ".vercel/output/config.json" },
  { adapter: "cloudflare", dir: ".svelte-kit/cloudflare", marker: ".svelte-kit/cloudflare/_worker.js" },
  { adapter: "node",       dir: "build/prerendered", marker: "build/handler.js" },
  { adapter: "netlify",    dir: "build", marker: ".netlify/server" },
];

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Detect where the site's prerendered HTML lives by looking for
 * adapter-specific marker files. Returns null if no known output is found.
 *
 * `staticDir` is the configured static-output directory (default `build`),
 * used as the final adapter-static fallback when it contains an index.html
 * but no other adapter marker is present.
 */
export async function detectBuildOutput(
  cwd: string,
  staticDir: string = "build"
): Promise<DetectedBuildOutput | null> {
  for (const candidate of CANDIDATES) {
    if (await exists(path.resolve(cwd, candidate.marker))) {
      const absolutePath = path.resolve(cwd, candidate.dir);
      if (await exists(absolutePath)) {
        return {
          adapter: candidate.adapter,
          absolutePath,
          relativePath: candidate.dir
        };
      }
    }
  }

  const staticAbs = path.resolve(cwd, staticDir);
  if (await exists(path.join(staticAbs, "index.html"))) {
    return {
      adapter: "static",
      absolutePath: staticAbs,
      relativePath: staticDir
    };
  }

  return null;
}
