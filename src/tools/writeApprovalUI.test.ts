import {
  decisionToScope,
  saveInlineWriteTrustRules,
  saveWriteTrustRules,
} from "./writeApprovalUI.js";
import { describe, expect, it, vi } from "vitest";

import type { ApprovalManager } from "../approvals/ApprovalManager.js";

function createApprovalManagerMock(): Pick<
  ApprovalManager,
  "setAgentWriteApproval" | "addWriteRule" | "addPathRule"
> {
  return {
    setAgentWriteApproval: vi.fn(),
    addWriteRule: vi.fn(),
    addPathRule: vi.fn(),
  };
}

describe("decisionToScope", () => {
  it("maps accept-session to session", () => {
    expect(decisionToScope("accept-session")).toBe("session");
  });

  it("maps accept-project to project", () => {
    expect(decisionToScope("accept-project")).toBe("project");
  });

  it("maps accept-always to global", () => {
    expect(decisionToScope("accept-always")).toBe("global");
  });

  it("returns null for accept (run-once)", () => {
    expect(decisionToScope("accept")).toBeNull();
  });

  it("returns null for reject", () => {
    expect(decisionToScope("reject")).toBeNull();
  });
});

describe("saveWriteTrustRules", () => {
  it("defaults scoped approvals without a trustScope to all-files approval", () => {
    const approvalManager = createApprovalManagerMock();

    saveWriteTrustRules({
      panelResponse: { decision: "accept-session" },
      approvalManager: approvalManager as ApprovalManager,
      sessionId: "session-1",
      relPath: "src/file.ts",
      inWorkspace: true,
    });

    expect(approvalManager.setAgentWriteApproval).toHaveBeenCalledWith(
      "session-1",
      "session",
    );
    expect(approvalManager.addWriteRule).not.toHaveBeenCalled();
  });

  it("saves inline all-files trust scopes as blanket approval", () => {
    const approvalManager = createApprovalManagerMock();

    saveInlineWriteTrustRules({
      response: { decision: "accept-session", trustScope: "all-files" },
      approvalManager: approvalManager as ApprovalManager,
      sessionId: "session-1",
      relPath: "src/file.ts",
    });

    expect(approvalManager.setAgentWriteApproval).toHaveBeenCalledWith(
      "session-1",
      "session",
    );
  });

  it("saves pattern trust scopes as write rules", () => {
    const approvalManager = createApprovalManagerMock();

    saveInlineWriteTrustRules({
      response: {
        decision: "accept-project",
        trustScope: "pattern",
        rulePattern: "src/**/*.ts",
        ruleMode: "glob",
      },
      approvalManager: approvalManager as ApprovalManager,
      sessionId: "session-1",
      relPath: "src/file.ts",
    });

    expect(approvalManager.addWriteRule).toHaveBeenCalledWith(
      "session-1",
      { pattern: "src/**/*.ts", mode: "glob" },
      "project",
    );
    expect(approvalManager.setAgentWriteApproval).not.toHaveBeenCalled();
  });
});
