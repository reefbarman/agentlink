import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("vscode", async () => await import("../__mocks__/vscode.js"));

import * as vscode from "vscode";
import {
  registerIndexCommands,
  type IndexCommandTarget,
} from "./indexCommands.js";

const commandHandlers = new Map<string, (...args: unknown[]) => unknown>();

function createTarget(): IndexCommandTarget {
  return {
    startIndexing: vi.fn(),
    cancelIndexing: vi.fn(),
  };
}

async function invoke(command: string): Promise<void> {
  const handler = commandHandlers.get(command);
  expect(handler).toBeTypeOf("function");
  await handler!();
}

describe("registerIndexCommands", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    commandHandlers.clear();
    vi.spyOn(vscode.commands, "registerCommand").mockImplementation(
      (command: string, callback: (...args: unknown[]) => unknown) => {
        commandHandlers.set(command, callback);
        return { dispose: vi.fn() };
      },
    );
  });

  it("registers the complete index command group", () => {
    const disposables = registerIndexCommands(() => null);

    expect([...commandHandlers.keys()]).toEqual([
      "agentlink.rebuildIndex",
      "agentlink.cancelIndex",
      "agentlink.resumeIndex",
    ]);
    expect(disposables).toHaveLength(3);
  });

  it("forwards rebuild, cancel, and resume to the current manager", async () => {
    const target = createTarget();
    registerIndexCommands(() => target);

    await invoke("agentlink.rebuildIndex");
    await invoke("agentlink.cancelIndex");
    await invoke("agentlink.resumeIndex");

    expect(target.startIndexing).toHaveBeenNthCalledWith(1, true);
    expect(target.cancelIndexing).toHaveBeenCalledOnce();
    expect(target.startIndexing).toHaveBeenNthCalledWith(2, false);
  });

  it("resolves the manager at command invocation time", async () => {
    const first = createTarget();
    const second = createTarget();
    let current: IndexCommandTarget | null = first;
    registerIndexCommands(() => current);

    await invoke("agentlink.rebuildIndex");
    current = second;
    await invoke("agentlink.resumeIndex");

    expect(first.startIndexing).toHaveBeenCalledWith(true);
    expect(second.startIndexing).toHaveBeenCalledWith(false);
  });

  it("does nothing when no manager exists", async () => {
    registerIndexCommands(() => null);

    await invoke("agentlink.rebuildIndex");
    await invoke("agentlink.cancelIndex");
    await invoke("agentlink.resumeIndex");
  });
});
