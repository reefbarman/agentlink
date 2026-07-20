import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("vscode", async () => await import("../__mocks__/vscode.js"));

import * as vscode from "vscode";
import {
  DEFAULT_AGENT_VIEW_OPENED_KEY,
  openDefaultAgentViewOnce,
  OPEN_AGENTLINK_TERMINAL_COMMAND,
  registerAgentWorkbenchLayout,
  type AgentWorkbenchLayoutOptions,
} from "./workbenchLayout.js";

const commandHandlers = new Map<string, (...args: unknown[]) => unknown>();

function createOptions(
  overrides: Partial<AgentWorkbenchLayoutOptions> = {},
): AgentWorkbenchLayoutOptions {
  const state = new Map<string, unknown>();
  return {
    terminalViewId: "agentLink.terminalView",
    agentViewId: "agentLink.chatView",
    workspaceState: {
      get: vi.fn((key: string) => state.get(key)),
      update: vi.fn(async (key: string, value: unknown) => {
        state.set(key, value);
      }),
    },
    waitForTerminalReady: vi.fn(async () => {}),
    isTerminalAvailable: vi.fn(() => true),
    log: vi.fn(),
    ...overrides,
  };
}

async function invoke(command: string): Promise<void> {
  const handler = commandHandlers.get(command);
  expect(handler).toBeTypeOf("function");
  await handler!();
}

describe("Agent workbench layout", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    commandHandlers.clear();
    vi.spyOn(vscode.commands, "registerCommand").mockImplementation(
      (command: string, callback: (...args: unknown[]) => unknown) => {
        commandHandlers.set(command, callback);
        return { dispose: vi.fn() };
      },
    );
    vi.spyOn(vscode.commands, "executeCommand").mockResolvedValue(undefined);
    vi.spyOn(vscode.window, "showInformationMessage").mockResolvedValue(
      undefined,
    );
  });

  it("registers a command that waits for and focuses the AgentLink terminal", async () => {
    const options = createOptions();

    expect(registerAgentWorkbenchLayout(options)).toHaveLength(1);
    await invoke(OPEN_AGENTLINK_TERMINAL_COMMAND);

    expect(options.waitForTerminalReady).toHaveBeenCalledOnce();
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      "agentLink.terminalView.focus",
    );
    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
  });

  it("offers the terminal setting when the custom terminal is unavailable", async () => {
    const options = createOptions({ isTerminalAvailable: () => false });
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValue(
      "Open Settings" as never,
    );

    registerAgentWorkbenchLayout(options);
    await invoke(OPEN_AGENTLINK_TERMINAL_COMMAND);

    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      "AgentLink Terminal is disabled or unavailable on this host.",
      "Open Settings",
    );
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      "workbench.action.openSettings",
      "agentlink.terminal.enabled",
    );
  });

  it("handles readiness failures through the unavailable-terminal flow", async () => {
    const options = createOptions({
      waitForTerminalReady: vi.fn(async () => {
        throw new Error("runtime failed");
      }),
      isTerminalAvailable: () => false,
    });

    registerAgentWorkbenchLayout(options);
    await invoke(OPEN_AGENTLINK_TERMINAL_COMMAND);

    expect(options.log).toHaveBeenCalledWith(
      "Unable to prepare AgentLink Terminal: Error: runtime failed",
    );
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      "AgentLink Terminal is disabled or unavailable on this host.",
      "Open Settings",
    );
  });

  it("opens the Agent view once per workspace", async () => {
    const options = createOptions();

    await openDefaultAgentViewOnce(options);
    await openDefaultAgentViewOnce(options);

    expect(vscode.commands.executeCommand).toHaveBeenCalledTimes(1);
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      "agentLink.chatView.focus",
    );
    expect(options.workspaceState.update).toHaveBeenCalledWith(
      DEFAULT_AGENT_VIEW_OPENED_KEY,
      true,
    );
  });

  it("does not mark the Agent view opened when focus fails", async () => {
    const options = createOptions();
    vi.mocked(vscode.commands.executeCommand).mockRejectedValueOnce(
      new Error("focus failed"),
    );

    await openDefaultAgentViewOnce(options);

    expect(options.workspaceState.update).not.toHaveBeenCalled();
    expect(options.log).toHaveBeenCalledWith(
      "Unable to open the default Agent view: Error: focus failed",
    );
  });
});
