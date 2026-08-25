import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("vscode", async () => ({
  ...(await import("../__mocks__/vscode.js")),
  env: { openExternal: vi.fn(async () => true) },
  ProgressLocation: { Notification: 15 },
}));

import * as vscode from "vscode";
import type { CodexSubscriptionUsage } from "./providers/codex/CodexUsageClient.js";
import { CodexOAuthFlowError } from "./providers/codex/CodexOAuthManager.js";
import {
  createCodexAuthFlows,
  type CodexAuthFlowDependencies,
  usageQuickPickItems,
} from "./codexAuthFlows.js";

const credentials = {
  accessToken: "access",
  refreshToken: "refresh",
  expiresAt: 123,
  email: "work@example.com",
};

const account = {
  id: "account-1",
  label: "Work",
  email: "work@example.com",
  createdAt: 1,
  updatedAt: 1,
  isActive: true,
};

function usage(): CodexSubscriptionUsage {
  return {
    account: { type: "chatgpt", email: "work@example.com", planType: "pro" },
    rateLimits: {
      limitId: "codex",
      limitName: "Codex",
      primary: { usedPercent: 25.4, windowDurationMins: 300, resetsAt: null },
      secondary: null,
      planType: "pro",
      credits: null,
      individualLimit: null,
      rateLimitReachedType: null,
    },
    rateLimitsByLimitId: null,
    rateLimitResetCredits: { availableCount: 2 },
    tokenUsage: {
      summary: {
        lifetimeTokens: 1_234,
        peakDailyTokens: 500,
        longestRunningTurnSec: null,
        currentStreakDays: null,
        longestStreakDays: null,
      },
      dailyUsageBuckets: null,
    },
  };
}

function createDependencies(): CodexAuthFlowDependencies {
  return {
    authManager: {
      startAuthorizationFlow: vi.fn(() => "https://auth.example.test"),
      waitForCallback: vi.fn(async () => credentials),
      saveOAuthCredentials: vi.fn(async () => ({
        account,
        action: "added" as const,
      })),
      listOAuthAccounts: vi.fn(async () => [account]),
      setActiveOAuthAccount: vi.fn(async () => account),
      updateOAuthAccountLabel: vi.fn(async () => account),
      removeOAuthAccount: vi.fn(async () => true),
    },
    queryUsage: vi.fn(async () => ({
      available: true as const,
      usage: usage(),
    })),
    log: vi.fn(),
  };
}

describe("createCodexAuthFlows", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(vscode.env.openExternal).mockClear();
    Object.assign(vscode.window, {
      showInputBox: vi.fn(),
      withProgress: vi.fn(async (_options, task) => task()),
    });
    vi.spyOn(vscode.window, "showQuickPick").mockResolvedValue(undefined);
    vi.spyOn(vscode.window, "showInformationMessage").mockResolvedValue(
      undefined,
    );
    vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue(undefined);
    vi.spyOn(vscode.window, "showErrorMessage").mockResolvedValue(undefined);
  });

  it("opens OAuth, awaits credentials, and saves an active account", async () => {
    const dependencies = createDependencies();
    const flows = createCodexAuthFlows(dependencies);

    await expect(flows.completeOAuthSignIn()).resolves.toEqual({
      accountLabel: "Work",
      accountEmail: "work@example.com",
      action: "added",
      accountId: "account-1",
    });

    expect(vscode.env.openExternal).toHaveBeenCalledWith(
      expect.objectContaining({ path: "https://auth.example.test" }),
    );
    expect(dependencies.authManager.saveOAuthCredentials).toHaveBeenCalledWith(
      credentials,
      { replaceAccountId: undefined, label: undefined, makeActive: true },
    );
    expect(dependencies.log).toHaveBeenCalledWith(
      "[codex] Opened browser for OAuth sign-in",
    );
  });

  it("prompts for and trims a label when OAuth has no email", async () => {
    const dependencies = createDependencies();
    vi.mocked(dependencies.authManager.waitForCallback).mockResolvedValue({
      ...credentials,
      email: undefined,
    });
    vi.mocked(vscode.window.showInputBox).mockResolvedValue("  Personal  ");

    await createCodexAuthFlows(dependencies).completeOAuthSignIn();

    expect(dependencies.authManager.saveOAuthCredentials).toHaveBeenCalledWith(
      expect.objectContaining({ email: undefined }),
      expect.objectContaining({ label: "Personal" }),
    );
  });

  it("presents accounts with active and identity metadata", async () => {
    const dependencies = createDependencies();
    vi.mocked(vscode.window.showQuickPick).mockImplementation(async (items) =>
      Array.isArray(items) ? items[0] : undefined,
    );

    await expect(
      createCodexAuthFlows(dependencies).pickOAuthAccount("Pick", "Choose"),
    ).resolves.toEqual(account);
    expect(vscode.window.showQuickPick).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          label: "$(check) Work",
          description: "work@example.com",
          detail: "Active account",
        }),
      ],
      { title: "Pick", placeHolder: "Choose", ignoreFocusOut: true },
    );
  });

  it("preserves replace-flow timeout classification", async () => {
    const dependencies = createDependencies();
    let pickCount = 0;
    vi.mocked(vscode.window.showQuickPick).mockImplementation(async (items) => {
      pickCount += 1;
      if (!Array.isArray(items)) return undefined;
      return pickCount === 1 ? items[0] : items[2];
    });
    vi.mocked(dependencies.authManager.waitForCallback).mockRejectedValue(
      new CodexOAuthFlowError("timed out", "timeout"),
    );

    await createCodexAuthFlows(dependencies).manageAccounts();

    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      "OpenAI/Codex sign-in timed out. If the browser flow is still open, close it and try again.",
    );
    expect(dependencies.log).toHaveBeenCalledWith(
      "[codex] Re-sign-in failed: timed out",
    );
  });

  it("reports unavailable subscription usage without opening a picker", async () => {
    const dependencies = createDependencies();
    vi.mocked(dependencies.queryUsage).mockResolvedValue({
      available: false,
      reason: "Sign in to ChatGPT/Codex in AgentLink.",
    });

    await createCodexAuthFlows(dependencies).showSubscriptionUsage();

    expect(dependencies.log).toHaveBeenCalledWith(
      "[codex] Subscription usage unavailable: Sign in to ChatGPT/Codex in AgentLink.",
    );
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      "Sign in to ChatGPT/Codex in AgentLink.",
    );
    expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
  });
});

describe("usageQuickPickItems", () => {
  it("preserves rate-limit, token, and reset summaries", () => {
    expect(usageQuickPickItems(usage())).toEqual([
      {
        label: "$(dashboard) Codex",
        description: "pro",
        detail: "25% used · reset time unavailable",
      },
      {
        label: "$(symbol-numeric) Lifetime token activity",
        description: "1,234",
        detail: "Peak daily activity: 500 tokens",
      },
      { label: "$(refresh) Rate-limit resets available", description: "2" },
    ]);
  });
});
