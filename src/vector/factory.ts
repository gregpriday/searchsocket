import path from "node:path";
import type { ResolvedSiteScribeConfig, VectorStore } from "../types";
import { SiteScribeError } from "../errors";
import { LocalVectorStore } from "./local";
import { MilvusVectorStore } from "./milvus";
import { PineconeVectorStore } from "./pinecone";

export function createVectorStore(config: ResolvedSiteScribeConfig, cwd: string): VectorStore {
  if (config.vector.provider === "pinecone") {
    const apiKey = process.env[config.vector.pinecone.apiKeyEnv];

    if (!apiKey) {
      throw new SiteScribeError(
        "CONFIG_MISSING",
        `Pinecone API key env var ${config.vector.pinecone.apiKeyEnv} is not set.`
      );
    }

    return new PineconeVectorStore({
      apiKey,
      indexName: config.vector.pinecone.index,
      embeddingModel: config.embeddings.model
    });
  }

  if (config.vector.provider === "local") {
    return new LocalVectorStore(path.resolve(cwd, config.vector.local.path));
  }

  if (config.vector.provider === "milvus") {
    const uri = process.env[config.vector.milvus.uriEnv];
    const token = process.env[config.vector.milvus.tokenEnv];

    if (!uri) {
      throw new SiteScribeError(
        "CONFIG_MISSING",
        `Milvus URI env var ${config.vector.milvus.uriEnv} is not set.`
      );
    }

    return new MilvusVectorStore({
      address: uri,
      token,
      collectionName: config.vector.milvus.collection,
      registryCollectionName: `${config.project.id}_registry`
    });
  }

  throw new SiteScribeError("VECTOR_BACKEND_UNAVAILABLE", `Unsupported vector provider: ${config.vector.provider}`);
}
