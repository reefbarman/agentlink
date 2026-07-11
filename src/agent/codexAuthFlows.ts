import * as vscode from "vscode";

import type {
  CodexCliUsageResult,
  CodexRateLimitSnapshot,
  CodexSubscriptionUsage,
} from "./providers/codex/CodexCliUsageClient.js";
import {
  CodexOAuthFlowError,
  type CodexCredentials,
  type CodexOAuthAccountInfo,
  type SaveOAuthAccountOptions,
  type SaveOAuthAccountResult,
} from "./providers/codex/CodexOAuthManager.js";

interface CodexAuthFlowManager {
  startAuthorizationFlow(): string;
  waitForCallback(): Promise<CodexCredentials>;
  saveOAuthCredentials(
    credentials: CodexCredentials,
    options?: SaveOAuthAccountOptions,
  ): Promise<SaveOAuthAccountResult>;
  listOAuthAccounts(): Promise<CodexOAuthAccountInfo[]>;
  setActiveOAuthAccount(accountId: string): Promise<unknown>;
  updateOAuthAccountLabel(accountId: string, label: string): Promise<unknown>;
  removeOAuthAccount(accountId: string): Promise<unknown>;
}

export interface CodexAuthFlowDependencies {
  authManager: CodexAuthFlowManager;
  queryUsage(): Promise<CodexCliUsageResult>;
  log(message: string): void;
}

export interface CodexOAuthSignInResult {
  accountLabel: string;
  accountEmail?: string;
  action: "added" | "updated" | "replaced";
  accountId: string;
}

export interface CodexAuthFlows {
  completeOAuthSignIn(options?: {
    replaceAccountId?: string;
    forceLabelPrompt?: boolean;
  }): Promise<CodexOAuthSignInResult | null>;
  pickOAuthAccount(
    title: string,
    placeHolder: string,
  ): Promise<CodexOAuthAccountInfo | undefined>;
  manageAccounts(): Promise<void>;
  showSubscriptionUsage(): Promise<void>;
}

async function promptForCodexAccountLabel(
  defaultValue = "",
): Promise<string | undefined> {
  const label = await vscode.window.showInputBox({
    title: "Codex Account Label",
    prompt:
      "Optional: name this Codex OAuth account (email is used automatically when available).",
    value: defaultValue,
    ignoreFocusOut: true,
  });
  return label?.trim() || undefined;
}

function formatResetTime(timestamp: number | null): string {
  if (timestamp === null) return "reset time unavailable";
  return `resets ${new Date(timestamp * 1_000).toLocaleString()}`;
}

function rateLimitDetail(snapshot: CodexRateLimitSnapshot): string {
  const windows = [snapshot.primary, snapshot.secondary]
    .filter((window) => window !== null)
    .map(
      (window) =>
        `${Math.round(window.usedPercent)}% used · ${formatResetTime(window.resetsAt)}`,
    );
  return windows.length > 0 ? windows.join(" · ") : "No window data";
}

export function usageQuickPickItems(usage: CodexSubscriptionUsage): Array<{
  label: string;
  description?: string;
  detail?: string;
}> {
  const buckets = usage.rateLimitsByLimitId
    ? Object.entries(usage.rateLimitsByLimitId)
    : [[usage.rateLimits.limitId ?? "codex", usage.rateLimits] as const];
  const items: Array<{
    label: string;
    description?: string;
    detail?: string;
  }> = buckets.map(([id, snapshot]) => ({
    label: `$(dashboard) ${snapshot.limitName ?? id}`,
    description: snapshot.planType ?? undefined,
    detail: rateLimitDetail(snapshot),
  }));

  const summary = usage.tokenUsage.summary;
  if (summary.lifetimeTokens !== null) {
    items.push({
      label: "$(symbol-numeric) Lifetime token activity",
      description: summary.lifetimeTokens.toLocaleString(),
      ...(summary.peakDailyTokens === null
        ? {}
        : {
            detail: `Peak daily activity: ${summary.peakDailyTokens.toLocaleString()} tokens`,
          }),
    });
  }
  if (usage.rateLimitResetCredits?.availableCount) {
    items.push({
      label: "$(refresh) Rate-limit resets available",
      description: String(usage.rateLimitResetCredits.availableCount),
    });
  }
  return items;
}

