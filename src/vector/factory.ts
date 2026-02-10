import path from "node:path";
import type { ResolvedSearchSocketConfig, VectorStore } from "../types";
import { SearchSocketError } from "../errors";
import { PineconeVectorStore } from "./pinecone";
import { MilvusVectorStore } from "./milvus";
import { LocalVectorStore } from "./local";

export async function createVectorStore(config: ResolvedSearchSocketConfig, cwd: string): Promise<VectorStore> {
  if (config.vector.provider === "pinecone") {
    const apiKey = process.env[config.vector.pinecone.apiKeyEnv];

    if (!apiKey) {
      throw new SearchSocketError(
        "CONFIG_MISSING",
        `Pinecone API key env var ${config.vector.pinecone.apiKeyEnv} is not set.`
      );
    }

    return new PineconeVectorStore({
      apiKey,
      indexName: config.vector.pinecone.index,
      embeddingModel: config.embeddings.model,
      dimension: config.vector.dimension
    });
  }

  if (config.vector.provider === "local") {
    return new LocalVectorStore(path.resolve(cwd, config.vector.local.path));
  }

  if (config.vector.provider === "milvus") {
    const uri = process.env[config.vector.milvus.uriEnv];
    const token = process.env[config.vector.milvus.tokenEnv];

    if (!uri) {
      throw new SearchSocketError(
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

  throw new SearchSocketError("VECTOR_BACKEND_UNAVAILABLE", `Unsupported vector provider: ${config.vector.provider}`);
}
