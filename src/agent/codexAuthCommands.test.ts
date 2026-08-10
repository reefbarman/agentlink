import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("vscode", async () => await import("../__mocks__/vscode.js"));

import * as vscode from "vscode";
import { CodexOAuthFlowError } from "./providers/codex/CodexOAuthManager.js";
import {
  registerCodexAuthCommands,
  type CodexAuthCommandDependencies,
} from "./codexAuthCommands.js";

const commandHandlers = new Map<string, (...args: unknown[]) => unknown>();

function createDependencies(): CodexAuthCommandDependencies {
  return {
    authManager: {
      storeApiKey: vi.fn(async () => {}),
      setActiveOAuthAccount: vi.fn(async () => {}),
      hasOAuth: vi.fn(async () => false),
      hasApiKey: vi.fn(async () => false),
      listOAuthAccounts: vi.fn(async () => []),
      removeOAuthAccount: vi.fn(async () => {}),
      clearOAuth: vi.fn(async () => {}),
      clearApiKey: vi.fn(async () => {}),
      clearAll: vi.fn(async () => {}),
    },
    completeOAuthSignIn: vi.fn(async () => ({
      accountLabel: "Work",
      accountEmail: "work@example.com",
      action: "added" as const,
      accountId: "account-1",
    })),
    pickOAuthAccount: vi.fn(async () => undefined),
    manageAccounts: vi.fn(async () => {}),
    showSubscriptionUsage: vi.fn(async () => {}),
    log: vi.fn(),
  };
}

function register(dependencies = createDependencies()) {
  registerCodexAuthCommands(dependencies);
  return dependencies;
}

async function invoke(command: string, ...args: unknown[]): Promise<void> {
  const handler = commandHandlers.get(command);
  expect(handler).toBeTypeOf("function");
  await handler!(...args);
}

describe("registerCodexAuthCommands", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    commandHandlers.clear();
    vi.spyOn(vscode.commands, "registerCommand").mockImplementation(
      (command: string, callback: (...args: unknown[]) => unknown) => {
        commandHandlers.set(command, callback);
        return { dispose: vi.fn() };
      },
    );
    vi.spyOn(vscode.window, "showQuickPick").mockResolvedValue(undefined);
    Object.assign(vscode.window, { showInputBox: vi.fn() });
    vi.spyOn(vscode.window, "showInformationMessage").mockResolvedValue(
      undefined,
    );
    vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue(undefined);
    vi.spyOn(vscode.window, "showErrorMessage").mockResolvedValue(undefined);
  });

  it("registers the complete Codex auth command group", () => {
    const disposables = registerCodexAuthCommands(createDependencies());

    expect([...commandHandlers.keys()]).toEqual([
      "agentlink.codexSignIn",
      "agentlink.codexAddAccount",
      "agentlink.codexSwitchAccount",
      "agentlink.codexReplaceAccount",
      "agentlink.codexManageAccounts",
      "agentlink.codexSubscriptionUsage",
      "agentlink.codexSignOut",
    ]);
    expect(disposables).toHaveLength(7);
  });

  it("uses the API-key flow directly for the sidebar shortcut", async () => {
    const dependencies = register();
    vi.mocked(vscode.window.showInputBox).mockResolvedValue("  sk-test  ");

    await invoke("agentlink.codexSignIn", "apiKeyOnly");

    expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
    expect(dependencies.authManager.storeApiKey).toHaveBeenCalledWith(
      "sk-test",
      "models+embeddings",
    );
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      "OpenAI API key stored securely for models and embeddings.",
    );
  });

  it("starts OAuth directly for the onboarding action", async () => {
    const dependencies = register();

    await invoke("agentlink.codexSignIn", "oauthOnly");

    expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
    expect(dependencies.completeOAuthSignIn).toHaveBeenCalledOnce();
  });

  it("preserves OAuth sign-in success messaging", async () => {
    const dependencies = register();
    vi.mocked(vscode.window.showQuickPick).mockResolvedValue({
      label: "Sign in with ChatGPT/Codex",
      value: "oauth",
    } as vscode.QuickPickItem & { value: string });

    await invoke("agentlink.codexSignIn");

    expect(dependencies.completeOAuthSignIn).toHaveBeenCalledOnce();
    expect(dependencies.log).toHaveBeenCalledWith(
      "[codex] Signed in as work@example.com",
    );
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      "Added ChatGPT/Codex account Work (work@example.com). OAuth is preferred for model chat and will round-robin on usage-limit 429s.",
    );
  });

  it.each([
    [
      "timeout" as const,
      "showWarningMessage" as const,
      "OpenAI/Codex sign-in timed out. If the browser flow is still open, close it and try again.",
    ],
    [
      "port_in_use" as const,
      "showErrorMessage" as const,
      "OpenAI/Codex sign-in couldn't start because port 1455 is already in use. Close other Codex/Roo login flows and try again.",
    ],
  ])(
    "preserves %s OAuth error classification",
    async (code, method, message) => {
      const dependencies = register();
      vi.mocked(vscode.window.showQuickPick).mockResolvedValue({
        label: "Sign in with ChatGPT/Codex",
        value: "oauth",
      } as vscode.QuickPickItem & { value: string });
      vi.mocked(dependencies.completeOAuthSignIn).mockRejectedValue(
        new CodexOAuthFlowError("failed", code),
      );

      await invoke("agentlink.codexSignIn");

      expect(vscode.window[method]).toHaveBeenCalledWith(message);
      expect(dependencies.log).toHaveBeenCalledWith(
        "[codex] Sign-in failed: failed",
      );
    },
  );
});