export function createCodexAuthFlows({
  authManager,
  queryUsage,
  log,
}: CodexAuthFlowDependencies): CodexAuthFlows {
  const completeOAuthSignIn: CodexAuthFlows["completeOAuthSignIn"] = async (
    options,
  ) => {
    const authUrl = authManager.startAuthorizationFlow();
    await vscode.env.openExternal(vscode.Uri.parse(authUrl));
    log("[codex] Opened browser for OAuth sign-in");

    const credentials = await authManager.waitForCallback();
    const label =
      options?.forceLabelPrompt || !credentials.email
        ? await promptForCodexAccountLabel(credentials.email ?? "")
        : undefined;

    const result = await authManager.saveOAuthCredentials(credentials, {
      replaceAccountId: options?.replaceAccountId,
      label,
      makeActive: true,
    });

    return {
      accountLabel: result.account.label,
      accountEmail: result.account.email,
      action: result.action,
      accountId: result.account.id,
    };
  };

  const pickOAuthAccount: CodexAuthFlows["pickOAuthAccount"] = async (
    title,
    placeHolder,
  ) => {
    const accounts = await authManager.listOAuthAccounts();
    if (accounts.length === 0) {
      vscode.window.showInformationMessage(
        "No ChatGPT/Codex OAuth accounts are signed in.",
      );
      return undefined;
    }

    const picked = await vscode.window.showQuickPick(
      accounts.map((account) => ({
        label: `${account.isActive ? "$(check) " : ""}${account.label}`,
        description: account.email ?? account.chatgptAccountId ?? account.id,
        detail: account.isActive ? "Active account" : undefined,
        account,
      })),
      { title, placeHolder, ignoreFocusOut: true },
    );
    return picked?.account;
  };

  const showSubscriptionUsage = async (): Promise<void> => {
    const result = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Reading Codex subscription usage…",
      },
      queryUsage,
    );

    if (!result.available) {
      log(`[codex] Subscription usage unavailable: ${result.reason}`);
      vscode.window.showInformationMessage(
        "Codex subscription usage is unavailable. Install and sign in to the Codex CLI to enable it.",
      );
      return;
    }

    await vscode.window.showQuickPick(usageQuickPickItems(result.usage), {
      title: "Codex Subscription Usage",
      placeHolder: "Usage is read from the locally installed Codex CLI",
      ignoreFocusOut: true,
    });
  };

  const manageAccounts = async (): Promise<void> => {
    const accounts = await authManager.listOAuthAccounts();
    if (accounts.length === 0) {
      vscode.window.showInformationMessage(
        "No ChatGPT/Codex OAuth accounts are signed in yet.",
      );
      return;
    }

    const account = await pickOAuthAccount(
      "Manage ChatGPT/Codex Accounts",
      "Select an account",
    );
    if (!account) return;

    const action = await vscode.window.showQuickPick(
      [
        { label: "View subscription usage", value: "usage" },
        { label: "Set active", value: "setActive" },
        { label: "Re-sign in / replace", value: "replace" },
        { label: "Rename label", value: "rename" },
        { label: "Remove account", value: "remove" },
      ],
      {
        title: `Manage account: ${account.label}`,
        ignoreFocusOut: true,
      },
    );
    if (!action) return;

    if (action.value === "usage") {
      await showSubscriptionUsage();
      return;
    }
    if (action.value === "setActive") {
      await authManager.setActiveOAuthAccount(account.id);
      vscode.window.showInformationMessage(
        `Active Codex account set to ${account.label}.`,
      );
      return;
    }
    if (action.value === "replace") {
      try {
        const result = await completeOAuthSignIn({
          replaceAccountId: account.id,
        });
        if (!result) return;
        vscode.window.showInformationMessage(
          `Updated ChatGPT/Codex account ${result.accountLabel}${
            result.accountEmail ? ` (${result.accountEmail})` : ""
          }.`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log(`[codex] Re-sign-in failed: ${message}`);
        if (error instanceof CodexOAuthFlowError && error.code === "timeout") {
          vscode.window.showWarningMessage(
            "OpenAI/Codex sign-in timed out. If the browser flow is still open, close it and try again.",
          );
        } else if (
          error instanceof CodexOAuthFlowError &&
          error.code === "port_in_use"
        ) {
          vscode.window.showErrorMessage(
            "OpenAI/Codex sign-in couldn't start because port 1455 is already in use. Close other Codex/Roo login flows and try again.",
          );
        } else {
          vscode.window.showErrorMessage(`Codex sign-in failed: ${message}`);
        }
      }
      return;
    }
    if (action.value === "rename") {
      const nextLabel = await promptForCodexAccountLabel(account.label);
      if (!nextLabel) return;
      await authManager.updateOAuthAccountLabel(account.id, nextLabel);
      vscode.window.showInformationMessage(
        `Updated account label to ${nextLabel}.`,
      );
      return;
    }
    if (action.value === "remove") {
      const confirm = await vscode.window.showWarningMessage(
        `Remove ChatGPT/Codex account ${account.label}?`,
        { modal: true },
        "Remove",
      );
      if (confirm !== "Remove") return;
      await authManager.removeOAuthAccount(account.id);
      vscode.window.showInformationMessage(`Removed account ${account.label}.`);
    }
  };

  return {
    completeOAuthSignIn,
    pickOAuthAccount,
    manageAccounts,
    showSubscriptionUsage,
  };
}
