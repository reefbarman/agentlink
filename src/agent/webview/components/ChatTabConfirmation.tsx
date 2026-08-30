import type { ChatTabActionConfirmationRequest } from "@agentlink/protocol/chat-workspace";

const LABELS = {
  close: {
    title: "This chat is still running",
    description: "Stop its active or queued work before closing the tab.",
    confirm: "Stop and close",
    cancel: "Keep open",
  },
  new_chat: {
    title: "This chat is still running",
    description:
      "Stop its active or queued work before starting a new chat in this tab.",
    confirm: "Stop and start new chat",
    cancel: "Keep current chat",
  },
  load_session: {
    title: "This chat is still running",
    description:
      "Stop its active or queued work before loading history into this tab.",
    confirm: "Stop and load chat",
    cancel: "Keep current chat",
  },
} as const;

export function ChatTabConfirmation({
  request,
  onConfirm,
  onCancel,
}: {
  request: ChatTabActionConfirmationRequest;
  onConfirm(): void;
  onCancel(): void;
}) {
  const labels = LABELS[request.action];
  return (
    <div class="chat-tab-confirmation-backdrop" role="presentation">
      <div
        class="chat-tab-confirmation"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="chat-tab-confirmation-title"
      >
        <div class="chat-tab-confirmation-icon">
          <i class="codicon codicon-warning" />
        </div>
        <div class="chat-tab-confirmation-content">
          <strong id="chat-tab-confirmation-title">{labels.title}</strong>
          <span>{labels.description}</span>
          <div class="chat-tab-confirmation-actions">
            <button type="button" class="secondary" onClick={onCancel}>
              {labels.cancel}
            </button>
            <button type="button" class="primary" onClick={onConfirm}>
              {labels.confirm}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
