import type { CommandApprovalPolicy } from "./commandApprovalPolicy.js";
import type { CoreReasoningEffort } from "./modelCatalog.js";

export type WriteApprovalSelection =
  | "prompt"
  | "session"
  | "project"
  | "global";

export function isWriteApprovalSelection(
  value: unknown,
): value is WriteApprovalSelection {
  return (
    value === "prompt" ||
    value === "session" ||
    value === "project" ||
    value === "global"
  );
}

export type SelectionCommand =
  | { type: "mode"; mode: string }
  | { type: "model"; model: string }
  | { type: "reasoningEffort"; effort: CoreReasoningEffort }
  | { type: "writeApproval"; mode: WriteApprovalSelection }
  | {
      type: "commandApprovalPolicy";
      policy: CommandApprovalPolicy;
    };

export type VsCodeSelectionMessage =
  | { command: "agentSwitchMode"; mode: string }
  | { command: "agentSetModel"; model: string }
  | { command: "agentSetReasoningEffort"; effort: CoreReasoningEffort }
  | { command: "agentSetWriteApproval"; mode: WriteApprovalSelection }
  | { command: "agentSetCommandApprovalPolicy"; policy: CommandApprovalPolicy };

export type HttpSelectionRequest =
  | { path: "/api/mode"; body: { mode: string } }
  | { path: "/api/model"; body: { model: string } }
  | { path: "/api/thinking"; body: { effort: CoreReasoningEffort } }
  | {
      path: "/api/write-approval";
      body: { mode: WriteApprovalSelection };
    }
  | {
      path: "/api/command-approval-policy";
      body: { policy: CommandApprovalPolicy };
    };

export function toVsCodeSelectionMessage(
  command: SelectionCommand,
): VsCodeSelectionMessage {
  switch (command.type) {
    case "mode":
      return { command: "agentSwitchMode", mode: command.mode };
    case "model":
      return { command: "agentSetModel", model: command.model };
    case "reasoningEffort":
      return {
        command: "agentSetReasoningEffort",
        effort: command.effort,
      };
    case "writeApproval":
      return { command: "agentSetWriteApproval", mode: command.mode };
    case "commandApprovalPolicy":
      return {
        command: "agentSetCommandApprovalPolicy",
        policy: command.policy,
      };
  }
}

export function toHttpSelectionRequest(
  command: SelectionCommand,
): HttpSelectionRequest {
  switch (command.type) {
    case "mode":
      return { path: "/api/mode", body: { mode: command.mode } };
    case "model":
      return { path: "/api/model", body: { model: command.model } };
    case "reasoningEffort":
      return { path: "/api/thinking", body: { effort: command.effort } };
    case "writeApproval":
      return { path: "/api/write-approval", body: { mode: command.mode } };
    case "commandApprovalPolicy":
      return {
        path: "/api/command-approval-policy",
        body: { policy: command.policy },
      };
  }
}
