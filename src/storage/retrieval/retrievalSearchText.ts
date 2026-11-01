import type {
  RetrievalChunkRecord,
  RetrievalRelationRecord,
  RetrievalSourceDocument,
} from "@agentlink/protocol/retrieval-records";

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
  const metadata = joinBounded(
    [
      source.id,
      source.revision.id,
      source.path,
      source.title,
      chunk.location?.path,
      ...(chunk.location?.scope ?? []),
      ...searchableMetadataValues(source.metadata),
      ...searchableMetadataValues(chunk.metadata),
      ...relationTerms,
    ].filter((value): value is string => Boolean(value)),
    MAX_RETRIEVAL_CHUNK_METADATA_SEARCH_CHARS,
  );

  return metadata ? `${metadata}\n${chunk.content}` : chunk.content;
}

/**
 * Metadata values worth matching in full-text search. Keys ending in `Json`
 * hold serialized structured payloads (for example a derived session's whole
 * chunk set), which only add noise to matches and bloat every chunk row.
 */
function searchableMetadataValues(
  metadata: Readonly<Record<string, unknown>>,
): string[] {
  return Object.entries(metadata)
    .filter(([key]) => !key.endsWith("Json"))
    .map(([, value]) => String(value));
}

/**
 * Same result as `values.join("\n").slice(0, maxChars)`, without building the
 * full join. Source metadata can hold a whole serialized session, and a
 * sliced string keeps its parent alive, so the naive form retained a copy of
 * that payload in every chunk row of a batch.
 */
function joinBounded(values: readonly string[], maxChars: number): string {
  const parts: string[] = [];
  let length = 0;
  for (const [index, value] of values.entries()) {
    if (index > 0) {
      if (length >= maxChars) break;
      parts.push("\n");
      length += 1;
    }
    const remaining = maxChars - length;
    if (remaining <= 0) break;
    const part = value.length > remaining ? value.slice(0, remaining) : value;
    parts.push(part);
    length += part.length;
  }
  return parts.join("");
}
