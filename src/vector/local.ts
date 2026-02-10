import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { QueryOpts, Scope, ScopeInfo, VectorHit, VectorRecord, VectorStore } from "../types";

function vectorToBase64(vector: number[]): string {
  const typed = Float32Array.from(vector);
  return Buffer.from(typed.buffer).toString("base64");
}

function base64ToVector(b64: string): number[] {
  const buf = Buffer.from(b64, "base64");
  const copied = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return Array.from(new Float32Array(copied));
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;

  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const aVal = a[i] ?? 0;
    const bVal = b[i] ?? 0;
    dot += aVal * bVal;
    normA += aVal * aVal;
    normB += bVal * bVal;
  }

  if (!normA || !normB) {
    return 0;
  }

  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

interface StoredVector {
  projectId: string;
  scopeName: string;
  url: string;
  path: string;
  title: string;
  sectionTitle: string;
  headingPath: string[];
  snippet: string;
  contentHash: string;
  modelId: string;
  depth: number;
  incomingLinks: number;
  routeFile: string;
  tags: string[];
  /** base64-encoded Float32Array */
  vector: string;
}

interface StoreData {
  version: 1;
  vectors: Record<string, StoredVector>;
  registry: Record<string, ScopeInfo>;
}

const LOCAL_STORE_WARN_THRESHOLD = 5_000;

export class LocalVectorStore implements VectorStore {
  private readonly filePath: string;
  private data: StoreData;
  private sizeWarningEmitted = false;

  constructor(filePath: string) {
    this.filePath = path.resolve(filePath);
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });

    if (fs.existsSync(this.filePath)) {
      this.data = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as StoreData;
      this.checkSize();
    } else {
      this.data = { version: 1, vectors: {}, registry: {} };
    }
  }

  private checkSize(): void {
    if (this.sizeWarningEmitted) {
      return;
    }
    const count = Object.keys(this.data.vectors).length;
    if (count >= LOCAL_STORE_WARN_THRESHOLD) {
      process.stderr.write(
        `warning: local vector store has ${count} vectors. ` +
        "Performance may degrade for large sites. " +
        "Consider switching to Pinecone or Milvus (vector.provider in config).\n"
      );
      this.sizeWarningEmitted = true;
    }
  }

  async upsert(records: VectorRecord[], scope: Scope): Promise<void> {
    if (records.length === 0) {
      return;
    }

    for (const item of records) {
      this.data.vectors[item.id] = {
        projectId: item.metadata.projectId,
        scopeName: scope.scopeName,
        url: item.metadata.url,
        path: item.metadata.path,
        title: item.metadata.title,
        sectionTitle: item.metadata.sectionTitle,
        headingPath: item.metadata.headingPath,
        snippet: item.metadata.snippet,
        contentHash: item.metadata.contentHash,
        modelId: item.metadata.modelId,
        depth: item.metadata.depth,
        incomingLinks: item.metadata.incomingLinks,
        routeFile: item.metadata.routeFile,
        tags: item.metadata.tags,
        vector: vectorToBase64(item.vector)
      };
    }

    this.save();
    this.checkSize();
  }

  async query(queryVector: number[], opts: QueryOpts, scope: Scope): Promise<VectorHit[]> {
    const tagSet = new Set(opts.tags ?? []);

    const hits: VectorHit[] = [];

    for (const [id, stored] of Object.entries(this.data.vectors)) {
      if (stored.projectId !== scope.projectId || stored.scopeName !== scope.scopeName) {
        continue;
      }

      if (opts.pathPrefix) {
        const rawPrefix = opts.pathPrefix.startsWith("/") ? opts.pathPrefix : `/${opts.pathPrefix}`;
        const prefix = rawPrefix.endsWith("/") ? rawPrefix : `${rawPrefix}/`;
        const normalizedPath = stored.path.replace(/\/$/, "");
        const normalizedPrefix = rawPrefix.replace(/\/$/, "");
        if (normalizedPath !== normalizedPrefix && !stored.path.startsWith(prefix)) {
          continue;
        }
      }

      if (tagSet.size > 0) {
        if (![...tagSet].every((tag) => stored.tags.includes(tag))) {
          continue;
        }
      }

      const vector = base64ToVector(stored.vector);
      const score = cosineSimilarity(queryVector, vector);

      hits.push({
        id,
        score,
        metadata: {
          projectId: stored.projectId,
          scopeName: stored.scopeName,
          url: stored.url,
          path: stored.path,
          title: stored.title,
          sectionTitle: stored.sectionTitle,
          headingPath: stored.headingPath,
          snippet: stored.snippet,
          contentHash: stored.contentHash,
          modelId: stored.modelId,
          depth: stored.depth,
          incomingLinks: stored.incomingLinks,
          routeFile: stored.routeFile,
          tags: stored.tags
        }
      });
    }

    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, opts.topK);
  }

  async deleteByIds(ids: string[], scope: Scope): Promise<void> {
    if (ids.length === 0) {
      return;
    }

    const idSet = new Set(ids);
    for (const id of idSet) {
      const stored = this.data.vectors[id];
      if (stored && stored.projectId === scope.projectId && stored.scopeName === scope.scopeName) {
        delete this.data.vectors[id];
      }
    }

    this.save();
  }

  async deleteScope(scope: Scope): Promise<void> {
    for (const [id, stored] of Object.entries(this.data.vectors)) {
      if (stored.projectId === scope.projectId && stored.scopeName === scope.scopeName) {
        delete this.data.vectors[id];
      }
    }

    const registryKey = `${scope.projectId}:${scope.scopeName}`;
    delete this.data.registry[registryKey];

    this.save();
  }

  async listScopes(scopeProjectId: string): Promise<ScopeInfo[]> {
    return Object.values(this.data.registry).filter((info) => info.projectId === scopeProjectId);
  }

  async recordScope(info: ScopeInfo): Promise<void> {
    const key = `${info.projectId}:${info.scopeName}`;
    this.data.registry[key] = info;
    this.save();
  }

  async health(): Promise<{ ok: boolean; details?: string }> {
    return { ok: true };
  }

  private save(): void {
    const tmpPath = `${this.filePath}.${randomUUID()}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(this.data), "utf8");
    fs.renameSync(tmpPath, this.filePath);
  }
}
