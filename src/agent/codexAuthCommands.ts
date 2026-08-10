import * as vscode from "vscode";

import { CodexOAuthFlowError } from "./providers/codex/CodexOAuthManager.js";

interface CodexOAuthAccount {
  id: string;
  label: string;
  email?: string;
}

interface CodexOAuthSignInResult {
  accountLabel: string;
  accountEmail?: string;
  action: "added" | "updated" | "replaced";
  accountId: string;
}

interface CodexAuthManager {
  storeApiKey(key: string, scope: "models+embeddings"): Promise<unknown>;
  setActiveOAuthAccount(accountId: string): Promise<unknown>;
  hasOAuth(): Promise<boolean>;
  hasApiKey(): Promise<boolean>;
  listOAuthAccounts(): Promise<unknown[]>;
  removeOAuthAccount(accountId: string): Promise<unknown>;
  clearOAuth(): Promise<unknown>;
  clearApiKey(): Promise<unknown>;
  clearAll(): Promise<unknown>;
}

export type CodexSignInPreferredChoice = "oauthOnly" | "apiKeyOnly";

export interface CodexAuthCommandDependencies {
  authManager: CodexAuthManager;
  completeOAuthSignIn(options?: {
    replaceAccountId?: string;
    forceLabelPrompt?: boolean;
  }): Promise<CodexOAuthSignInResult | null>;
  pickOAuthAccount(
    title: string,
    placeHolder: string,
  ): Promise<CodexOAuthAccount | undefined>;
  manageAccounts(): Promise<void>;
  showSubscriptionUsage(): Promise<void>;
  log(message: string): void;
}

function reportSignInError(
  err: unknown,
  logPrefix: string,
  fallbackPrefix: string,
  log: (message: string) => void,
): void {
  const message = err instanceof Error ? err.message : String(err);
  log(`[codex] ${logPrefix}: ${message}`);
  if (err instanceof CodexOAuthFlowError && err.code === "timeout") {
    void vscode.window.showWarningMessage(
      "OpenAI/Codex sign-in timed out. If the browser flow is still open, close it and try again.",
    );
  } else if (err instanceof CodexOAuthFlowError && err.code === "port_in_use") {
    void vscode.window.showErrorMessage(
      "OpenAI/Codex sign-in couldn't start because port 1455 is already in use. Close other Codex/Roo login flows and try again.",
    );
  } else {
    void vscode.window.showErrorMessage(`${fallbackPrefix}: ${message}`);
  }
}

