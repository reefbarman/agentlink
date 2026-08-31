export type RetrievalNamespace =
  | "code"
  | "memory"
  | "session"
  | "catalog"
  | "custom";

export type RetrievalSourceKind =
  | "file"
  | "memory"
  | "session"
  | "instruction"
  | "skill"
  | "tool"
  | "custom";

export interface RetrievalSourceRevision {
  id: string;
  contentHash: string;
  observedAt: string;
}

export interface RetrievalSourceDocument {
  id: string;
  namespace: RetrievalNamespace;
  kind: RetrievalSourceKind;
  revision: RetrievalSourceRevision;
  path?: string;
  title?: string;
  content: string;
  metadata: Record<string, string | number | boolean | null>;
}

export interface RetrievalChunkLocation {
  path?: string;
  startLine?: number;
  endLine?: number;
  scope?: string[];
}

export interface RetrievalChunkRecord {
  id: string;
  sourceId: string;
  revisionId: string;
  generation: string;
  content: string;
  embedding: readonly number[] | null;
  location?: RetrievalChunkLocation;
  metadata: Record<string, string | number | boolean | null>;
}

export interface RetrievalRelationRecord {
  id: string;
  sourceId: string;
  revisionId: string;
  generation: string;
  fromId: string;
  toId: string;
  kind: string;
  metadata: Record<string, string | number | boolean | null>;
}
