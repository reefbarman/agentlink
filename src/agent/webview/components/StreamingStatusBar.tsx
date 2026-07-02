import type { ChatMessage } from "../types";
import { getStreamingActivity } from "./MessageBubble";

export function StreamingStatusBar({
  messages,
  statusOverride,
  className,
}: {
  messages: ChatMessage[];
  statusOverride?: string | null;
  className?: string;
}) {
  const lastMsg = messages[messages.length - 1];
  const status =
    statusOverride ??
    (lastMsg?.role === "assistant"
      ? getStreamingActivity(lastMsg.blocks)
      : "Waiting for response…");

  return (
    <div class={`streaming-status-bar${className ? ` ${className}` : ""}`}>
      <i class="codicon codicon-loading codicon-modifier-spin" />
      <span>{status}</span>
    </div>
  );
}
