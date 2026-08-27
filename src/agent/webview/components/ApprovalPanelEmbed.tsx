import type {
  ApprovalRequest,
  DecisionMessage,
} from "../../../approvals/webview/types";
import type { ComponentChildren, RefObject } from "preact";

import { CommandCard } from "../../../approvals/webview/components/CommandCard";
import { HookCard } from "../../../approvals/webview/components/HookCard";
import { McpCard } from "../../../approvals/webview/components/McpCard";
import { MemoryCard } from "../../../approvals/webview/components/MemoryCard";
import { ModeSwitchCard } from "../../../approvals/webview/components/ModeSwitchCard";
import { NetworkCard } from "../../../approvals/webview/components/NetworkCard";
import { PathCard } from "../../../approvals/webview/components/PathCard";
import { RenameCard } from "../../../approvals/webview/components/RenameCard";
import { WorktreeCard } from "../../../approvals/webview/components/WorktreeCard";
import { WriteCard } from "../../../approvals/webview/components/WriteCard";

export const DEFAULT_APPROVAL_PANEL_HEIGHT = 240;
export const MIN_APPROVAL_PANEL_HEIGHT = 220;

export function ApprovalPanelEmbed({
  request,
  height,
  resizing,
  followUpRef,
  submit,
  onResizeStart,
  onSuggestRegex,
  onRevealDiff,
  actions,
}: {
  request: ApprovalRequest;
  height: number;
  resizing: boolean;
  followUpRef: RefObject<string>;
  submit: (data: Omit<DecisionMessage, "type">) => void;
  onResizeStart: (event: MouseEvent) => void;
  onSuggestRegex?: (args: {
    subCommand: string;
    fullCommand: string;
  }) => Promise<string>;
  onRevealDiff?: (requestId: string) => void;
  actions?: ComponentChildren;
}) {
  return (
    <div
      class={`approval-panel-embed${resizing ? " approval-panel-embed-resizing" : ""}`}
      style={{ minHeight: `${height}px` }}
    >
      <div
        class="approval-panel-embed-handle"
        onMouseDown={(e) => onResizeStart(e as unknown as MouseEvent)}
        title="Drag to resize approval card"
      />
      {actions}
      {request.backgroundTask && (
        <div
          class="approval-background-attribution"
          title={request.backgroundTask}
        >
          <span class="codicon codicon-multiple-windows" aria-hidden="true" />
          <span>
            From background agent: <strong>{request.backgroundTask}</strong>
          </span>
        </div>
      )}
      {request.kind === "command" ? (
        <CommandCard
          request={request}
          submit={submit}
          followUpRef={followUpRef}
          onSuggestRegex={onSuggestRegex}
        />
      ) : request.kind === "network" ? (
        <NetworkCard
          request={request}
          submit={submit}
          followUpRef={followUpRef}
        />
      ) : request.kind === "write" ? (
        <WriteCard
          request={request}
          submit={submit}
          followUpRef={followUpRef}
          onRevealDiff={onRevealDiff}
        />
      ) : request.kind === "rename" ? (
        <RenameCard
          request={request}
          submit={submit}
          followUpRef={followUpRef}
        />
      ) : request.kind === "mcp" ? (
        <McpCard request={request} submit={submit} followUpRef={followUpRef} />
      ) : request.kind === "memory" ? (
        <MemoryCard
          request={request}
          submit={submit}
          followUpRef={followUpRef}
        />
      ) : request.kind === "mode-switch" ? (
        <ModeSwitchCard
          request={request}
          submit={submit}
          followUpRef={followUpRef}
        />
      ) : request.kind === "worktree" ? (
        <WorktreeCard
          request={request}
          submit={submit}
          followUpRef={followUpRef}
        />
      ) : request.kind === "hook" ? (
        <HookCard request={request} submit={submit} followUpRef={followUpRef} />
      ) : (
        <PathCard request={request} submit={submit} followUpRef={followUpRef} />
      )}
    </div>
  );
}
