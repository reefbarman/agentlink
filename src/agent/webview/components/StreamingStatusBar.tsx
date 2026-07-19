import type { ChatMessage } from "../types";
import { getStreamingActivity } from "./MessageBubble";
import {
  formatBackgroundRuntimeStatus,
  type BackgroundRuntimeStatus,
} from "./backgroundRuntimeStatus";
import { useEffect, useState } from "preact/hooks";

export function StreamingStatusBar({
  messages,
  statusOverride,
  runtimeStatus,
  className,
}: {
  messages: ChatMessage[];
  statusOverride?: string | null;
  runtimeStatus?: BackgroundRuntimeStatus;
  className?: string;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!runtimeStatus?.requestStartedAt && !runtimeStatus?.retryAt) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [runtimeStatus?.requestStartedAt, runtimeStatus?.retryAt]);
  const lastMsg = messages[messages.length - 1];
  const status =
    formatBackgroundRuntimeStatus(runtimeStatus, now) ??
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
