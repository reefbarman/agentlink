import {
  STAGED_RETRIEVAL_TABLES,
  stagedRetrievalBatchSchema,
  stagedRetrievalChunkSchema,
  stagedRetrievalManifestSchema,
  stagedRetrievalRelationSchema,
} from "./lanceDbSchemas.js";
import { describe, expect, it } from "vitest";

describe("staged LanceDB retrieval schemas", () => {
  it("uses dedicated table names that cannot enter active retrieval queries", () => {
    expect(STAGED_RETRIEVAL_TABLES).toEqual({
      manifests: "retrieval_publication_manifests_v2",
      batches: "retrieval_publication_batches_v2",
      chunks: "retrieval_staged_chunks_v2",
      relations: "retrieval_staged_relations_v2",
    });
  });

  it("defines a compact bounded publication manifest", () => {
    expect(fields(stagedRetrievalManifestSchema())).toEqual([
      ["publication_id", false, "Utf8"],
      ["source_id", false, "Utf8"],
      ["revision_id", false, "Utf8"],
      ["generation", false, "Utf8"],
      ["fence_token", false, "Utf8"],
      ["state", false, "Utf8"],
      ["expected_chunk_count", false, "Int32"],
      ["expected_relation_count", false, "Int32"],
      ["expected_chunk_digest", false, "Utf8"],
      ["expected_relation_digest", false, "Utf8"],
      ["source_payload_digest", false, "Utf8"],
      ["source_payload_json", false, "Utf8"],
    ]);
  });

  it("defines compact deterministic batch ledgers", () => {
    expect(fields(stagedRetrievalBatchSchema())).toEqual([
      ["publication_id", false, "Utf8"],
      ["row_kind", false, "Utf8"],
      ["batch_index", false, "Int32"],
      ["expected_count", false, "Int32"],
      ["expected_id_digest", false, "Utf8"],
      ["expected_content_digest", false, "Utf8"],
    ]);
  });

  it("adds publication and batch ownership to staged rows", () => {
    expect(fields(stagedRetrievalChunkSchema(3))).toEqual([
      ["publication_id", false, "Utf8"],
      ["batch_index", false, "Int32"],
      ["chunk_id", false, "Utf8"],
      ["source_id", false, "Utf8"],
      ["revision_id", false, "Utf8"],
      ["generation", false, "Utf8"],
      ["search_text", false, "Utf8"],
      ["embedding", true, "FixedSizeList[3]<Float32>"],
      ["payload_json", false, "Utf8"],
    ]);
    expect(fields(stagedRetrievalRelationSchema())).toEqual([
      ["publication_id", false, "Utf8"],
      ["batch_index", false, "Int32"],
      ["relation_id", false, "Utf8"],
      ["source_id", false, "Utf8"],
      ["revision_id", false, "Utf8"],
      ["generation", false, "Utf8"],
      ["payload_json", false, "Utf8"],
    ]);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid staged vector dimensions %s",
    (dimensions) => {
      expect(() => stagedRetrievalChunkSchema(dimensions)).toThrow(
        "Retrieval vector dimensions must be a positive integer",
      );
    },
  );
});

function fields(
  schema: ReturnType<typeof stagedRetrievalManifestSchema>,
): Array<[string, boolean, string]> {
  return schema.fields.map((field) => [
    field.name,
    field.nullable,
    describeType(field.type),
  ]);
}

function describeType(type: {
  constructor: { name: string };
  listSize?: number;
  children?: Array<{ type: { constructor: { name: string } } }>;
}): string {
  if (type.constructor.name !== "FixedSizeList") return type.constructor.name;
  return `FixedSizeList[${type.listSize}]<${type.children?.[0]?.type.constructor.name}>`;
}
