import { EMBEDDING_DIM, EMBEDDING_MODEL } from "./embeddingConfig.js";
import {
  MAX_CODE_INDEX_CHUNK_CHARS,
  MAX_CODE_INDEX_EMBEDDING_CHARS,
} from "./chunkQuality.js";

import { CODE_INDEX_PATH_IDENTITY_VERSION } from "./codeIndexPaths.js";
import type { ChunkGranularity } from "./types.js";
import type { RetrievalFingerprint } from "@agentlink/protocol/retrieval-fingerprint";
import { createHash } from "crypto";

export { MAX_CODE_INDEX_EMBEDDING_CHARS } from "./chunkQuality.js";
export const CODE_INDEX_REBUILD_REQUIRED_ERROR =
  "Code index fingerprint mismatch requires a full re-index before incremental updates";

const CODE_INDEX_CHUNKER_ID = "agentlink-code-index-chunker";
// Bump for every output-affecting chunker, query, grammar, dependency, or dispatch change.
const CODE_INDEX_CHUNKER_VERSION = 2;
const CODE_INDEX_SCHEMA_VERSION = 1;
const CODE_INDEX_RECORD_SCHEMA_VERSION = 1;
const CODE_INDEX_RELATION_SCHEMA_VERSION = 2;
const CODE_INDEX_STORAGE_LAYOUT_VERSION = 2;

export function createCodeIndexFingerprint(
  granularity: ChunkGranularity,
): RetrievalFingerprint {
  return {
    schemaVersion: CODE_INDEX_SCHEMA_VERSION,
    recordSchemaVersion: CODE_INDEX_RECORD_SCHEMA_VERSION,
    relationSchemaVersion: CODE_INDEX_RELATION_SCHEMA_VERSION,
    chunker: {
      id: CODE_INDEX_CHUNKER_ID,
      version: CODE_INDEX_CHUNKER_VERSION,
      configurationHash: hashConfiguration({
        granularity,
        maxChunkChars: MAX_CODE_INDEX_CHUNK_CHARS,
        maxEmbeddingChars: MAX_CODE_INDEX_EMBEDDING_CHARS,
        pathIdentityVersion: CODE_INDEX_PATH_IDENTITY_VERSION,
        storageLayoutVersion: CODE_INDEX_STORAGE_LAYOUT_VERSION,
      }),
    },
    embedding: {
      provider: "openai",
      model: EMBEDDING_MODEL,
      endpointContract: "openai-embeddings-v1",
      dimensions: EMBEDDING_DIM,
    },
  };
}

function hashConfiguration(configuration: {
  granularity: ChunkGranularity;
  maxChunkChars: number;
  maxEmbeddingChars: number;
  pathIdentityVersion: number;
  storageLayoutVersion: number;
}): string {
  return createHash("sha256")
    .update(JSON.stringify(configuration))
    .digest("hex");
}
