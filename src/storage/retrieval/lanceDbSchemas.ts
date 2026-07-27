import {
  Bool,
  Field,
  FixedSizeList,
  Float32,
  Int32,
  Schema,
  Utf8,
} from "apache-arrow";

export const RETRIEVAL_TABLES = {
  sources: "retrieval_sources",
  chunks: "retrieval_chunks",
  relations: "retrieval_relations",
  publications: "retrieval_publications",
  metadata: "retrieval_metadata",
  snapshots: "retrieval_snapshots",
  memoryEntries: "memory_entries",
} as const;

const utf8 = () => new Utf8();

export function retrievalSourceSchema(): Schema {
  return new Schema([
    new Field("source_id", utf8(), false),
    new Field("revision_id", utf8(), false),
    new Field("generation", utf8(), true),
    new Field("deleted", new Bool(), false),
    new Field("payload_json", utf8(), false),
  ]);
}

export function retrievalChunkSchema(dimensions: number): Schema {
  if (!Number.isInteger(dimensions) || dimensions <= 0) {
    throw new Error("Retrieval vector dimensions must be a positive integer");
  }
  return new Schema([
    new Field("chunk_id", utf8(), false),
    new Field("source_id", utf8(), false),
    new Field("revision_id", utf8(), false),
    new Field("generation", utf8(), false),
    new Field("search_text", utf8(), false),
    new Field(
      "embedding",
      new FixedSizeList(dimensions, new Field("item", new Float32(), true)),
      true,
    ),
    new Field("payload_json", utf8(), false),
  ]);
}

export function retrievalRelationSchema(): Schema {
  return new Schema([
    new Field("relation_id", utf8(), false),
    new Field("source_id", utf8(), false),
    new Field("revision_id", utf8(), false),
    new Field("generation", utf8(), false),
    new Field("payload_json", utf8(), false),
  ]);
}

export function retrievalPublicationSchema(): Schema {
  return new Schema([
    new Field("publication_id", utf8(), false),
    new Field("source_id", utf8(), false),
    new Field("revision_id", utf8(), false),
    new Field("generation", utf8(), false),
    new Field("payload_json", utf8(), false),
  ]);
}

export function retrievalMetadataSchema(): Schema {
  return new Schema([
    new Field("key", utf8(), false),
    new Field("value_json", utf8(), false),
  ]);
}

export function retrievalSnapshotSchema(): Schema {
  return new Schema([
    new Field("snapshot_id", utf8(), false),
    new Field("created_at", utf8(), false),
    new Field("label", utf8(), true),
    new Field("source_count", new Int32(), false),
    new Field("chunk_count", new Int32(), false),
    new Field("relation_count", new Int32(), false),
    new Field("payload_json", utf8(), false),
  ]);
}

export function memoryEntrySchema(): Schema {
  return new Schema([
    new Field("row_id", utf8(), false),
    new Field("row_kind", utf8(), false),
    new Field("record_id", utf8(), true),
    new Field("revision", new Int32(), true),
    new Field("scope_kind", utf8(), false),
    new Field("scope_id", utf8(), false),
    new Field("status", utf8(), false),
    new Field("search_text", utf8(), false),
    new Field("occurred_at", utf8(), false),
    new Field("payload_json", utf8(), false),
  ]);
}
