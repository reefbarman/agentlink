import { describe, expect, it, vi } from "vitest";

import type { CommandApprovalPolicy } from "../approvals/commandApprovalPolicy.js";
import {
  SessionApprovalPolicyCoordinator,
  type AgentWriteApprovalSelection,
} from "./sessionApprovalPolicy.js";

function harness(options?: {
  policy?: CommandApprovalPolicy;
  writeApproval?: AgentWriteApprovalSelection;
  writeUpdateSucceeds?: boolean;
}) {
  let policy = options?.policy ?? "safe";
  let writeApproval = options?.writeApproval ?? "prompt";
  const setCommandApprovalPolicy = vi.fn(
    (_sessionId: string, next: CommandApprovalPolicy) => {
      policy = next;
    },
  );
  const setAgentWriteApprovalSelection = vi.fn(
    (
      _sessionId: string,
      next: AgentWriteApprovalSelection,
      _targetPath?: string,
    ) => {
      if (options?.writeUpdateSucceeds === false) return false;
      writeApproval = next;
      return true;
    },
  );
  const resetSessionAgentWriteApproval = vi.fn(() => {
    if (writeApproval === "session") writeApproval = "prompt";
  });
  const coordinator = new SessionApprovalPolicyCoordinator({
    getCommandApprovalPolicy: () => policy,
    setCommandApprovalPolicy,
    getAgentWriteApprovalState: () => writeApproval,
    setAgentWriteApprovalSelection,
    resetSessionAgentWriteApproval,
  });

  return {
    coordinator,
    setCommandApprovalPolicy,
    setAgentWriteApprovalSelection,
    resetSessionAgentWriteApproval,
    state: () => ({ policy, writeApproval }),
  };
}

describe("SessionApprovalPolicyCoordinator", () => {
  it.each([
    ["prompt", "session"],
    ["session", "session"],
    ["project", "project"],
    ["global", "global"],
  ] as const)(
    "enables Approve for Me from %s with resulting %s write approval",
    (initial, expected) => {
      const test = harness({ writeApproval: initial });

      expect(
        test.coordinator.setCommandApprovalPolicy(
          "session-1",
          "approve-for-me",
          "safe",
          "/workspace",
        ),
      ).toMatchObject({
        ok: true,
        commandApprovalPolicy: "approve-for-me",
        agentWriteApproval: expected,
      });
      expect(test.state()).toEqual({
        policy: "approve-for-me",
        writeApproval: expected,
      });
      expect(test.setAgentWriteApprovalSelection).toHaveBeenCalledTimes(
        initial === "prompt" ? 1 : 0,
      );
    },
  );

  it("does not enable Approve for Me when the required session write grant fails", () => {
    const test = harness({ writeUpdateSucceeds: false });

    expect(
      test.coordinator.setCommandApprovalPolicy(
        "session-1",
        "approve-for-me",
        "safe",
      ),
    ).toEqual({
      ok: false,
      commandApprovalPolicy: "safe",
      agentWriteApproval: "prompt",
    });
    expect(test.setCommandApprovalPolicy).not.toHaveBeenCalled();
  });

  it.each([
    ["session", "prompt"],
    ["project", "project"],
    ["global", "global"],
  ] as const)(
    "disables Approve for Me from %s while preserving the correct write scope",
    (initial, expected) => {
      const test = harness({
        policy: "approve-for-me",
        writeApproval: initial,
      });

      expect(
        test.coordinator.setCommandApprovalPolicy(
          "session-1",
          "sensitive",
          "safe",
        ),
      ).toMatchObject({
        ok: true,
        commandApprovalPolicy: "sensitive",
        agentWriteApproval: expected,
      });
      expect(test.resetSessionAgentWriteApproval).toHaveBeenCalledTimes(
        initial === "session" ? 1 : 0,
      );
    },
  );

  it("turns off Approve for Me when Prompt is selected", () => {
    const test = harness({
      policy: "approve-for-me",
      writeApproval: "project",
    });

    expect(
      test.coordinator.setWriteApproval(
        "session-1",
        "prompt",
        "sensitive",
        "/workspace",
      ),
    ).toEqual({
      ok: true,
      commandApprovalPolicy: "sensitive",
      agentWriteApproval: "prompt",
    });
  });

  it("turns off Approve for Me even when selecting Prompt fails to persist", () => {
    const test = harness({
      policy: "approve-for-me",
      writeApproval: "session",
      writeUpdateSucceeds: false,
    });

    expect(
      test.coordinator.setWriteApproval("session-1", "prompt", "safe"),
    ).toEqual({
      ok: false,
      commandApprovalPolicy: "safe",
      agentWriteApproval: "session",
    });
  });

  it.each(["session", "project", "global"] as const)(
    "keeps Approve for Me on when selecting %s write approval",
    (selection) => {
      const test = harness({ policy: "approve-for-me" });

      expect(
        test.coordinator.setWriteApproval("session-1", selection, "safe"),
      ).toMatchObject({
        ok: true,
        commandApprovalPolicy: "approve-for-me",
        agentWriteApproval: selection,
      });
    },
  );

  it("preserves session writes across mode switches while Approve for Me is on", () => {
    const test = harness({
      policy: "approve-for-me",
      writeApproval: "session",
    });

    test.coordinator.reconcileAfterModeSwitch("session-1", "safe");

    expect(test.resetSessionAgentWriteApproval).not.toHaveBeenCalled();
    expect(test.state().writeApproval).toBe("session");
  });

  it("resets only session writes across mode switches without Approve for Me", () => {
    const test = harness({ policy: "safe", writeApproval: "session" });

    test.coordinator.reconcileAfterModeSwitch("session-1", "safe");

    expect(test.resetSessionAgentWriteApproval).toHaveBeenCalledOnce();
    expect(test.state().writeApproval).toBe("prompt");
  });

  it("repairs a restored Approve for Me session missing its write grant", () => {
    const test = harness({ policy: "approve-for-me" });

    expect(
      test.coordinator.reconcileRestoredSession(
        "session-1",
        "safe",
        "/workspace",
      ),
    ).toEqual({
      ok: true,
      commandApprovalPolicy: "approve-for-me",
      agentWriteApproval: "session",
    });
  });

  it("fails restored mismatch reconciliation closed", () => {
    const test = harness({
      policy: "approve-for-me",
      writeUpdateSucceeds: false,
    });

    expect(
      test.coordinator.reconcileRestoredSession("session-1", "sensitive"),
    ).toEqual({
      ok: false,
      commandApprovalPolicy: "sensitive",
      agentWriteApproval: "prompt",
    });
  });
});
