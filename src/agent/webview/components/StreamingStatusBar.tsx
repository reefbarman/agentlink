import type { ChatMessage } from "../types";
import { LiveLinkIndicator } from "./LiveLinkIndicator";
import { getStreamingActivity } from "./activityPresentation";
import {
  formatBackgroundRuntimeStatus,
  getBackgroundRuntimeMotion,
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
  const projectedActivity =
    lastMsg?.role === "assistant"
      ? getStreamingActivity(lastMsg.blocks)
      : getStreamingActivity([]);
  const status =
    formatBackgroundRuntimeStatus(runtimeStatus, now) ??
    statusOverride ??
    projectedActivity.label;
  const motion = runtimeStatus
    ? getBackgroundRuntimeMotion(runtimeStatus)
    : projectedActivity.motion;

  return (
    <div class={`streaming-status-bar${className ? ` ${className}` : ""}`}>
      <LiveLinkIndicator motion={motion} />
      <span>{status}</span>
    </div>
  );
}
