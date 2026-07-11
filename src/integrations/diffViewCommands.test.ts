import { beforeEach, describe, expect, it, vi } from "vitest";

import { registerDiffViewCommands } from "./diffViewCommands.js";

const { registerCommand, resolveCurrentDiff, showDiffMoreOptions } = vi.hoisted(
  () => ({
    registerCommand: vi.fn(),
    resolveCurrentDiff: vi.fn(),
    showDiffMoreOptions: vi.fn(),
  }),
);

vi.mock("vscode", () => ({
  commands: { registerCommand },
}));

vi.mock("./DiffViewProvider.js", () => ({
  resolveCurrentDiff,
  showDiffMoreOptions,
}));

describe("registerDiffViewCommands", () => {
  beforeEach(() => {
    registerCommand.mockReset();
    resolveCurrentDiff.mockReset();
    showDiffMoreOptions.mockReset();
  });

  it("registers the three diff commands and returns their disposables", () => {
    const disposables = [
      { dispose: vi.fn() },
      { dispose: vi.fn() },
      { dispose: vi.fn() },
    ];
    registerCommand
      .mockReturnValueOnce(disposables[0])
      .mockReturnValueOnce(disposables[1])
      .mockReturnValueOnce(disposables[2]);

    expect(registerDiffViewCommands()).toEqual(disposables);
    expect(registerCommand.mock.calls.map(([command]) => command)).toEqual([
      "agentlink.acceptDiff",
      "agentlink.acceptDiffMore",
      "agentlink.rejectDiff",
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
