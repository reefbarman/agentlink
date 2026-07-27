import type {
  RetrievalHealthReason,
  RetrievalHealthSnapshot,
} from "../core/retrieval/contracts.js";

import type { MemoryHealthSnapshot } from "../core/memory/contracts.js";

export interface ContextIndexHealthInput {
  state: "idle" | "discovering" | "indexing" | "error";
  current?: number;
  total?: number;
  lastCompleted?: {
    totalFilesInIndex: number;
    totalChunksInIndex: number;
    errorCount?: number;
  };
  readinessReason?: RetrievalHealthReason;
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
    retrieval: MemoryHealthSnapshot["retrieval"] | "not_measured";
    activeRecordCount?: number;
    reason?: string;
  };
  retrieval: {
    status: ContextHealthStatus;
    lexical: RetrievalHealthSnapshot["lexical"] | "not_measured";
    vector: RetrievalHealthSnapshot["vector"] | "not_measured";
    structural: RetrievalHealthSnapshot["structural"] | "not_measured";
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

const RETRIEVAL_REASON_LABELS: Record<RetrievalHealthReason, string> = {
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
  health: MemoryHealthSnapshot,
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
  health: RetrievalHealthSnapshot,
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

function memoryReason(
  status: MemoryHealthSnapshot["status"],
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
