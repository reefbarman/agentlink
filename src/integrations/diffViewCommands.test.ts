import { beforeEach, describe, expect, it, vi } from "vitest";

import { registerDiffViewCommands } from "./diffViewCommands.js";

const {
  registerCommand,
  revealPendingDiff,
  resolveCurrentDiff,
  showDiffMoreOptions,
} = vi.hoisted(() => ({
  registerCommand: vi.fn(),
  revealPendingDiff: vi.fn(),
  resolveCurrentDiff: vi.fn(),
  showDiffMoreOptions: vi.fn(),
}));

vi.mock("vscode", () => ({
  commands: { registerCommand },
}));

vi.mock("./DiffViewProvider.js", () => ({
  revealPendingDiff,
  resolveCurrentDiff,
  showDiffMoreOptions,
}));

describe("registerDiffViewCommands", () => {
  beforeEach(() => {
    registerCommand.mockReset();
    revealPendingDiff.mockReset();
    resolveCurrentDiff.mockReset();
    showDiffMoreOptions.mockReset();
  });

  it("registers the four diff commands and returns their disposables", () => {
    const disposables = [
      { dispose: vi.fn() },
      { dispose: vi.fn() },
      { dispose: vi.fn() },
      { dispose: vi.fn() },
    ];
    registerCommand
      .mockReturnValueOnce(disposables[0])
      .mockReturnValueOnce(disposables[1])
      .mockReturnValueOnce(disposables[2])
      .mockReturnValueOnce(disposables[3]);

    expect(registerDiffViewCommands()).toEqual(disposables);
    expect(registerCommand.mock.calls.map(([command]) => command)).toEqual([
      "agentlink.acceptDiff",
      "agentlink.acceptDiffMore",
      "agentlink.rejectDiff",
      "agentlink.revealDiff",
    ]);
  });

  it.each([
    ["agentlink.acceptDiff", "accept"],
    ["agentlink.rejectDiff", "reject"],
  ] as const)("dispatches %s to resolveCurrentDiff", (command, decision) => {
    registerDiffViewCommands();

    const handler = registerCommand.mock.calls.find(
      ([registeredCommand]) => registeredCommand === command,
    )?.[1];
    expect(handler).toBeTypeOf("function");

    handler();
    expect(resolveCurrentDiff).toHaveBeenCalledOnce();
    expect(resolveCurrentDiff).toHaveBeenCalledWith(decision);
    expect(showDiffMoreOptions).not.toHaveBeenCalled();
  });

  it("reveals the pending diff by request id", async () => {
    revealPendingDiff.mockResolvedValue(true);
    registerDiffViewCommands();

    const handler = registerCommand.mock.calls.find(
      ([command]) => command === "agentlink.revealDiff",
    )?.[1];
    expect(handler).toBeTypeOf("function");

    await expect(handler("diff-request-1")).resolves.toBe(true);
    expect(revealPendingDiff).toHaveBeenCalledWith("diff-request-1");
    expect(resolveCurrentDiff).not.toHaveBeenCalled();
  });

  it("dispatches acceptDiffMore to showDiffMoreOptions", () => {
    registerDiffViewCommands();

    const handler = registerCommand.mock.calls.find(
      ([command]) => command === "agentlink.acceptDiffMore",
    )?.[1];
    expect(handler).toBeTypeOf("function");

    handler();
    expect(showDiffMoreOptions).toHaveBeenCalledOnce();
    expect(resolveCurrentDiff).not.toHaveBeenCalled();
  });
});
