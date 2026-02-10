import { DataType, MetricType, MilvusClient } from "@zilliz/milvus2-sdk-node";
import type { QueryOpts, Scope, ScopeInfo, VectorHit, VectorRecord, VectorStore } from "../types";
import { safeJsonParse } from "../utils/text";

export interface MilvusVectorStoreOptions {
  address: string;
  token?: string;
  username?: string;
  password?: string;
  collectionName: string;
  registryCollectionName: string;
  client?: MilvusLikeClient;
}

interface MilvusLikeClient {
  hasCollection(input: { collection_name: string }): Promise<{ value: boolean | Boolean }>;
  createCollection(input: Record<string, unknown>): Promise<unknown>;
  createIndex(input: Record<string, unknown>): Promise<unknown>;
  loadCollection(input: { collection_name: string }): Promise<unknown>;
  upsert(input: { collection_name: string; data: any[] }): Promise<unknown>;
  search(input: Record<string, unknown>): Promise<{ results?: any[] }>;
  delete(input: { collection_name: string; ids?: string[]; filter?: string }): Promise<unknown>;
  query(input: {
    collection_name: string;
    filter?: string;
    output_fields?: string[];
    limit?: number;
    offset?: number;
  }): Promise<{ data: any[] }>;
  showCollections(): Promise<unknown>;
}

interface MilvusCollectionSchema {
  id: string;
  embedding: number[];
  projectId: string;
  scopeName: string;
  url: string;
  path: string;
  title: string;
  sectionTitle: string;
  headingPath: string;
  snippet: string;
  contentHash: string;
  modelId: string;
  depth: number;
  incomingLinks: number;
  routeFile: string;
  tags: string;
}

