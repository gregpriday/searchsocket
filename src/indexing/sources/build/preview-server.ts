import net from "node:net";
import path from "node:path";
import fs from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { SearchSocketError } from "../../../errors";
import { Logger } from "../../../core/logger";

export interface PreviewServer {
  baseUrl: string;
  port: number;
  shutdown(): Promise<void>;
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close(() => reject(new Error("Failed to get port")));
        return;
      }
      const port = addr.port;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

async function waitForReady(url: string, timeout: number, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    // Check if process exited early
    if (child.exitCode !== null) {
      throw new SearchSocketError(
        "BUILD_SERVER_FAILED",
        `vite preview exited with code ${child.exitCode} before becoming ready.`
      );
    }

    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.status < 500) return;
    } catch {
      // Not ready yet
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new SearchSocketError(
    "BUILD_SERVER_FAILED",
    `vite preview did not become ready within ${timeout}ms. Check that \`vite build\` completed successfully.`
  );
}

export async function startPreviewServer(
  cwd: string,
  options: { previewTimeout: number },
  logger: Logger
): Promise<PreviewServer> {
  const viteBin = path.join(cwd, "node_modules", ".bin", "vite");
  if (!fs.existsSync(viteBin)) {
    throw new SearchSocketError(
      "BUILD_SERVER_FAILED",
      `vite binary not found at ${viteBin}. Ensure vite is installed.`
    );
  }

  const port = await findFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;

  logger.event("preview_server_starting", { port });

  const child = spawn(viteBin, ["preview", "--port", String(port), "--strictPort", "--host", "127.0.0.1"], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env }
  });

  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  const shutdown = async (): Promise<void> => {
    if (child.exitCode !== null) return;

    child.kill("SIGTERM");

    await Promise.race([
      new Promise<void>((resolve) => child.on("close", () => resolve())),
      new Promise<void>((resolve) => setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
        resolve();
      }, 3000))
    ]);
  };

  try {
    await waitForReady(baseUrl, options.previewTimeout, child);
  } catch (error) {
    await shutdown();
    if (stderr) {
      logger.warn(`vite preview stderr: ${stderr.slice(0, 500)}`);
    }
    throw error;
  }

  logger.event("preview_server_ready", { port, baseUrl });

  return { baseUrl, port, shutdown };
}
