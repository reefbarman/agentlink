import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("vscode", async () => await import("../__mocks__/vscode.js"));

import * as vscode from "vscode";
import type { SemanticReadinessReason } from "@agentlink/protocol/semantic-readiness";
import {
  getSemanticSetupDetail,
  getSemanticSetupTitle,
  registerModelAuthCommands,
  type ModelAuthCommandDependencies,
} from "./modelAuthCommands.js";

const commandHandlers = new Map<string, (...args: unknown[]) => unknown>();

function createDependencies(): ModelAuthCommandDependencies {
  return {
    openAiAuthManager: {
      storeApiKey: vi.fn(async () => {}),
    },
    secrets: {
      store: vi.fn(async () => {}),
    },
    setAnthropicApiKey: vi.fn(),
    refreshModels: vi.fn(),
    publishBrowserModelCatalog: vi.fn(),
    grantBrowserModelCredentials: vi.fn(),
  };
}

async function invoke(command: string, ...args: unknown[]): Promise<void> {
  const handler = commandHandlers.get(command);
  expect(handler).toBeTypeOf("function");
  await handler!(...args);
}

function quickPickValue(
  value: string,
): vscode.QuickPickItem & { value: string } {
  return { label: value, value };
}

describe("semantic setup copy", () => {
  it.each<[SemanticReadinessReason | undefined, string, string]>([
    [
      "missing_embeddings_auth",
      "Improve semantic search with vector ranking",
      "Lexical indexing and search work without credentials. Configure an OpenAI API key to add vector and hybrid ranking.",
    ],
    [
      "missing_index",
      "Set up semantic search: build codebase index",
      "This workspace has not been indexed yet. Lexical indexing works without embedding credentials.",
    ],
    [
      "store_unavailable",
      "Semantic search unavailable: retrieval store is not ready",
      "The embedded retrieval store must be available before semantic indexing and search can run.",
    ],
    [
      "disabled",
      "Semantic search is disabled",
      "Enable agentlink.semanticSearchEnabled in settings to use semantic indexing and search.",
    ],
    [
      "no_workspace",
      "Semantic search requires an open workspace",
      "Open a workspace folder to build and query a semantic codebase index.",
    ],
    [
      undefined,
      "Set up semantic search",
      "Semantic search requires setup before it can run.",
    ],
  ])("maps %s to the existing title and detail", (reason, title, detail) => {
    expect(getSemanticSetupTitle(reason)).toBe(title);
    expect(getSemanticSetupDetail(reason)).toBe(detail);
  });
});

describe("registerModelAuthCommands", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    commandHandlers.clear();
    Object.assign(vscode.window, { showInputBox: vi.fn() });
    vi.spyOn(vscode.commands, "registerCommand").mockImplementation(
      (command: string, callback: (...args: unknown[]) => unknown) => {
        commandHandlers.set(command, callback);
        return { dispose: vi.fn() };
      },
    );
    vi.spyOn(vscode.commands, "executeCommand").mockResolvedValue(undefined);
    vi.spyOn(vscode.window, "showQuickPick").mockResolvedValue(undefined);
    vi.spyOn(vscode.window, "showInformationMessage").mockResolvedValue(
      undefined,
    );
  });

  it("registers the model authentication command group", () => {
    const disposables = registerModelAuthCommands(createDependencies());

    expect([...commandHandlers.keys()]).toEqual([
      "agentlink.setOpenaiApiKey",
      "agentlink.setupSemanticSearch",
      "agentlink.setAnthropicApiKey",
    ]);
    expect(disposables).toHaveLength(3);
  });

  it("stores a trimmed embeddings-only OpenAI key", async () => {
    const dependencies = createDependencies();
    registerModelAuthCommands(dependencies);
    vi.mocked(vscode.window.showInputBox).mockResolvedValue("  sk-test  ");

    await invoke("agentlink.setOpenaiApiKey");

    expect(dependencies.openAiAuthManager.storeApiKey).toHaveBeenCalledWith(
      "sk-test",
      "embeddings-only",
    );
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      "OpenAI API key stored securely for embeddings (semantic search/indexing).",
    );
  });

  it("routes embeddings setup through the existing command and optional index", async () => {
    registerModelAuthCommands(createDependencies());
    vi.mocked(vscode.window.showQuickPick).mockResolvedValue(
      quickPickValue("embeddingsKey"),
    );
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValue(
      "Index Codebase" as never,
    );

    await invoke("agentlink.setupSemanticSearch", "missing_embeddings_auth");

    expect(vscode.window.showQuickPick).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({
        title: "Improve semantic search with vector ranking",
      }),
    );
    expect(vscode.commands.executeCommand).toHaveBeenNthCalledWith(
      1,
      "agentlink.setOpenaiApiKey",
    );
    expect(vscode.commands.executeCommand).toHaveBeenNthCalledWith(
      2,
      "agentlink.rebuildIndex",
    );
  });

  it("stores a models-and-embeddings key and optionally starts indexing", async () => {
    const dependencies = createDependencies();
    registerModelAuthCommands(dependencies);
    vi.mocked(vscode.window.showQuickPick).mockResolvedValue(
      quickPickValue("modelsAndEmbeddingsKey"),
    );
    vi.mocked(vscode.window.showInputBox).mockResolvedValue("  sk-models  ");
    vi.mocked(vscode.window.showInformationMessage)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce("Index Codebase" as never);

    await invoke("agentlink.setupSemanticSearch");

    expect(dependencies.openAiAuthManager.storeApiKey).toHaveBeenCalledWith(
      "sk-models",
      "models+embeddings",
    );
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      "agentlink.rebuildIndex",
    );
  });

  it.each([
    ["oauth", "agentlink.codexSignIn", []],
    ["rebuild", "agentlink.rebuildIndex", []],
    ["settings", "workbench.action.openSettings", ["agentlink"]],
  ] as const)("routes the %s setup action", async (value, command, args) => {
    registerModelAuthCommands(createDependencies());
    vi.mocked(vscode.window.showQuickPick).mockResolvedValue(
      quickPickValue(value),
    );

    await invoke("agentlink.setupSemanticSearch");

    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      command,
      ...args,
    );
  });

  it("stores Anthropic credentials and refreshes both surfaces", async () => {
    const dependencies = createDependencies();
    registerModelAuthCommands(dependencies);
    vi.mocked(vscode.window.showInputBox).mockResolvedValue("  sk-ant  ");

    await invoke("agentlink.setAnthropicApiKey");

    expect(dependencies.secrets.store).toHaveBeenCalledWith(
      "anthropicApiKey",
      "sk-ant",
    );
    expect(dependencies.setAnthropicApiKey).toHaveBeenCalledWith("sk-ant");
    expect(dependencies.refreshModels).toHaveBeenCalledOnce();
    expect(dependencies.publishBrowserModelCatalog).toHaveBeenCalledOnce();
    expect(dependencies.grantBrowserModelCredentials).toHaveBeenCalledOnce();
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      "Anthropic API key stored securely.",
    );
  });
});
