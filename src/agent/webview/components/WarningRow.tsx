import type { ChatMessage } from "../types";

interface WarningRowProps {
  message: ChatMessage;
}

export function WarningRow({ message }: WarningRowProps) {
  return (
    <div class="condense-row condense-row-error">
      <i class="codicon codicon-warning" />
      <details class="warning-row-details">
        <summary class="condense-row-label">API error (auto-repaired)</summary>
        <pre class="warning-row-body">{message.warningMessage}</pre>
      </details>
    </div>
  );
}
