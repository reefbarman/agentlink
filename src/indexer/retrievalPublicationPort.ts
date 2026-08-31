import type {
  RetrievalChunkRecord,
  RetrievalSourceDocument,
} from "@agentlink/protocol/retrieval-records";

import type { RetrievalPublicationRequest } from "@agentlink/protocol/retrieval-publication";

export type RetrievalRecordId = string;

export interface RetrievalPublicationRecord {
  id: RetrievalRecordId;
  publicationId: string;
  source: RetrievalSourceDocument;
  chunk: RetrievalChunkRecord;
}

export interface PreparedRetrievalPublication {
  publication: RetrievalPublicationRequest;
  records: RetrievalPublicationRecord[];
}

export interface RetrievalPublicationMutationPort {
  deleteRecords(recordIds: RetrievalRecordId[]): Promise<void>;
  upsertRecords(records: RetrievalPublicationRecord[]): Promise<void>;
  setRecordsVisible(
    recordIds: RetrievalRecordId[],
    visible: boolean,
  ): Promise<void>;
}

export function assignRetrievalRecordIds(
  publication: RetrievalPublicationRequest,
  createRecordId: () => RetrievalRecordId,
): RetrievalPublicationRecord[] {
  const recordIds = publication.chunks.map(() => createRecordId());
  if (
    recordIds.some((recordId) => recordId.length === 0) ||
    new Set(recordIds).size !== recordIds.length
  ) {
    throw new Error("Retrieval record identities must be non-empty and unique");
  }
  return publication.chunks.map((chunk, index) => ({
    id: recordIds[index]!,
    publicationId: publication.publicationId,
    source: publication.source,
    chunk,
  }));
}
