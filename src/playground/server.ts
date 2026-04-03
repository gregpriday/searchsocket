import express from "express";
import type { Request, Response } from "express";
import type { AddressInfo } from "node:net";
import { SearchEngine } from "../search/engine";
import { loadConfig } from "../config/load";
import type { ResolvedSearchSocketConfig } from "../types";
import playgroundHtml from "./playground.html";

export interface PlaygroundServerOptions {
  cwd?: string;
  configPath?: string;
  config?: ResolvedSearchSocketConfig;
  port?: number;
}

export async function runPlaygroundServer(
  options: PlaygroundServerOptions
): Promise<{ port: number; close: () => Promise<void> }> {
  const config = options.config ?? await loadConfig({
    cwd: options.cwd,
    configPath: options.configPath
  });

  let engine: SearchEngine | null = null;

  async function getEngine(): Promise<SearchEngine> {
    if (!engine) {
      engine = await SearchEngine.create({
        cwd: options.cwd,
        configPath: options.configPath,
        config
      });
    }
    return engine;
  }

  const app = express();
  app.use(express.json());

  app.get("/_searchsocket", (_req: Request, res: Response) => {
    res.type("html").send(playgroundHtml);
  });

  app.post("/_searchsocket/search", async (req: Request, res: Response) => {
    try {
      const searchEngine = await getEngine();
      const body = req.body as Record<string, unknown>;

      if (!body || typeof body.q !== "string" || body.q.trim().length === 0) {
        res.status(400).json({ error: "Missing or empty 'q' field" });
        return;
      }

      const result = await searchEngine.search({
        q: body.q as string,
        topK: typeof body.topK === "number" ? body.topK : undefined,
        scope: typeof body.scope === "string" ? body.scope : undefined,
        pathPrefix: typeof body.pathPrefix === "string" ? body.pathPrefix : undefined,
        tags: Array.isArray(body.tags) ? body.tags : undefined,
        groupBy: body.groupBy === "page" || body.groupBy === "chunk" ? body.groupBy : undefined,
        debug: body.debug === true
      });

      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Internal server error";
      const status = (error as { statusCode?: number }).statusCode ?? 500;
      res.status(status).json({ error: message });
    }
  });

  const preferredPort = options.port ?? 3337;

  function startServer(port: number): Promise<{ port: number; close: () => Promise<void> }> {
    return new Promise((resolve, reject) => {
      let httpServer: ReturnType<typeof app.listen>;
      const onListening = () => {
        const addr = httpServer.address() as AddressInfo;
        resolve({
          port: addr.port,
          close: () => new Promise<void>((r) => httpServer.close(() => r()))
        });
      };
      httpServer = app.listen(port, "127.0.0.1", onListening);
      httpServer.once("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE" && port !== 0) {
          startServer(0).then(resolve, reject);
        } else {
          reject(err);
        }
      });
    });
  }

  return startServer(preferredPort);
}
