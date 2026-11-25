import { beforeEach, describe, expect, it, vi } from "vitest";

const vscodeMock = vi.hoisted(() => ({
  handlers: new Map<string, () => unknown>(),
  update: vi.fn(async () => undefined),
  inspect: vi.fn((): Record<string, unknown> => ({})),
  get: vi.fn((_key: string, fallback: unknown) => fallback),
  executeCommand: vi.fn(async (_command: string) => undefined),
  showWarningMessage: vi.fn(),
  showInformationMessage: vi.fn(),
  showQuickPick: vi.fn(),
  folders: [{ uri: { fsPath: "/repo" } }] as unknown[],
}));

vi.mock("vscode", () => ({
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  commands: {
    registerCommand: (name: string, handler: () => unknown) => {
      vscodeMock.handlers.set(name, handler);
      return { dispose: () => undefined };
    },
    executeCommand: vscodeMock.executeCommand,
  },
  window: {
    showWarningMessage: vscodeMock.showWarningMessage,
    showInformationMessage: vscodeMock.showInformationMessage,
    showQuickPick: vscodeMock.showQuickPick,
  },
  workspace: {
    get workspaceFolders() {
      return vscodeMock.folders;
    },
    getConfiguration: () => ({
      get: vscodeMock.get,
      update: vscodeMock.update,
      inspect: vscodeMock.inspect,
    }),
  },
}));

import { registerSemanticEmbeddingCommands } from "./semanticEmbeddingCommands.js";

describe("semantic embedding commands", () => {
  const hasApiKey = vi.fn(async () => true);
  const onChanged = vi.fn();
  const enable = () =>
    vscodeMock.handlers.get("agentlink.enableSemanticEmbeddings")!();

  beforeEach(() => {
    vi.resetAllMocks();
    vscodeMock.get.mockImplementation((_key, fallback) => fallback);
    vscodeMock.inspect.mockReturnValue({});
    hasApiKey.mockResolvedValue(true);
    vscodeMock.showWarningMessage.mockResolvedValue("Choose Where");
    vscodeMock.showQuickPick.mockResolvedValue({ value: "workspace" });
    registerSemanticEmbeddingCommands({
      hasApiKey,
      getChunkCount: () => 142_735,
      helpUri: { path: "/help.md" } as never,
      onChanged,
    });
  });

  it("explains what is sent before changing anything", async () => {
    vscodeMock.showWarningMessage.mockResolvedValue(undefined);
    await enable();
    const [, options] = vscodeMock.showWarningMessage.mock.calls[0]!;
    expect(options).toMatchObject({ modal: true });
    expect(options.detail).toContain("to OpenAI");
    expect(options.detail).toContain("142,735 chunks, roughly 38.5 million");
    expect(vscodeMock.update).not.toHaveBeenCalled();
  });

  it.each([
    ["workspace", 2],
    ["user", 1],
  ])("turns on at %s scope and offers a rebuild", async (value, target) => {
    vscodeMock.showQuickPick.mockResolvedValue({ value });
    vscodeMock.showInformationMessage.mockResolvedValue("Rebuild Index");
    await enable();
    expect(vscodeMock.update).toHaveBeenCalledExactlyOnceWith(
      "semanticEmbeddingsEnabled",
      true,
      target,
    );
    expect(onChanged).toHaveBeenCalledOnce();
    expect(vscodeMock.executeCommand).toHaveBeenCalledWith(
      "agentlink.rebuildIndex",
    );
  });

  it("stays off when no scope is chosen or no key is provided", async () => {
    vscodeMock.showQuickPick.mockResolvedValueOnce(undefined);
    await enable();
    hasApiKey.mockResolvedValue(false);
    await enable();
    expect(vscodeMock.executeCommand).toHaveBeenCalledWith(
      "agentlink.setOpenaiApiKey",
    );
    expect(vscodeMock.update).not.toHaveBeenCalled();
  });

  it("opens the bundled guide", async () => {
    vscodeMock.showWarningMessage.mockResolvedValue("Learn More");
    await enable();
    expect(vscodeMock.executeCommand).toHaveBeenCalledWith(
      "markdown.showPreview",
      { path: "/help.md" },
    );
    expect(vscodeMock.update).not.toHaveBeenCalled();
  });

  it("turns off everywhere it was turned on, and only there", async () => {
    vscodeMock.inspect.mockReturnValue({
      globalValue: true,
      workspaceValue: false,
      workspaceFolderValue: true,
    });
    await vscodeMock.handlers.get("agentlink.disableSemanticEmbeddings")!();
    expect(vscodeMock.update.mock.calls).toEqual([
      ["semanticEmbeddingsEnabled", undefined, 1],
      ["semanticEmbeddingsEnabled", undefined, 3],
    ]);
    expect(onChanged).toHaveBeenCalledOnce();
  });
});
