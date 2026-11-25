import type {
  PostCommand,
  SidebarState,
} from "@agentlink/protocol/sidebar-transport";

import { CollapsibleSection } from "./common/CollapsibleSection.js";
import type { SemanticReadinessReason } from "@agentlink/protocol/semantic-readiness";

interface Props {
  state: SidebarState;
  postCommand: PostCommand;
}

export function IndexStatus({ state, postCommand }: Props) {
  const status = state.indexStatus;
  const isIndexing =
    status?.state === "indexing" || status?.state === "discovering";
  const isError = status?.state === "error";
  const wasCancelled = status?.lastCompleted?.cancelled === true;

  const dotClass = isError
    ? "dot error"
    : isIndexing
      ? "dot indexing"
      : wasCancelled
        ? "dot stopped"
        : status?.lastCompleted
          ? "dot running"
          : "dot stopped";

  let completedText = "Not indexed";
  if (status?.lastCompleted) {
    const { filesIndexed, totalFilesInIndex, totalChunksInIndex } =
      status.lastCompleted;
    if (wasCancelled) {
      completedText = `Cancelled \u2014 ${totalFilesInIndex} files indexed so far`;
    } else if (filesIndexed > 0 && totalFilesInIndex > filesIndexed) {
      completedText = `Indexed \u2014 ${totalFilesInIndex} files (${filesIndexed} updated), ${totalChunksInIndex} chunks`;
    } else {
      completedText = `Indexed \u2014 ${totalFilesInIndex} files, ${totalChunksInIndex} chunks`;
    }
  }

  const hasCounts =
    isIndexing && status?.current != null && Boolean(status.total);
  const statusText = isError
    ? `Error: ${status?.error ?? "Unknown error"}`
    : isIndexing
      ? status?.phase
        ? hasCounts
          ? `${capitalize(status.phase)} ${formatCount(status.current!)} / ${formatCount(status.total!)}`
          : capitalize(status.phase)
        : "Discovering files..."
      : completedText;
  const detailText =
    isIndexing && status?.detail ? stripDiagnostics(status.detail) : null;

  const readinessReason = status?.readinessReason;
  const showRemediation = isError && Boolean(readinessReason);

  const progress =
    isIndexing && status?.current != null && status?.total
      ? Math.round((status.current / status.total) * 100)
      : null;

  return (
    <CollapsibleSection title="Codebase Index">
      <div class="index-status">
        <div class="status-header">
          <span class={dotClass} />
          <span class="status-text">{statusText}</span>
        </div>

        {detailText && <div class="status-detail">{detailText}</div>}

        {progress !== null && (
          <div class="progress-bar">
            <div class="progress-fill" style={{ width: `${progress}%` }} />
          </div>
        )}

        {status?.lastCompleted && !isIndexing && (
          <div class="index-stats">
            Completed in {(status.lastCompleted.durationMs / 1000).toFixed(1)}s
            {status.lastCompleted.errorCount != null &&
              status.lastCompleted.errorCount > 0 && (
                <span class="index-errors">
                  {" \u2014 "}
                  {status.lastCompleted.errorCount} error
                  {status.lastCompleted.errorCount > 1 ? "s" : ""} (check Output
                  panel)
                </span>
              )}
          </div>
        )}

        {showRemediation && readinessReason ? (
          <ReadinessActions
            readinessReason={readinessReason}
            readinessMessage={status?.readinessMessage ?? status?.error}
            postCommand={postCommand}
          />
        ) : (
          <div class="button-group">
            {!isIndexing && wasCancelled && (
              <button
                class="btn btn-secondary"
                title="Continue indexing from the previous stopping point"
                onClick={() => postCommand("resumeIndex")}
              >
                Resume
              </button>
            )}
            {!isIndexing && (
              <button
                class="btn btn-secondary"
                title={
                  isError
                    ? "Try building the codebase index again"
                    : status?.lastCompleted && !wasCancelled
                      ? "Rebuild the semantic index from the current codebase"
                      : "Build a semantic index so agents can search this codebase"
                }
                onClick={() => postCommand("rebuildIndex")}
              >
                {isError
                  ? "Retry"
                  : status?.lastCompleted && !wasCancelled
                    ? "Rebuild Index"
                    : "Index Codebase"}
              </button>
            )}
            {!isIndexing && !isError && status?.lastCompleted && (
              <button
                class="btn btn-secondary"
                title="Compact the index and delete old database history to free disk space. Does not re-index or re-embed files."
                onClick={() => postCommand("maintainIndex")}
              >
                Free Up Space
              </button>
            )}
            {isIndexing && (
              <button
                class="btn btn-secondary"
                title="Stop the current indexing run; indexed progress is retained"
                onClick={() => postCommand("cancelIndex")}
              >
                Cancel
              </button>
            )}
          </div>
        )}
        <EmbeddingStatus state={state} postCommand={postCommand} />
      </div>
    </CollapsibleSection>
  );
}

const EMBEDDING_DOT_CLASSES = {
  ready: "running",
  working: "indexing",
  degraded: "warning",
  unavailable: "error",
  disabled: "off",
  not_measured: "off",
} as const;

