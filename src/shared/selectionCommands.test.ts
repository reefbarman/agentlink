import { describe, expect, expectTypeOf, it } from "vitest";

import {
  isWriteApprovalSelection,
  toHttpSelectionRequest,
  toVsCodeSelectionMessage,
  type WriteApprovalSelection,
} from "./selectionCommands.js";

describe("selection commands protocol compatibility shim", () => {
  it("preserves write-approval validation and both transport adapters", () => {
    expectTypeOf<WriteApprovalSelection>().toEqualTypeOf<
      "prompt" | "session" | "project" | "global"
    >();
    expect(isWriteApprovalSelection("project")).toBe(true);
    expect(isWriteApprovalSelection("workspace")).toBe(false);
    expect(
      toVsCodeSelectionMessage({
        type: "commandApprovalPolicy",
        policy: "approve-for-me",
      }),
    ).toEqual({
      command: "agentSetCommandApprovalPolicy",
      policy: "approve-for-me",
    });
    expect(
      toHttpSelectionRequest({ type: "reasoningEffort", effort: "high" }),
    ).toEqual({ path: "/api/thinking", body: { effort: "high" } });
  });
});
