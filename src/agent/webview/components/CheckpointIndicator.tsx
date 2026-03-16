interface CheckpointIndicatorProps {
  checkpointId: string;
  sessionId: string | null;
  onRevert: (sessionId: string, checkpointId: string) => void;
}

/**
 * A small dot indicator shown on user messages that have an associated checkpoint.
 * Clicking it triggers the revert flow.
 */
export function CheckpointIndicator({
  checkpointId,
  sessionId,
  onRevert,
}: CheckpointIndicatorProps) {
  if (!sessionId) return null;

  return (
    <button
      class="checkpoint-indicator"
      title="Revert workspace to this checkpoint"
      onClick={(e) => {
        e.stopPropagation();
        onRevert(sessionId, checkpointId);
      }}
    >
      <i class="codicon codicon-history" />
    </button>
  );
}