/** Semantic search opt-in: off by default because it sends code to OpenAI. */
function EmbeddingStatus({ state, postCommand }: Props) {
  const embeddings = state.contextHealth?.embeddings;
  if (!embeddings) return null;
  const isIndexing =
    state.indexStatus?.state === "indexing" ||
    state.indexStatus?.state === "discovering";
  const needsKey =
    embeddings.status === "unavailable" &&
    embeddings.embeddedChunkCount === undefined;
  const needsRebuild = embeddings.enabled && !needsKey && embeddings.reason;
  return (
    <div class="embedding-status">
      <div class="status-header">
        <span class={`dot ${EMBEDDING_DOT_CLASSES[embeddings.status]}`} />
        <span class="status-text">
          Semantic search: {embeddings.enabled ? "on" : "off"}
          {embeddings.status === "working" && " \u2014 indexing"}
          {embeddings.embeddedChunkCount !== undefined &&
            ` \u2014 ${formatCount(embeddings.embeddedChunkCount)} of ${formatCount(embeddings.chunkCount ?? 0)} chunks embedded`}
        </span>
      </div>
      <p class="help-text">
        {embeddings.enabled
          ? (embeddings.reason ??
            "Indexed code and search queries are sent to OpenAI to create embeddings.")
          : "Find code by meaning, not just matching words. Turning this on sends your indexed code and search queries to OpenAI and uses your OpenAI API key."}
      </p>
      <div class="button-group">
        {!embeddings.enabled && (
          <button
            class="btn btn-secondary"
            title="Review what is sent to OpenAI, then turn on semantic search"
            onClick={() => postCommand("enableSemanticEmbeddings")}
          >
            {"Turn On\u2026"}
          </button>
        )}
        {needsKey && (
          <button
            class="btn btn-primary"
            title="Save an API key used to create semantic-search embeddings"
            onClick={() => postCommand("setOpenaiApiKey")}
          >
            Set API Key
          </button>
        )}
        {needsRebuild && !isIndexing && (
          <button
            class="btn btn-secondary"
            title="Rebuild the index and create embeddings for all indexed code"
            onClick={() => postCommand("rebuildIndex")}
          >
            Rebuild to Embed
          </button>
        )}
        {embeddings.enabled && (
          <button
            class="btn btn-secondary"
            title="Stop sending code and search queries to OpenAI"
            onClick={() => postCommand("disableSemanticEmbeddings")}
          >
            Turn Off
          </button>
        )}
        <button
          class="btn btn-secondary"
          title="How semantic search works, what it sends and how to set it up"
          onClick={() => postCommand("openSemanticEmbeddingsHelp")}
        >
          Learn More
        </button>
      </div>
    </div>
  );
}

interface ReadinessActionsProps {
  readinessReason: SemanticReadinessReason;
  readinessMessage?: string;
  postCommand: PostCommand;
}

function ReadinessActions({
  readinessReason,
  readinessMessage,
  postCommand,
}: ReadinessActionsProps) {
  const message =
    readinessMessage ??
    "Semantic search/indexing setup is required before this action can run.";

  if (readinessReason === "missing_embeddings_auth") {
    return (
      <div class="index-remediation">
        <p class="help-text index-remediation-text">{message}</p>
        <div class="button-group">
          <button
            class="btn btn-primary"
            title="Save an API key used to create semantic-search embeddings"
            onClick={() => postCommand("setOpenaiApiKey")}
          >
            Set Embeddings API Key
          </button>
          <button
            class="btn btn-secondary"
            title="Save one API key for both model requests and semantic-search embeddings"
            onClick={() => postCommand("setOpenaiModelsAndEmbeddingsApiKey")}
          >
            Set Models + Embeddings API Key
          </button>
          <button
            class="btn btn-secondary"
            title="Open guided setup for semantic search"
            onClick={() =>
              postCommand("setupSemanticSearch", { reason: readinessReason })
            }
          >
            Guided Setup
          </button>
        </div>
      </div>
    );
  }

  if (readinessReason === "missing_index") {
    return (
      <div class="index-remediation">
        <p class="help-text index-remediation-text">{message}</p>
        <div class="button-group">
          <button
            class="btn btn-primary"
            title="Build the semantic index required for codebase search"
            onClick={() => postCommand("rebuildIndex")}
          >
            Index Codebase
          </button>
          <button
            class="btn btn-secondary"
            title="Open guided setup for semantic search"
            onClick={() =>
              postCommand("setupSemanticSearch", { reason: readinessReason })
            }
          >
            Guided Setup
          </button>
        </div>
      </div>
    );
  }

  if (readinessReason === "store_unavailable") {
    return (
      <div class="index-remediation">
        <p class="help-text index-remediation-text">{message}</p>
        <div class="button-group">
          <button
            class="btn btn-primary"
            title="Retry connecting to the vector database and building the index"
            onClick={() => postCommand("rebuildIndex")}
          >
            Retry
          </button>
          <button
            class="btn btn-secondary"
            title="Open AgentLink settings to review semantic-search configuration"
            onClick={() => postCommand("openSettings")}
          >
            Open Settings
          </button>
          <button
            class="btn btn-secondary"
            title="Open AgentLink logs to diagnose the indexing problem"
            onClick={() => postCommand("openOutput")}
          >
            Open Output
          </button>
        </div>
      </div>
    );
  }

  if (readinessReason === "disabled") {
    return (
      <div class="index-remediation">
        <p class="help-text index-remediation-text">{message}</p>
        <div class="button-group">
          <button
            class="btn btn-primary"
            title="Open AgentLink settings to enable semantic search"
            onClick={() => postCommand("openSettings")}
          >
            Enable in Settings
          </button>
        </div>
      </div>
    );
  }

  return (
    <div class="index-remediation">
      <p class="help-text index-remediation-text">{message}</p>
      <div class="button-group">
        <button
          class="btn btn-secondary"
          title="Try building the codebase index again"
          onClick={() => postCommand("rebuildIndex")}
        >
          Retry
        </button>
      </div>
    </div>
  );
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

/** Drops worker diagnostics suffixes (heap/rss) that belong in logs, not UI. */
function stripDiagnostics(detail: string): string {
  return detail.replace(/\s*\(heap=[^)]*\)\s*$/, "");
}
