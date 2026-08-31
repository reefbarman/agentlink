import type {
  RetrievalEmbeddingFingerprint,
  RetrievalFingerprint,
  RetrievalFingerprintDisposition,
} from "./retrievalFingerprint.js";
import { expect, expectTypeOf, it } from "vitest";

it("pins retrieval fingerprint contracts", () => {
  expectTypeOf<RetrievalEmbeddingFingerprint>().toEqualTypeOf<{
    provider: string;
    model: string;
    endpointContract: string;
    dimensions: number;
  }>();
  expectTypeOf<RetrievalFingerprint>().toEqualTypeOf<{
    schemaVersion: number;
    chunker: {
      id: string;
      version: number;
      configurationHash: string;
    };
    embedding: RetrievalEmbeddingFingerprint | null;
    recordSchemaVersion: number;
    relationSchemaVersion: number;
  }>();
  expectTypeOf<RetrievalFingerprintDisposition>().toEqualTypeOf<
    "compatible" | "initialize" | "rebuild_required"
  >();
});

it("keeps retrieval fingerprints serializable for cache and worker transport", () => {
  const fingerprint: RetrievalFingerprint = {
    schemaVersion: 2,
    chunker: {
      id: "code-index",
      version: 3,
      configurationHash: "chunker-hash",
    },
    embedding: {
      provider: "openai",
      model: "text-embedding-3-small",
      endpointContract: "openai-compatible-v1",
      dimensions: 1_536,
    },
    recordSchemaVersion: 4,
    relationSchemaVersion: 1,
  };

  expect(JSON.parse(JSON.stringify(fingerprint))).toEqual(fingerprint);
});