function quote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export class MilvusVectorStore implements VectorStore {
  private readonly client: MilvusLikeClient;
  private readonly collectionName: string;
  private readonly registryCollectionName: string;
  private initialized = false;
  private registryInitialized = false;
  private vectorDimension?: number;

  constructor(options: MilvusVectorStoreOptions) {
    this.client =
      options.client ??
      (new MilvusClient({
        address: options.address,
        token: options.token,
        username: options.username,
        password: options.password,
        ssl: options.address.startsWith("https://")
      }) as unknown as MilvusLikeClient);

    this.collectionName = options.collectionName;
    this.registryCollectionName = options.registryCollectionName;
  }

  async upsert(records: VectorRecord[], _scope: Scope): Promise<void> {
    if (records.length === 0) {
      return;
    }

    const first = records[0];
    if (!first) {
      return;
    }

    await this.ensureChunkCollection(first.vector.length);

    const payload: MilvusCollectionSchema[] = records.map((record) => ({
      id: record.id,
      embedding: record.vector,
      projectId: record.metadata.projectId,
      scopeName: record.metadata.scopeName,
      url: record.metadata.url,
      path: record.metadata.path,
      title: record.metadata.title,
      sectionTitle: record.metadata.sectionTitle,
      headingPath: JSON.stringify(record.metadata.headingPath),
      snippet: record.metadata.snippet,
      contentHash: record.metadata.contentHash,
      modelId: record.metadata.modelId,
      depth: record.metadata.depth,
      incomingLinks: record.metadata.incomingLinks,
      routeFile: record.metadata.routeFile,
      tags: JSON.stringify(record.metadata.tags)
    }));

    await this.client.upsert({
      collection_name: this.collectionName,
      data: payload as unknown as any[]
    });
  }

  async query(queryVector: number[], opts: QueryOpts, scope: Scope): Promise<VectorHit[]> {
    await this.ensureChunkCollection(queryVector.length);

    const exprParts = [
      `projectId == ${quote(scope.projectId)}`,
      `scopeName == ${quote(scope.scopeName)}`
    ];

    if (opts.pathPrefix) {
      const normalizedPrefix = opts.pathPrefix.startsWith("/") ? opts.pathPrefix : `/${opts.pathPrefix}`;
      const prefix = normalizedPrefix.endsWith("/") ? normalizedPrefix : `${normalizedPrefix}/`;
      const exact = normalizedPrefix.replace(/\/$/, "");
      exprParts.push(`(path == ${quote(exact)} or path like ${quote(`${prefix}%`)})`);
    }

    for (const tag of opts.tags ?? []) {
      exprParts.push(`tags like ${quote(`%\"${tag}\"%`)}`);
    }

    const result = await this.client.search({
      collection_name: this.collectionName,
      anns_field: "embedding",
      data: [queryVector],
      limit: opts.topK,
      metric_type: MetricType.COSINE,
      filter: exprParts.join(" and "),
      output_fields: [
        "id",
        "projectId",
        "scopeName",
        "url",
        "path",
        "title",
        "sectionTitle",
        "headingPath",
        "snippet",
        "contentHash",
        "modelId",
        "depth",
        "incomingLinks",
        "routeFile",
        "tags"
      ]
    });

    const hits = (result.results ?? []) as Array<
      MilvusCollectionSchema & {
        score: number;
      }
    >;

    return hits.map((hit) => ({
      id: hit.id,
      score: hit.score,
      metadata: {
        projectId: hit.projectId,
        scopeName: hit.scopeName,
        url: hit.url,
        path: hit.path,
        title: hit.title,
        sectionTitle: hit.sectionTitle,
        headingPath: safeJsonParse<string[]>(hit.headingPath, []),
        snippet: hit.snippet,
        contentHash: hit.contentHash,
        modelId: hit.modelId,
        depth: Number(hit.depth),
        incomingLinks: Number(hit.incomingLinks),
        routeFile: hit.routeFile,
        tags: safeJsonParse<string[]>(hit.tags, [])
      }
    }));
  }

  async deleteByIds(ids: string[], _scope: Scope): Promise<void> {
    if (ids.length === 0) {
      return;
    }

    await this.ensureChunkCollection(this.vectorDimension ?? 1536);

    await this.client.delete({
      collection_name: this.collectionName,
      ids
    });
  }

  async deleteScope(scope: Scope): Promise<void> {
    await this.ensureChunkCollection(this.vectorDimension ?? 1536);

    await this.client.delete({
      collection_name: this.collectionName,
      filter: `projectId == ${quote(scope.projectId)} and scopeName == ${quote(scope.scopeName)}`
    });

    await this.ensureRegistryCollection();
    await this.client.delete({
      collection_name: this.registryCollectionName,
      ids: [`${scope.projectId}:${scope.scopeName}`]
    });
  }

  async listScopes(scopeProjectId: string): Promise<ScopeInfo[]> {
    await this.ensureRegistryCollection();

    const PAGE_SIZE = 1_000;
    const allRows: Array<{
      projectId: string;
      scopeName: string;
      modelId: string;
      lastIndexedAt: string;
      vectorCount: number;
    }> = [];

    let offset = 0;
    while (true) {
      const response = await this.client.query({
        collection_name: this.registryCollectionName,
        filter: `projectId == ${quote(scopeProjectId)}`,
        output_fields: ["projectId", "scopeName", "modelId", "lastIndexedAt", "vectorCount"],
        limit: PAGE_SIZE,
        offset
      });

      const rows = response.data as typeof allRows;
      allRows.push(...rows);

      if (rows.length < PAGE_SIZE) {
        break;
      }

      offset += PAGE_SIZE;
      // Safety: prevent runaway pagination
      if (offset >= 100_000) {
        break;
      }
    }

    return allRows.map((row) => ({
      projectId: row.projectId,
      scopeName: row.scopeName,
      modelId: row.modelId,
      lastIndexedAt: row.lastIndexedAt,
      vectorCount: Number(row.vectorCount)
    }));
  }

  async recordScope(info: ScopeInfo): Promise<void> {
    await this.ensureRegistryCollection();

    await this.client.upsert({
      collection_name: this.registryCollectionName,
      data: [
        {
          id: `${info.projectId}:${info.scopeName}`,
          projectId: info.projectId,
          scopeName: info.scopeName,
          modelId: info.modelId,
          lastIndexedAt: info.lastIndexedAt,
          vectorCount: info.vectorCount ?? 0
        }
      ]
    });
  }

  async health(): Promise<{ ok: boolean; details?: string }> {
    try {
      await this.client.showCollections();
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        details: error instanceof Error ? error.message : "Milvus connection error"
      };
    }
  }

  private async ensureChunkCollection(dimension: number): Promise<void> {
    if (this.initialized && this.vectorDimension === dimension) {
      return;
    }

    this.vectorDimension = dimension;
    const has = await this.client.hasCollection({ collection_name: this.collectionName });
    if (!has.value) {
      await this.client.createCollection({
        collection_name: this.collectionName,
        enable_dynamic_field: false,
        fields: [
          {
            name: "id",
            data_type: DataType.VarChar,
            is_primary_key: true,
            max_length: 256
          },
          {
            name: "embedding",
            data_type: DataType.FloatVector,
            dim: dimension
          },
          {
            name: "projectId",
            data_type: DataType.VarChar,
            max_length: 256
          },
          {
            name: "scopeName",
            data_type: DataType.VarChar,
            max_length: 256
          },
          {
            name: "url",
            data_type: DataType.VarChar,
            max_length: 2048
          },
          {
            name: "path",
            data_type: DataType.VarChar,
            max_length: 2048
          },
          {
            name: "title",
            data_type: DataType.VarChar,
            max_length: 2048
          },
          {
            name: "sectionTitle",
            data_type: DataType.VarChar,
            max_length: 2048
          },
          {
            name: "headingPath",
            data_type: DataType.VarChar,
            max_length: 8192
          },
          {
            name: "snippet",
            data_type: DataType.VarChar,
            max_length: 8192
          },
          {
            name: "contentHash",
            data_type: DataType.VarChar,
            max_length: 128
          },
          {
            name: "modelId",
            data_type: DataType.VarChar,
            max_length: 256
          },
          {
            name: "depth",
            data_type: DataType.Int64
          },
          {
            name: "incomingLinks",
            data_type: DataType.Int64
          },
          {
            name: "routeFile",
            data_type: DataType.VarChar,
            max_length: 2048
          },
          {
            name: "tags",
            data_type: DataType.VarChar,
            max_length: 4096
          }
        ]
      });

      await this.client.createIndex({
        collection_name: this.collectionName,
        field_name: "embedding",
        index_name: "embedding_index",
        index_type: "AUTOINDEX",
        metric_type: MetricType.COSINE
      });
    }

    await this.client.loadCollection({
      collection_name: this.collectionName
    });

    this.initialized = true;
  }

  private async ensureRegistryCollection(): Promise<void> {
    if (this.registryInitialized) {
      return;
    }

    const has = await this.client.hasCollection({ collection_name: this.registryCollectionName });
    if (!has.value) {
      await this.client.createCollection({
        collection_name: this.registryCollectionName,
        enable_dynamic_field: false,
        fields: [
          {
            name: "id",
            data_type: DataType.VarChar,
            is_primary_key: true,
            max_length: 256
          },
          {
            name: "projectId",
            data_type: DataType.VarChar,
            max_length: 256
          },
          {
            name: "scopeName",
            data_type: DataType.VarChar,
            max_length: 256
          },
          {
            name: "modelId",
            data_type: DataType.VarChar,
            max_length: 256
          },
          {
            name: "lastIndexedAt",
            data_type: DataType.VarChar,
            max_length: 128
          },
          {
            name: "vectorCount",
            data_type: DataType.Int64
          }
        ]
      });
    }

    await this.client.loadCollection({ collection_name: this.registryCollectionName });
    this.registryInitialized = true;
  }
}
