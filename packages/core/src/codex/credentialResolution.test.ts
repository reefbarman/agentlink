import { describe, expect, it, vi } from "vitest";

import {
  CodexCredentialSession,
  type CodexCredentialProvider,
  type CodexCredentialRequest,
  type CodexResolvedAuth,
} from "./credentialResolution.js";

interface TestContext {
  principalId: string;
  turnId: string;
}

const context: TestContext = {
  principalId: "tenant-a:user-1",
  turnId: "turn-1",
};

const request: CodexCredentialRequest<TestContext> = {
  context,
  modelId: "gpt-5.6-sol",
  purpose: "stream",
};

function oauthAuth(
  accountId: string,
  token = `token-${accountId}`,
): CodexResolvedAuth {
  return {
    method: "oauth",
    bearerToken: token,
    accountId: `chatgpt-${accountId}`,
    oauthAccountPoolId: accountId,
    oauthAccountLabel: `Account ${accountId}`,
    canRefresh: true,
  };
}

describe("CodexCredentialSession", () => {
  it("fails with the stable auth-required error when the host resolves no credential", async () => {
    const provider: CodexCredentialProvider<TestContext> = {
      resolveAuth: vi.fn(async () => null),
    };

    await expect(
      CodexCredentialSession.create({ provider, request }),
    ).rejects.toMatchObject({
      name: "CodexRequestError",
      code: "auth_required",
      retryable: true,
      actions: { signIn: true },
    });
    expect(provider.resolveAuth).toHaveBeenCalledWith(request);
  });

  it("forwards the complete request context to resolution and OAuth refresh", async () => {
    const resolveAuth = vi.fn(async () => oauthAuth("account-1", "old-token"));
    const refreshAuth = vi.fn(async () => oauthAuth("account-1", "new-token"));
    const provider: CodexCredentialProvider<TestContext> = {
      resolveAuth,
      refreshAuth,
    };

    const session = await CodexCredentialSession.create({ provider, request });
    await expect(session.refreshOAuth()).resolves.toBe(true);

    expect(resolveAuth).toHaveBeenCalledWith(request);
    expect(refreshAuth).toHaveBeenCalledWith({
      ...request,
      previousAuth: oauthAuth("account-1", "old-token"),
    });
    expect(session.auth).toEqual(oauthAuth("account-1", "new-token"));
  });

  it("refreshes an identified OAuth account only once per request", async () => {
    const refreshAuth = vi.fn(async () => oauthAuth("account-1", "new-token"));
    const provider: CodexCredentialProvider<TestContext> = {
      resolveAuth: vi.fn(async () => oauthAuth("account-1", "old-token")),
      refreshAuth,
    };

    const session = await CodexCredentialSession.create({ provider, request });
    await expect(session.refreshOAuth()).resolves.toBe(true);
    await expect(session.refreshOAuth()).resolves.toBe(false);
    expect(refreshAuth).toHaveBeenCalledOnce();
  });

  it("rejects a refresh that changes the identified OAuth account", async () => {
    const refreshAuth = vi.fn(async () => oauthAuth("account-2", "new-token"));
    const provider: CodexCredentialProvider<TestContext> = {
      resolveAuth: vi.fn(async () => oauthAuth("account-1", "old-token")),
      refreshAuth,
    };

    const session = await CodexCredentialSession.create({ provider, request });
    await expect(session.refreshOAuth()).resolves.toBe(false);
    expect(session.auth).toEqual(oauthAuth("account-1", "old-token"));
  });

  it("bounds OAuth refreshes without a host account identity", async () => {
    const anonymousAuth: CodexResolvedAuth = {
      method: "oauth",
      bearerToken: "old-token",
      canRefresh: true,
    };
    const refreshAuth = vi.fn(async () => ({
      ...anonymousAuth,
      bearerToken: "new-token",
    }));
    const provider: CodexCredentialProvider<TestContext> = {
      resolveAuth: vi.fn(async () => anonymousAuth),
      refreshAuth,
    };

    const session = await CodexCredentialSession.create({
      provider,
      request,
      maxOAuthRefreshAttempts: 2,
    });
    await expect(session.refreshOAuth()).resolves.toBe(true);
    await expect(session.refreshOAuth()).resolves.toBe(true);
    await expect(session.refreshOAuth()).resolves.toBe(false);
    expect(refreshAuth).toHaveBeenCalledTimes(2);
  });

  it("does not refresh API-key credentials", async () => {
    const refreshAuth = vi.fn();
    const apiKeyAuth: CodexResolvedAuth = {
      method: "apiKey",
      bearerToken: "sk-test",
      canRefresh: false,
    };
    const provider: CodexCredentialProvider<TestContext> = {
      resolveAuth: vi.fn(async () => apiKeyAuth),
      refreshAuth,
    };

    const session = await CodexCredentialSession.create({ provider, request });
    await expect(session.refreshOAuth()).resolves.toBe(false);
    expect(refreshAuth).not.toHaveBeenCalled();
  });

  it("marks usage and activates the first resolvable unattempted OAuth fallback", async () => {
    const markUsageLimit = vi.fn(async () => undefined);
    const listFallbackAccountIds = vi.fn(async () => [
      "account-1",
      "missing",
      "account-2",
    ]);
    const resolveAccount = vi.fn(async ({ accountId }) =>
      accountId === "account-2" ? oauthAuth("account-2") : null,
    );
    const activateAccount = vi.fn(async () => undefined);
    const provider: CodexCredentialProvider<TestContext> = {
      resolveAuth: vi.fn(async () => oauthAuth("account-1")),
      oauthAccounts: {
        markUsageLimit,
        listFallbackAccountIds,
        resolveAccount,
        activateAccount,
      },
    };

    const session = await CodexCredentialSession.create({ provider, request });
    const result = await session.handleOAuthUsageLimit({ allowRotation: true });

    expect(result).toEqual({
      rotated: true,
      previousAuth: oauthAuth("account-1"),
    });
    expect(markUsageLimit).toHaveBeenCalledWith({
      ...request,
      accountId: "account-1",
    });
    expect(resolveAccount).toHaveBeenCalledTimes(2);
    expect(activateAccount).toHaveBeenCalledWith({
      ...request,
      accountId: "account-2",
    });
    expect(session.auth).toEqual(oauthAuth("account-2"));
    expect(session.attemptedAccountIds).toEqual(["account-1", "account-2"]);
  });

  it("records a streaming usage limit without rotating after output starts", async () => {
    const markUsageLimit = vi.fn(async () => undefined);
    const listFallbackAccountIds = vi.fn();
    const provider: CodexCredentialProvider<TestContext> = {
      resolveAuth: vi.fn(async () => oauthAuth("account-1")),
      oauthAccounts: {
        markUsageLimit,
        listFallbackAccountIds,
        resolveAccount: vi.fn(),
        activateAccount: vi.fn(),
      },
    };

    const session = await CodexCredentialSession.create({ provider, request });
    await expect(
      session.handleOAuthUsageLimit({ allowRotation: false }),
    ).resolves.toEqual({ rotated: false });
    expect(markUsageLimit).toHaveBeenCalledOnce();
    expect(listFallbackAccountIds).not.toHaveBeenCalled();
  });

  it("builds an exhausted error from the accounts actually attempted", async () => {
    const provider: CodexCredentialProvider<TestContext> = {
      resolveAuth: vi.fn(async () => oauthAuth("account-1")),
      oauthAccounts: {
        markUsageLimit: vi.fn(async () => undefined),
        listFallbackAccountIds: vi.fn(async () => ["account-2"]),
        resolveAccount: vi.fn(async () => oauthAuth("account-2")),
        activateAccount: vi.fn(async () => undefined),
      },
    };

    const session = await CodexCredentialSession.create({ provider, request });
    await session.handleOAuthUsageLimit({ allowRotation: true });
    expect(
      session.buildUsageLimitExhaustedError({
        status: 429,
        message: "limit reached",
      }),
    ).toMatchObject({
      name: "CodexRequestError",
      code: "oauth_usage_limit_exhausted",
      retryable: true,
      metadata: { attemptedOAuthAccountIds: ["account-1", "account-2"] },
    });
  });

  it("rejects invalid refresh bounds", async () => {
    const provider: CodexCredentialProvider<TestContext> = {
      resolveAuth: vi.fn(async () => oauthAuth("account-1")),
    };
    await expect(
      CodexCredentialSession.create({
        provider,
        request,
        maxOAuthRefreshAttempts: -1,
      }),
    ).rejects.toThrow("maxOAuthRefreshAttempts must be a non-negative integer");
  });
});
