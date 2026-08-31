export interface RetrievalEmbeddingFingerprint {
  provider: string;
  model: string;
  endpointContract: string;
  dimensions: number;
}

export interface RetrievalFingerprint {
  schemaVersion: number;
  chunker: {
    id: string;
    version: number;
    configurationHash: string;
  };
  embedding: RetrievalEmbeddingFingerprint | null;
  recordSchemaVersion: number;
  relationSchemaVersion: number;
}

export type RetrievalFingerprintDisposition =
  | "compatible"
  | "initialize"
  | "rebuild_required";
