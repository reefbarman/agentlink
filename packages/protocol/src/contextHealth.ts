import type {
  RetrievalHealthReason,
  RetrievalHealthSnapshot,
} from "./retrievalHealth.js";

export type ContextRetrievalHealthReason = RetrievalHealthReason;

export interface ContextMemoryHealthInput {
  status: "ready" | "degraded" | "unavailable";
  retrieval: "lexical-only" | "hybrid" | "unavailable";
  crud: boolean;
  dedupe: boolean;
  conflict: boolean;
  auditUndo: boolean;
  recordCount: number;
  activeRecordCount: number;
  auditEventCount: number;
  reason?: string;
}

export type ContextRetrievalHealthInput = RetrievalHealthSnapshot;

export interface ContextIndexHealthInput {
  state: "idle" | "discovering" | "indexing" | "error";
  current?: number;
  total?: number;
  lastCompleted?: {
    totalFilesInIndex: number;
    totalChunksInIndex: number;
    embeddedChunksInIndex?: number;
    unmeasuredChunksInIndex?: number;
    errorCount?: number;
  };
  readinessReason?: ContextRetrievalHealthReason;
}

export type ContextHealthStatus =
  | "ready"
  | "working"
  | "degraded"
  | "unavailable"
  | "disabled"
  | "not_measured";

export interface ContextHealthSnapshot {
  memory: {
    status: ContextHealthStatus;
    retrieval: ContextMemoryHealthInput["retrieval"] | "not_measured";
    activeRecordCount?: number;
    reason?: string;
  };
  retrieval: {
    status: ContextHealthStatus;
    lexical: ContextRetrievalHealthInput["lexical"] | "not_measured";
    vector: ContextRetrievalHealthInput["vector"] | "not_measured";
    structural: ContextRetrievalHealthInput["structural"] | "not_measured";
    sourceCount?: number;
    chunkCount?: number;
    staleSourceCount?: number;
    reason?: string;
  };
  index: {
    status: ContextHealthStatus;
    state: ContextIndexHealthInput["state"] | "disabled" | "not_measured";
    current?: number;
    total?: number;
    totalFilesInIndex?: number;
    totalChunksInIndex?: number;
    reason?: string;
  };
  /** Vector coverage for semantic search. VS Code sidebar only. */
  embeddings?: {
    status: ContextHealthStatus;
    enabled: boolean;
    embeddedChunkCount?: number;
    chunkCount?: number;
    reason?: string;
  };
}

export interface ContextEmbeddingConfiguration {
  /** The user opted in to sending code to the embedding provider. */
  enabled: boolean;
  credentials: "available" | "missing" | "unknown";
}

export const INITIAL_CONTEXT_HEALTH: ContextHealthSnapshot = {
  memory: {
    status: "not_measured",
    retrieval: "not_measured",
    reason: "Health has not been measured yet.",
  },
  retrieval: {
    status: "not_measured",
    lexical: "not_measured",
    vector: "not_measured",
    structural: "not_measured",
    reason: "Health has not been measured yet.",
  },
  index: {
    status: "not_measured",
    state: "not_measured",
    reason: "Health has not been measured yet.",
  },
};

const RETRIEVAL_REASON_LABELS: Record<ContextRetrievalHealthReason, string> = {
  disabled: "Retrieval is disabled.",
  no_workspace: "No workspace is available.",
  missing_index: "The index has not been built yet.",
  store_unavailable: "The retrieval store is unavailable.",
  rebuild_required: "The index needs to be rebuilt.",
  lexical_index_unavailable: "Lexical retrieval is unavailable.",
  scalar_index_unavailable: "Metadata filtering is unavailable.",
  vector_index_unavailable: "Vector retrieval is unavailable.",
  structural_index_unavailable: "Structural retrieval is unavailable.",
  missing_embeddings_auth: "Embedding credentials are unavailable.",
  repair_required: "The retrieval store needs repair.",
  generic_error: "Retrieval reported an error.",
};

export function projectMemoryHealth(
  health: ContextMemoryHealthInput,
): ContextHealthSnapshot["memory"] {
  const disabled = health.reason?.includes("disabled") ?? false;
  return {
    status: disabled ? "disabled" : health.status,
    retrieval: health.retrieval,
    activeRecordCount: safeCount(health.activeRecordCount),
    ...(health.status === "ready" && !disabled
      ? {}
      : { reason: memoryReason(health.status, health.reason) }),
  };
}

