import * as vscode from "vscode";

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  listIndexStorage,
  maintainIndexStorage,
  removeIndexStorage,
} from "./indexStorage.js";

import { registerIndexStorageCommand } from "./indexStorageCommands.js";

vi.mock("vscode", async () => {
  const mock = await import("../__mocks__/vscode.js");
  return {
    ...mock,
    ProgressLocation: { Notification: 15 },
    window: {
      ...mock.window,
      withProgress: vi.fn(),
      showQuickPick: vi.fn(),
    },
  };
});
vi.mock("./indexStorage.js", () => ({
  listIndexStorage: vi.fn(),
  maintainIndexStorage: vi.fn(),
  removeIndexStorage: vi.fn(),
}));
vi.mock("../util/paths.js", () => ({
  getWorkspaceRoots: vi.fn(() => ["/current"]),
}));

let invoke: () => Promise<void>;
const entry = {
  id: "workspace-123",
  storeRoot: "/storage/workspace-123",
  workspaceRoot: "/old/workspace",
  bytes: 1024 ** 3,
};

describe("index storage command", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(vscode.commands, "registerCommand").mockImplementation(
      (name, handler) => {
        expect(name).toBe("agentlink.manageIndexStorage");
        invoke = handler;
        return { dispose: vi.fn() };
      },
    );
    vi.mocked(listIndexStorage).mockResolvedValue([entry]);
    vi.spyOn(vscode.window, "withProgress").mockImplementation(
      async (_options, task) =>
        task({ report: vi.fn() }, {} as vscode.CancellationToken),
    );
    vi.spyOn(vscode.window, "showQuickPick").mockResolvedValue(undefined);
    registerIndexStorageCommand("/storage");
  });

  it("lists storage without an indexer manager", async () => {
    await invoke();
    expect(listIndexStorage).toHaveBeenCalledWith("/storage", ["/current"]);
    expect(removeIndexStorage).not.toHaveBeenCalled();
  });

  it("does not mutate when confirmation is cancelled", async () => {
    vi.mocked(vscode.window.showQuickPick)
      .mockResolvedValueOnce({ label: "workspace", entry } as never)
      .mockResolvedValueOnce({ label: "Remove workspace index" } as never);
    vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue(undefined);
    await invoke();
    expect(removeIndexStorage).not.toHaveBeenCalled();
    expect(maintainIndexStorage).not.toHaveBeenCalled();
  });

  it("forwards confirmed removal through the registered command", async () => {
    vi.mocked(vscode.window.showQuickPick)
      .mockResolvedValueOnce({ label: "workspace", entry } as never)
      .mockResolvedValueOnce({ label: "Remove workspace index" } as never);
    vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue(
      "Other windows closed, remove index" as never,
    );
    await invoke();
    expect(removeIndexStorage).toHaveBeenCalledWith("/storage", entry.id, [
      "/current",
    ]);
    expect(maintainIndexStorage).not.toHaveBeenCalled();
  });

  it("forwards maintenance without invoking removal", async () => {
    vi.mocked(vscode.window.showQuickPick)
      .mockResolvedValueOnce({ label: "workspace", entry } as never)
      .mockResolvedValueOnce({ label: "Compact and prune" } as never);
    vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue(
      "Other windows closed, compact" as never,
    );
    await invoke();
    expect(maintainIndexStorage).toHaveBeenCalledWith("/storage", entry.id, [
      "/current",
    ]);
    expect(removeIndexStorage).not.toHaveBeenCalled();
  });

  it("refuses entries blocked by the storage service", async () => {
    vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce({
      label: "workspace",
      entry: { ...entry, blockedReason: "Current workspace" },
    } as never);
    await invoke();
    expect(vscode.window.showQuickPick).toHaveBeenCalledOnce();
    expect(removeIndexStorage).not.toHaveBeenCalled();
    expect(maintainIndexStorage).not.toHaveBeenCalled();
  });
});
