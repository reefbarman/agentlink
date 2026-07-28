import type {
  RetrievalChunkRecord,
  RetrievalRelationRecord,
  RetrievalSourceDocument,
} from "../../core/retrieval/contracts.js";

export const MAX_RETRIEVAL_CHUNK_METADATA_SEARCH_CHARS = 16_384;

export function buildRetrievalChunkSearchText(args: {
  chunk: RetrievalChunkRecord;
  source: RetrievalSourceDocument;
  relations: readonly RetrievalRelationRecord[];
}): string {
  const { chunk, source } = args;
  const relationTerms = args.relations
    .filter(
      (relation) => relation.fromId === chunk.id || relation.toId === chunk.id,
    )
    .flatMap((relation) => [relation.kind, relation.fromId, relation.toId]);
  const metadata = [
    source.id,
    source.revision.id,
    source.path,
    source.title,
    chunk.location?.path,
    ...(chunk.location?.scope ?? []),
    ...Object.values(source.metadata).map(String),
    ...Object.values(chunk.metadata).map(String),
    ...relationTerms,
  ]
    .filter((value): value is string => Boolean(value))
    .join("\n")
    .slice(0, MAX_RETRIEVAL_CHUNK_METADATA_SEARCH_CHARS);

  return metadata ? `${metadata}\n${chunk.content}` : chunk.content;
}
