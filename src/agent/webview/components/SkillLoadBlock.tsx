import type { ContentBlock } from "@agentlink/protocol/chat-transcript";
import { useRemoteToolDetail } from "./RemoteToolDetail";
import { useState } from "preact/hooks";

type SkillLoadData = ContentBlock & { type: "skill_load" };

interface SkillLoadBlockProps {
  block: SkillLoadData;
}

function formatPath(path?: string): string {
  if (!path) return "";
  const parts = path.split("/").filter(Boolean);
  return parts.length <= 3 ? path : `…/${parts.slice(-3).join("/")}`;
}

function parseResultStatus(result: string): string | null {
  try {
    const parsed = JSON.parse(result) as { status?: unknown };
    return typeof parsed.status === "string"
      ? parsed.status.toLowerCase()
      : null;
  } catch {
    return null;
  }
}

function parseHasError(result: string): boolean {
  try {
    const parsed = JSON.parse(result) as { error?: unknown };
    return typeof parsed.error === "string" && parsed.error.trim().length > 0;
  } catch {
    return false;
  }
}

export function getSkillLoadVisualState(
  block: SkillLoadData,
): "tool-running" | "tool-error" | "tool-warning" | "tool-success" {
  if (!block.complete) return "tool-running";
  if (block.remoteDetail?.status === "error") return "tool-error";
  if (block.remoteDetail?.status === "interrupted") return "tool-warning";
  const status = parseResultStatus(block.result);
  if (
    parseHasError(block.result) ||
    status === "error" ||
    status === "failed"
  ) {
    return "tool-error";
  }
  if (
    status === "stopped" ||
    status === "cancelled" ||
    status === "rejected" ||
    status === "rejected_by_user" ||
    status === "timed_out" ||
    status === "force-completed"
  ) {
    return "tool-warning";
  }
  return "tool-success";
}

export function SkillLoadBlock({ block: projectedBlock }: SkillLoadBlockProps) {
  const [expanded, setExpanded] = useState(false);
  const remoteDetail = useRemoteToolDetail(projectedBlock, expanded);
  const block = remoteDetail.block;
  const summary =
    (block.skillName ?? formatPath(block.path)) || "Loading skill…";

  const statusClass = getSkillLoadVisualState(block);
  const statusIconClass =
    statusClass === "tool-running"
      ? "codicon-loading codicon-modifier-spin"
      : statusClass === "tool-error"
        ? "codicon-error"
        : statusClass === "tool-warning"
          ? "codicon-warning"
          : "codicon-library";

  return (
    <div class={`tool-call-block ${statusClass}`}>
      <button
        class="tool-call-header"
        onClick={() => setExpanded(!expanded)}
        type="button"
      >
        <i
          class={`codicon codicon-chevron-${expanded ? "down" : "right"} tool-call-chevron`}
        />
        <i class={`codicon tool-call-status-icon ${statusIconClass}`} />
        <span class="tool-call-name">load_skill</span>
        <span class="tool-call-summary">{summary}</span>
        {block.complete && block.durationMs != null && (
          <span class="tool-call-duration">{block.durationMs}ms</span>
        )}
      </button>

      {expanded && (
        <div class="tool-call-details">
          {projectedBlock.remoteDetail?.available === false && (
            <div class="tool-call-remote-detail tool-warning" role="status">
              This skill detail is unavailable in this AgentLink version. Update
              AgentLink to view it.
            </div>
          )}
          {remoteDetail.loading && (
            <div class="tool-call-remote-detail" role="status">
              Loading full skill detail…
            </div>
          )}
          {remoteDetail.error && (
            <div class="tool-call-remote-detail tool-error" role="alert">
              <span>{remoteDetail.error}</span>
              <button type="button" onClick={remoteDetail.retry}>
                Retry
              </button>
            </div>
          )}
          {block.remoteDetail?.warning && (
            <div class="tool-call-remote-detail tool-warning" role="status">
              <span>{block.remoteDetail.warning}</span>
              <button type="button" onClick={remoteDetail.retry}>
                Retry
              </button>
            </div>
          )}
          {block.skillName && (
            <div class="tool-call-section">
              <div class="tool-call-section-label">Skill</div>
              <pre class="tool-call-code">{block.skillName}</pre>
            </div>
          )}
          {block.path && (
            <div class="tool-call-section">
              <div class="tool-call-section-label">Path</div>
              <pre class="tool-call-code">{block.path}</pre>
            </div>
          )}
          {block.content && (
            <div class="tool-call-section">
              <div class="tool-call-section-label">Content</div>
              <pre class="tool-call-code skill-load-content">
                {block.content}
              </pre>
            </div>
          )}
          {!block.content && block.result && (
            <div class="tool-call-section">
              <div class="tool-call-section-label">Result</div>
              <pre class="tool-call-code">{block.result}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
