import { describe, expect, it } from "vitest";

import {
  isWriteApprovalSelection,
  type SelectionCommand,
  toHttpSelectionRequest,
  toVsCodeSelectionMessage,
} from "./selectionCommands.js";

const vectors: Array<{
  command: SelectionCommand;
  vscode: Record<string, string>;
  http: { path: string; body: Record<string, string> };
}> = [
  {
    command: { type: "mode", mode: "architect" },
    vscode: { command: "agentSwitchMode", mode: "architect" },
    http: { path: "/api/mode", body: { mode: "architect" } },
  },
  {
    command: { type: "model", model: "gpt-5.3-codex" },
    vscode: { command: "agentSetModel", model: "gpt-5.3-codex" },
    http: { path: "/api/model", body: { model: "gpt-5.3-codex" } },
  },
  {
    command: { type: "reasoningEffort", effort: "high" },
    vscode: { command: "agentSetReasoningEffort", effort: "high" },
    http: { path: "/api/thinking", body: { effort: "high" } },
  },
  {
    command: { type: "writeApproval", mode: "project" },
    vscode: { command: "agentSetWriteApproval", mode: "project" },
    http: { path: "/api/write-approval", body: { mode: "project" } },
  },
  {
    command: {
      type: "commandApprovalPolicy",
      policy: "approve-for-me",
    },
    vscode: {
      command: "agentSetCommandApprovalPolicy",
      policy: "approve-for-me",
    },
    http: {
      path: "/api/command-approval-policy",
      body: { policy: "approve-for-me" },
    },
  },
];

describe("selection command adapters", () => {
  it.each(["prompt", "session", "project", "global"])(
    "accepts the %s write-approval selection",
    (value) => {
      expect(isWriteApprovalSelection(value)).toBe(true);
    },
  );

  it.each(["", "always", "workspace", undefined, null])(
    "rejects the unsupported write-approval selection %s",
    (value) => {
      expect(isWriteApprovalSelection(value)).toBe(false);
    },
  );

  it.each(vectors)("adapts $command.type with equivalent values", (vector) => {
    expect(toVsCodeSelectionMessage(vector.command)).toEqual(vector.vscode);
    expect(toHttpSelectionRequest(vector.command)).toEqual(vector.http);
    expect(Object.values(vector.vscode).at(-1)).toBe(
      Object.values(vector.http.body)[0],
    );
  });
});
