export const SESSION_HANDOFF_SCHEMA_VERSION = 1 as const;

export interface SessionHandoffSections {
  objective: string;
  completedWork: string[];
  decisions: Array<{ decision: string; rationale?: string }>;
  workspaceState: string[];
  verification: string[];
  unresolved: string[];
  constraints: string[];
  nextActions: string[];
}

export interface SessionHandoffDraft {
  schemaVersion: typeof SESSION_HANDOFF_SCHEMA_VERSION;
  id: string;
  sourceSessionId: string;
  sourceProjectId: string;
  sourceTitle: string;
  /** CAS revision captured after the source session was durably flushed. */
  sourcePersistenceRevision: string;
  /** SHA-256 revision of the canonical source transcript snapshot. */
  sourceSnapshotRevision: string;
  /** Runtime-local fast freshness check; not durable identity. */
  sourceRuntimeTranscriptRevision: number;
  createdAt: number;
  generatedBy: {
    providerId: string;
    model: string;
    fallbackUsed: boolean;
  };
  sections: SessionHandoffSections;
  markdown: string;
}
