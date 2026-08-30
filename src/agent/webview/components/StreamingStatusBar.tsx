import type { ChatMessage } from "@agentlink/protocol/chat-transcript";
import { LiveLinkIndicator } from "./LiveLinkIndicator";
import { ThinkingContent } from "./ThinkingContent";
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
  const [thinkingExpanded, setThinkingExpanded] = useState(false);
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
  const activeThinking =
    !runtimeStatus &&
    !statusOverride &&
    projectedActivity.phase === "reasoning" &&
    lastMsg?.role === "assistant"
      ? [...lastMsg.blocks]
          .reverse()
          .find((block) => block.type === "thinking" && !block.complete)
      : undefined;
  const canExpandThinking =
    activeThinking?.type === "thinking" &&
    activeThinking.text.trim().length > 0;
  const activeThinkingId =
    activeThinking?.type === "thinking" ? activeThinking.id : null;
  useEffect(() => {
    setThinkingExpanded(false);
  }, [activeThinkingId]);

  return (
    <div
      class={`streaming-status-bar${canExpandThinking ? " streaming-status-bar-expandable" : ""}${className ? ` ${className}` : ""}`}
    >
      {canExpandThinking ? (
        <>
          <button
            class="streaming-status-summary"
            type="button"
            aria-expanded={thinkingExpanded}
            onClick={() => setThinkingExpanded((expanded) => !expanded)}
          >
            <LiveLinkIndicator motion={motion} />
            <span>{status}</span>
            <i
              class={`codicon codicon-chevron-${thinkingExpanded ? "down" : "right"} streaming-status-chevron`}
            />
          </button>
          {thinkingExpanded && (
            <div class="streaming-thinking-content">
              <ThinkingContent text={activeThinking.text} />
            </div>
          )}
        </>
      ) : (
        <>
          <LiveLinkIndicator motion={motion} />
          <span>{status}</span>
        </>
      )}
    </div>
  );
}