export function projectRetrievalHealth(
  health: ContextRetrievalHealthInput,
): ContextHealthSnapshot["retrieval"] {
  return {
    status: health.status,
    lexical: health.lexical,
    vector: health.vector,
    structural: health.structural,
    sourceCount: safeCount(health.sourceCount),
    chunkCount: safeCount(health.chunkCount),
    staleSourceCount: safeCount(health.staleSourceCount),
    ...(health.status === "ready"
      ? {}
      : {
          reason:
            RETRIEVAL_REASON_LABELS[
              health.reason ?? health.reasons[0] ?? "generic_error"
            ] ?? RETRIEVAL_REASON_LABELS.generic_error,
        }),
  };
}

export function projectIndexHealth(
  status: ContextIndexHealthInput | null,
  enabled: boolean,
): ContextHealthSnapshot["index"] {
  if (!enabled) {
    return {
      status: "disabled",
      state: "disabled",
      reason: "Semantic indexing is disabled.",
    };
  }
  if (!status) {
    return {
      status: "not_measured",
      state: "not_measured",
      reason: "Index health has not been measured yet.",
    };
  }
  if (status.state === "discovering" || status.state === "indexing") {
    return {
      status: "working",
      state: status.state,
      current: safeOptionalCount(status.current),
      total: safeOptionalCount(status.total),
      totalFilesInIndex: safeOptionalCount(
        status.lastCompleted?.totalFilesInIndex,
      ),
      totalChunksInIndex: safeOptionalCount(
        status.lastCompleted?.totalChunksInIndex,
      ),
    };
  }
  if (status.state === "error") {
    return {
      status: "unavailable",
      state: "error",
      totalFilesInIndex: safeOptionalCount(
        status.lastCompleted?.totalFilesInIndex,
      ),
      totalChunksInIndex: safeOptionalCount(
        status.lastCompleted?.totalChunksInIndex,
      ),
      reason: status.readinessReason
        ? RETRIEVAL_REASON_LABELS[status.readinessReason]
        : RETRIEVAL_REASON_LABELS.generic_error,
    };
  }
  const errorCount = status.lastCompleted?.errorCount ?? 0;
  return {
    status: errorCount > 0 ? "degraded" : "ready",
    state: "idle",
    totalFilesInIndex: safeOptionalCount(
      status.lastCompleted?.totalFilesInIndex,
    ),
    totalChunksInIndex: safeOptionalCount(
      status.lastCompleted?.totalChunksInIndex,
    ),
    ...(errorCount > 0
      ? { reason: "The last indexing run completed with errors." }
      : {}),
  };
}

export function projectEmbeddingHealth(
  configuration: ContextEmbeddingConfiguration,
  index: ContextIndexHealthInput | null,
): NonNullable<ContextHealthSnapshot["embeddings"]> {
  if (!configuration.enabled) {
    return {
      status: "disabled",
      enabled: false,
      reason: "Off. Code search matches text only.",
    };
  }
  const base = { enabled: true };
  if (configuration.credentials === "missing") {
    return {
      ...base,
      status: "unavailable",
      reason: "Add an OpenAI API key to create embeddings.",
    };
  }
  if (index?.state === "indexing" || index?.state === "discovering") {
    // Counts describe the last finished run, so they would be stale here.
    return {
      ...base,
      status: "working",
      reason: "Coverage updates when indexing finishes.",
    };
  }
  const last = index?.lastCompleted;
  const chunkCount = safeOptionalCount(last?.totalChunksInIndex);
  const embeddedChunkCount = safeOptionalCount(last?.embeddedChunksInIndex);
  if (
    configuration.credentials === "unknown" ||
    chunkCount === undefined ||
    embeddedChunkCount === undefined
  ) {
    return {
      ...base,
      status: "not_measured",
      reason: "Coverage has not been measured yet.",
    };
  }
  const counts = { ...base, embeddedChunkCount, chunkCount };
  const unmeasured = safeCount(last?.unmeasuredChunksInIndex ?? 0);
  const missing = chunkCount - embeddedChunkCount - unmeasured;
  if (missing > 0) {
    return {
      ...counts,
      status: embeddedChunkCount > 0 ? "degraded" : "unavailable",
      reason:
        "Some indexed code has no embedding. Rebuild the index to embed it.",
    };
  }
  if (unmeasured > 0) {
    return {
      ...counts,
      status: "not_measured",
      reason:
        "Some files were indexed by an older version. Rebuild the index to embed and measure them.",
    };
  }
  return { ...counts, status: "ready" };
}

function memoryReason(
  status: ContextMemoryHealthInput["status"],
  rawReason: string | undefined,
): string {
  if (rawReason?.includes("disabled")) return "Autonomous memory is disabled.";
  if (rawReason?.includes("migration")) {
    return "Autonomous memory is initializing.";
  }
  return status === "degraded"
    ? "Autonomous memory is degraded."
    : "Autonomous memory is unavailable.";
}

function safeCount(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function safeOptionalCount(value: number | undefined): number | undefined {
  return value === undefined ? undefined : safeCount(value);
}
