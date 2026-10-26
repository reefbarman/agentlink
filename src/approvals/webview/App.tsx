import type {
  ApprovalRequest,
  DecisionMessage,
  ExtensionMessage,
} from "@agentlink/protocol/approval-transport";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";

import { CommandCard } from "./components/CommandCard.js";
import { HookCard } from "./components/HookCard.js";
import { IdleState } from "./components/IdleState.js";
import { McpCard } from "./components/McpCard.js";
import { MemoryCard } from "./components/MemoryCard.js";
import { ModeSwitchCard } from "./components/ModeSwitchCard.js";
import { NetworkCard } from "./components/NetworkCard.js";
import { PathCard } from "./components/PathCard.js";
import { RenameCard } from "./components/RenameCard.js";
import { WorktreeCard } from "./components/WorktreeCard.js";
import { WriteCard } from "./components/WriteCard.js";

interface VsCodeApi {
  postMessage(message: unknown): void;
}

interface AppProps {
  vscodeApi: VsCodeApi;
}

export function App({ vscodeApi }: AppProps) {
  const [request, setRequest] = useState<ApprovalRequest | null>(null);
  const followUpRef = useRef("");

  const submit = useCallback(
    (data: Omit<DecisionMessage, "type">) => {
      const followUp = followUpRef.current.trim();
      vscodeApi.postMessage({
        type: "decision",
        ...data,
        approvalKind: request?.kind,
        ...(followUp && { followUp }),
      });
      followUpRef.current = "";
    },
    [request?.kind, vscodeApi],
  );

  useEffect(() => {
    const handler = (event: MessageEvent<ExtensionMessage>) => {
      const msg = event.data;
      if (msg.type === "showApproval") {
        setRequest(msg.request);
      } else if (msg.type === "idle") {
        setRequest(null);
      }
    };
    window.addEventListener("message", handler);
    vscodeApi.postMessage({ type: "webviewReady" });
    return () => window.removeEventListener("message", handler);
  }, [vscodeApi]);

  if (!request) return <IdleState />;

  switch (request.kind) {
    case "command":
      return (
        <CommandCard
          key={request.id}
          request={request}
          submit={submit}
          followUpRef={followUpRef}
        />
      );

    case "network":
      return (
        <NetworkCard
          key={request.id}
          request={request}
          submit={submit}
          followUpRef={followUpRef}
        />
      );
    case "path":
      return (
        <PathCard
          key={request.id}
          request={request}
          submit={submit}
          followUpRef={followUpRef}
        />
      );
    case "write":
      return (
        <WriteCard
          key={request.id}
          request={request}
          submit={submit}
          followUpRef={followUpRef}
        />
      );
    case "rename":
      return (
        <RenameCard
          key={request.id}
          request={request}
          submit={submit}
          followUpRef={followUpRef}
        />
      );
    case "memory":
      return (
        <MemoryCard
          key={request.id}
          request={request}
          submit={submit}
          followUpRef={followUpRef}
        />
      );
    case "mcp":
      return (
        <McpCard
          key={request.id}
          request={request}
          submit={submit}
          followUpRef={followUpRef}
        />
      );
    case "mode-switch":
      return (
        <ModeSwitchCard
          key={request.id}
          request={request}
          submit={submit}
          followUpRef={followUpRef}
        />
      );
    case "hook":
      return (
        <HookCard
          key={request.id}
          request={request}
          submit={submit}
          followUpRef={followUpRef}
        />
      );
    case "worktree":
      return (
        <WorktreeCard
          key={request.id}
          request={request}
          submit={submit}
          followUpRef={followUpRef}
        />
      );
  }
}
