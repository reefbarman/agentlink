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
    maintainIndex: vi.fn(async () => ({
      maintainedRoots: 1,
      bytesReclaimed: 0,
      errors: [],
    })),
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
      "agentlink.maintainIndex",
    ]);
    expect(disposables).toHaveLength(4);
  });

  it("reports reclaimed space after maintenance", async () => {
    const target = createTarget();
    vi.mocked(target.maintainIndex).mockResolvedValueOnce({
      maintainedRoots: 1,
      bytesReclaimed: 3.5 * 1024 ** 3,
      errors: [],
    });
    const info = vi
      .spyOn(vscode.window, "showInformationMessage")
      .mockResolvedValue(undefined);
    registerIndexCommands(() => target);

    await invoke("agentlink.maintainIndex");

    expect(target.maintainIndex).toHaveBeenCalledOnce();
    expect(info).toHaveBeenCalledWith(
      "Codebase index maintained. Reclaimed 3.5 GB.",
    );
  });

  it("warns with the failure reasons when maintenance fails", async () => {
    const target = createTarget();
    vi.mocked(target.maintainIndex).mockResolvedValueOnce({
      maintainedRoots: 0,
      bytesReclaimed: 0,
      errors: ["Indexing is in progress. Try again once it has finished."],
    });
    const warning = vi
      .spyOn(vscode.window, "showWarningMessage")
      .mockResolvedValue(undefined);
    registerIndexCommands(() => target);

    await invoke("agentlink.maintainIndex");

    expect(warning).toHaveBeenCalledWith(
      "Codebase index maintenance failed: Indexing is in progress. Try again once it has finished.",
    );
  });

  it("stays silent when maintenance is cancelled", async () => {
    const target = createTarget();
    vi.mocked(target.maintainIndex).mockResolvedValueOnce({
      maintainedRoots: 0,
      bytesReclaimed: 0,
      errors: [],
      cancelled: true,
    });
    const info = vi.spyOn(vscode.window, "showInformationMessage");
    const warning = vi.spyOn(vscode.window, "showWarningMessage");
    registerIndexCommands(() => target);

    await invoke("agentlink.maintainIndex");

    expect(info).not.toHaveBeenCalled();
    expect(warning).not.toHaveBeenCalled();
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
    await invoke("agentlink.maintainIndex");
  });
});
