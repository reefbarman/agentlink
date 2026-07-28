import type { RetrievalSourceDocument } from "./contracts.js";
import { createHash } from "node:crypto";

export function createRetrievalRecordIdDigest(ids: readonly string[]): string {
  const unique = new Set(ids);
  if (unique.size !== ids.length || [...unique].some((id) => id.length === 0)) {
    throw new Error("Retrieval record digest requires unique non-empty IDs");
  }
  return sha256(JSON.stringify([...unique].sort()));
}

export function createRetrievalSourcePayloadDigest(
  source: RetrievalSourceDocument,
): string {
  return createRetrievalContentDigest(source);
}

export function createRetrievalContentDigest(value: unknown): string {
  return sha256(stableJson(value));
}

export function createRetrievalRecordContentDigest(
  records: readonly { id: string }[],
): string {
  createRetrievalRecordIdDigest(records.map((record) => record.id));
  return createRetrievalContentDigest(
    [...records].sort((left, right) => left.id.localeCompare(right.id)),
  );
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  }
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
    .join(",")}}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
