import type {
  RetrievalFingerprint,
  RetrievalFingerprintDisposition,
} from "./contracts.js";

export function canonicalizeRetrievalFingerprint(
  fingerprint: RetrievalFingerprint,
): string {
  return JSON.stringify({
    schemaVersion: fingerprint.schemaVersion,
    recordSchemaVersion: fingerprint.recordSchemaVersion,
    relationSchemaVersion: fingerprint.relationSchemaVersion,
    chunker: {
      id: fingerprint.chunker.id,
      version: fingerprint.chunker.version,
      configurationHash: fingerprint.chunker.configurationHash,
    },
    embedding: fingerprint.embedding
      ? {
          provider: fingerprint.embedding.provider,
          model: fingerprint.embedding.model,
          endpointContract: fingerprint.embedding.endpointContract,
          dimensions: fingerprint.embedding.dimensions,
        }
      : null,
  });
}

export function parseRetrievalFingerprint(
  value: unknown,
): RetrievalFingerprint {
  if (!isRecord(value))
    throw new Error("Retrieval fingerprint must be an object");
  const chunker = value.chunker;
  if (!isRecord(chunker)) {
    throw new Error("Retrieval fingerprint chunker must be an object");
  }
  const embedding = value.embedding;
  if (embedding !== null && !isRecord(embedding)) {
    throw new Error(
      "Retrieval fingerprint embedding must be an object or null",
    );
  }
  const fingerprint: RetrievalFingerprint = {
    schemaVersion: positiveInteger(value.schemaVersion, "schema version"),
    recordSchemaVersion: positiveInteger(
      value.recordSchemaVersion,
      "record schema version",
    ),
    relationSchemaVersion: positiveInteger(
      value.relationSchemaVersion,
      "relation schema version",
    ),
    chunker: {
      id: nonEmptyString(chunker.id, "chunker ID"),
      version: positiveInteger(chunker.version, "chunker version"),
      configurationHash: nonEmptyString(
        chunker.configurationHash,
        "chunker configuration hash",
      ),
    },
    embedding:
      embedding === null
        ? null
        : {
            provider: nonEmptyString(embedding.provider, "embedding provider"),
            model: nonEmptyString(embedding.model, "embedding model"),
            endpointContract: nonEmptyString(
              embedding.endpointContract,
              "embedding endpoint contract",
            ),
            dimensions: positiveInteger(
              embedding.dimensions,
              "embedding dimensions",
            ),
          },
  };
  return fingerprint;
}

export function classifyRetrievalFingerprint(
  actual: RetrievalFingerprint | null,
  expected: RetrievalFingerprint,
): RetrievalFingerprintDisposition {
  if (!actual) return "initialize";
  return canonicalizeRetrievalFingerprint(actual) ===
    canonicalizeRetrievalFingerprint(expected)
    ? "compatible"
    : "rebuild_required";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(
      `Retrieval fingerprint ${label} must be a non-empty string`,
    );
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new Error(
      `Retrieval fingerprint ${label} must be a positive integer`,
    );
  }
  return value as number;
}