export function registerCodexAuthCommands({
  authManager,
  completeOAuthSignIn,
  pickOAuthAccount,
  manageAccounts,
  showSubscriptionUsage,
  log,
}: CodexAuthCommandDependencies): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand(
      "agentlink.codexSignIn",
      async (preferredChoice?: CodexSignInPreferredChoice) => {
        const choice =
          preferredChoice === "oauthOnly"
            ? { value: "oauth" }
            : preferredChoice === "apiKeyOnly"
              ? { value: "apiKey" }
              : await vscode.window.showQuickPick(
                  [
                    {
                      label: "Sign in with ChatGPT/Codex",
                      description:
                        "Use your ChatGPT/Codex OAuth sessions for model chat",
                      value: "oauth",
                    },
                    {
                      label: "Use OpenAI API key",
                      description:
                        "Use an OpenAI API key for models and embeddings",
                      value: "apiKey",
                    },
                  ],
                  {
                    title: "OpenAI/Codex Authentication",
                    placeHolder:
                      "Choose model auth. Embeddings always use an API key. OAuth is preferred for model chat when both are configured.",
                    ignoreFocusOut: true,
                  },
                );
        if (!choice) return;

        if (choice.value === "apiKey") {
          const key = await vscode.window.showInputBox({
            title: "OpenAI API Key",
            prompt:
              "Enter your OpenAI API key for models and embeddings. OAuth remains preferred for model chat if also configured.",
            password: true,
            ignoreFocusOut: true,
            validateInput: (v) => (v.trim() ? null : "API key cannot be empty"),
          });
          if (!key) return;
          await authManager.storeApiKey(key.trim(), "models+embeddings");
          vscode.window.showInformationMessage(
            "OpenAI API key stored securely for models and embeddings.",
          );
          return;
        }

        try {
          const result = await completeOAuthSignIn();
          if (!result) return;
          log(
            `[codex] Signed in as ${result.accountEmail ?? result.accountLabel}`,
          );
          vscode.window.showInformationMessage(
            `${
              result.action === "added"
                ? "Added"
                : result.action === "updated"
                  ? "Updated"
                  : "Replaced"
            } ChatGPT/Codex account ${result.accountLabel}${
              result.accountEmail ? ` (${result.accountEmail})` : ""
            }. OAuth is preferred for model chat and will round-robin on usage-limit 429s.`,
          );
        } catch (err) {
          reportSignInError(err, "Sign-in failed", "Codex sign-in failed", log);
        }
      },
    ),
    vscode.commands.registerCommand("agentlink.codexAddAccount", async () => {
      try {
        const result = await completeOAuthSignIn();
        if (!result) return;
        const actionLabel =
          result.action === "added"
            ? "Added"
            : result.action === "updated"
              ? "Updated"
              : "Replaced";
        vscode.window.showInformationMessage(
          `${actionLabel} ChatGPT/Codex account ${result.accountLabel}${
            result.accountEmail ? ` (${result.accountEmail})` : ""
          } and set it active.`,
        );
      } catch (err) {
        reportSignInError(
          err,
          "Add-account sign-in failed",
          "Codex add-account failed",
          log,
        );
      }
    }),
    vscode.commands.registerCommand(
      "agentlink.codexSwitchAccount",
      async () => {
        const account = await pickOAuthAccount(
          "Switch Active ChatGPT/Codex Account",
          "Select an account to make active",
        );
        if (!account) return;
        await authManager.setActiveOAuthAccount(account.id);
        vscode.window.showInformationMessage(
          `Active Codex account set to ${account.label}.`,
        );
      },
    ),
    vscode.commands.registerCommand(
      "agentlink.codexReplaceAccount",
      async () => {
        const account = await pickOAuthAccount(
          "Replace ChatGPT/Codex Account",
          "Select an account to re-sign in / replace",
        );
        if (!account) return;
        try {
          const result = await completeOAuthSignIn({
            replaceAccountId: account.id,
          });
          if (!result) return;
          vscode.window.showInformationMessage(
            `Replaced account ${result.accountLabel}${
              result.accountEmail ? ` (${result.accountEmail})` : ""
            } and set it active.`,
          );
        } catch (err) {
          reportSignInError(
            err,
            "Replace-account sign-in failed",
            "Codex replace-account failed",
            log,
          );
        }
      },
    ),
    vscode.commands.registerCommand(
      "agentlink.codexManageAccounts",
      manageAccounts,
    ),
    vscode.commands.registerCommand(
      "agentlink.codexSubscriptionUsage",
      showSubscriptionUsage,
    ),
    vscode.commands.registerCommand("agentlink.codexSignOut", async () => {
      const hasOAuth = await authManager.hasOAuth();
      const hasApiKey = await authManager.hasApiKey();

      if (hasOAuth && hasApiKey) {
        const choice = await vscode.window.showQuickPick(
          [
            {
              label: "Remove one ChatGPT/Codex account",
              description: "Keeps other signed-in OAuth accounts",
              value: "removeOneOAuth",
            },
            {
              label: "Remove all ChatGPT/Codex accounts",
              description: "Clears all OAuth sessions",
              value: "oauth",
            },
            {
              label: "Remove OpenAI API key",
              description: "Keeps ChatGPT/Codex OAuth if present",
              value: "apiKey",
            },
            {
              label: "Remove both",
              description: "Clears OAuth accounts and API key",
              value: "both",
            },
          ],
          {
            title: "Manage OpenAI/Codex Authentication",
            placeHolder:
              "Choose which auth method to remove. OAuth is preferred when both are present.",
            ignoreFocusOut: true,
          },
        );
        if (!choice) return;

        if (choice.value === "removeOneOAuth") {
          const account = await pickOAuthAccount(
            "Remove ChatGPT/Codex Account",
            "Select an account to remove",
          );
          if (!account) return;
          await authManager.removeOAuthAccount(account.id);
        } else if (choice.value === "oauth") {
          await authManager.clearOAuth();
        } else if (choice.value === "apiKey") {
          await authManager.clearApiKey();
        } else {
          await authManager.clearAll();
        }
        vscode.window.showInformationMessage(
          "Updated OpenAI/Codex authentication. OAuth is preferred for model chat when present; embeddings require an API key.",
        );
        log(`[codex] Removed auth method: ${choice.value}`);
        return;
      }

      if (hasOAuth) {
        const accounts = await authManager.listOAuthAccounts();
        if (accounts.length > 1) {
          const action = await vscode.window.showQuickPick(
            [
              { label: "Remove one account", value: "one" },
              { label: "Remove all accounts", value: "all" },
            ],
            {
              title: "Remove ChatGPT/Codex Account",
              ignoreFocusOut: true,
            },
          );
          if (!action) return;
          if (action.value === "one") {
            const account = await pickOAuthAccount(
              "Remove ChatGPT/Codex Account",
              "Select an account to remove",
            );
            if (!account) return;
            await authManager.removeOAuthAccount(account.id);
          } else {
            await authManager.clearOAuth();
          }
        } else {
          await authManager.clearOAuth();
        }

        vscode.window.showInformationMessage(
          "Updated ChatGPT/Codex OAuth accounts.",
        );
        log("[codex] Updated OAuth accounts");
        return;
      }

      if (hasApiKey) {
        await authManager.clearApiKey();
        vscode.window.showInformationMessage(
          "Removed OpenAI API key. Semantic search/indexing embeddings require an API key. Model chat can still use ChatGPT/Codex OAuth.",
        );
        log("[codex] Removed OpenAI API key");
        return;
      }

      vscode.window.showInformationMessage(
        "No OpenAI/Codex credentials are currently configured for model chat or embeddings.",
      );
      log("[codex] Sign-out requested, but no credentials were configured");
    }),
  ];
}
