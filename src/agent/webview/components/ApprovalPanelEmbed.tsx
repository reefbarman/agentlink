import type { ComponentChildren, RefObject } from "preact";

import type {
  ApprovalRequest,
  DecisionMessage,
} from "../../../approvals/webview/types";
import { CommandCard } from "../../../approvals/webview/components/CommandCard";
import { McpCard } from "../../../approvals/webview/components/McpCard";
import { MemoryCard } from "../../../approvals/webview/components/MemoryCard";
import { ModeSwitchCard } from "../../../approvals/webview/components/ModeSwitchCard";
import { PathCard } from "../../../approvals/webview/components/PathCard";
import { RenameCard } from "../../../approvals/webview/components/RenameCard";
import { WriteCard } from "../../../approvals/webview/components/WriteCard";

export function ApprovalPanelEmbed({
  request,
  height,
  resizing,
  followUpRef,
  submit,
  onResizeStart,
  onSuggestRegex,
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
  actions?: ComponentChildren;
}) {
  return (
    <div
      class={`approval-panel-embed${resizing ? " approval-panel-embed-resizing" : ""}`}
      style={{ height: `${height}px` }}
    >
      <div
        class="approval-panel-embed-handle"
        onMouseDown={(e) => onResizeStart(e as unknown as MouseEvent)}
        title="Drag to resize approval card"
      />
      {actions}
      {request.kind === "command" ? (
        <CommandCard
          request={request}
          submit={submit}
          followUpRef={followUpRef}
          onSuggestRegex={onSuggestRegex}
        />
      ) : request.kind === "write" ? (
        <WriteCard
          request={request}
          submit={submit}
          followUpRef={followUpRef}
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
      ) : (
        <PathCard request={request} submit={submit} followUpRef={followUpRef} />
      )}
    </div>
  );
}
