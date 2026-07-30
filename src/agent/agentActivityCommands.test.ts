import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("vscode", async () => await import("../__mocks__/vscode.js"));

import * as vscode from "vscode";
import {
  registerAgentActivityCommands,
  type AgentActivityCommandDependencies,
} from "./agentActivityCommands.js";

const commandHandlers = new Map<string, (...args: unknown[]) => unknown>();

function createDependencies(): AgentActivityCommandDependencies {
  return {
    addTrustedCommand: vi.fn(async () => {}),
    approvalPanel: {
      focusApproval: vi.fn(),
    },
    pendingInteractionTarget: {
      focusPendingInteraction: vi.fn(async () => false),
    },
    toolCallTracker: {
      cancelCall: vi.fn(),
      continueInBackground: vi.fn(),
      completeCall: vi.fn(),
    },
    approvalManager: {
      getActiveSessions: vi.fn(() => [
        { id: "session-1" },
        { id: "session-2" },
      ]),
      clearSession: vi.fn(),
      resetWriteApproval: vi.fn(),
      resetAgentWriteApproval: vi.fn(),
    },
  };
}

async function invoke(command: string, ...args: unknown[]): Promise<void> {
  const handler = commandHandlers.get(command);
  expect(handler).toBeTypeOf("function");
  await handler!(...args);
}

describe("registerAgentActivityCommands", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    commandHandlers.clear();
    vi.spyOn(vscode.commands, "registerCommand").mockImplementation(
      (command: string, callback: (...args: unknown[]) => unknown) => {
        commandHandlers.set(command, callback);
        return { dispose: vi.fn() };
      },
    );
    vi.spyOn(vscode.window, "showInformationMessage").mockResolvedValue(
      undefined,
    );
  });

  it("registers the complete agent activity command group", () => {
    const disposables = registerAgentActivityCommands(createDependencies());

    expect([...commandHandlers.keys()]).toEqual([
      "agentlink.addTrustedCommand",
      "agentLink.focusApproval",
      "agentlink.cancelToolCall",
      "agentlink.continueToolCallInBackground",
      "agentlink.completeToolCall",
      "agentlink.clearSessionApprovals",
    ]);
    expect(disposables).toHaveLength(6);
  });

  it("forwards trusted-command and external approval-focus actions", async () => {
    const dependencies = createDependencies();
    registerAgentActivityCommands(dependencies);

    await invoke("agentlink.addTrustedCommand");
    await invoke("agentLink.focusApproval");

    expect(dependencies.addTrustedCommand).toHaveBeenCalledOnce();
    expect(
      dependencies.pendingInteractionTarget.focusPendingInteraction,
    ).not.toHaveBeenCalled();
    expect(dependencies.approvalPanel.focusApproval).toHaveBeenCalledOnce();
  });

  it("focuses the requested built-in session without opening the external panel", async () => {
    const dependencies = createDependencies();
    vi.mocked(
      dependencies.pendingInteractionTarget.focusPendingInteraction,
    ).mockResolvedValue(true);
    registerAgentActivityCommands(dependencies);

    await invoke("agentLink.focusApproval", { sessionId: "session-2" });

    expect(
      dependencies.pendingInteractionTarget.focusPendingInteraction,
    ).toHaveBeenCalledWith("session-2");
    expect(dependencies.approvalPanel.focusApproval).not.toHaveBeenCalled();
  });

  it("falls back to the external panel when a built-in session cannot be focused", async () => {
    const dependencies = createDependencies();
    registerAgentActivityCommands(dependencies);

    await invoke("agentLink.focusApproval", { sessionId: "missing-session" });

    expect(
      dependencies.pendingInteractionTarget.focusPendingInteraction,
    ).toHaveBeenCalledWith("missing-session");
    expect(dependencies.approvalPanel.focusApproval).toHaveBeenCalledOnce();
  });

  it("falls back to the external panel when built-in focus throws", async () => {
    const dependencies = createDependencies();
    vi.mocked(
      dependencies.pendingInteractionTarget.focusPendingInteraction,
    ).mockRejectedValue(new Error("session hydration failed"));
    registerAgentActivityCommands(dependencies);

    await invoke("agentLink.focusApproval", { sessionId: "session-2" });

    expect(dependencies.approvalPanel.focusApproval).toHaveBeenCalledOnce();
  });

  it.each([
    ["agentlink.cancelToolCall", "cancelCall"],
    ["agentlink.continueToolCallInBackground", "continueInBackground"],
    ["agentlink.completeToolCall", "completeCall"],
  ] as const)("forwards %s with the tool call id", async (command, method) => {
    const dependencies = createDependencies();
    registerAgentActivityCommands(dependencies);

    await invoke(command, "tool-call-1");

    expect(dependencies.toolCallTracker[method]).toHaveBeenCalledWith(
      "tool-call-1",
    );
  });

  it("clears active sessions and both write approval channels", async () => {
    const dependencies = createDependencies();
    registerAgentActivityCommands(dependencies);

    await invoke("agentlink.clearSessionApprovals");

    expect(dependencies.approvalManager.clearSession).toHaveBeenNthCalledWith(
      1,
      "session-1",
    );
    expect(dependencies.approvalManager.clearSession).toHaveBeenNthCalledWith(
      2,
      "session-2",
    );
    expect(
      dependencies.approvalManager.resetWriteApproval,
    ).toHaveBeenCalledOnce();
    expect(
      dependencies.approvalManager.resetAgentWriteApproval,
    ).toHaveBeenCalledOnce();
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      "All built-in agent session approvals cleared.",
    );
  });
});
