import type { ComponentChildren } from "preact";

export function ChatHeader({
  restoringSession,
  showHistory,
  onNewSession,
  onShowHistory,
  extraActions,
}: {
  restoringSession?: boolean;
  showHistory: boolean;
  onNewSession: () => void;
  onShowHistory: () => void;
  extraActions?: ComponentChildren;
}) {
  return (
    <div class="chat-header">
      <button
        class="icon-button"
        onClick={onNewSession}
        title={
          restoringSession
            ? "Start a new session without waiting for restore"
            : "New Session"
        }
      >
        <i class="codicon codicon-add" />
      </button>
      {restoringSession && (
        <div class="session-restore-status" title="Restoring the last session">
          <i class="codicon codicon-loading codicon-modifier-spin" />
          <span>Loading last session…</span>
        </div>
      )}
      {extraActions}
      <button
        class={`icon-button${showHistory ? " active" : ""}`}
        onClick={onShowHistory}
        title="Session History"
      >
        <i class="codicon codicon-history" />
      </button>
    </div>
  );
}
