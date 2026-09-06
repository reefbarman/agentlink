import type {
  CodexCredentialProvider,
  CodexResolvedAuth,
} from "@agentlink/core/codex";
import {
  CODEX_OAUTH_CREDENTIALS_STORAGE_KEY,
  CodexOAuthManager,
  type CodexOAuthAccountInfo,
} from "../../agent/providers/codex/CodexOAuthManager.js";

export interface SharedCodexOAuthContext {
  sessionId: string;
}

export interface SharedCodexOAuthRuntime {
  manager: CodexOAuthManager;
  provider: CodexCredentialProvider<SharedCodexOAuthContext>;
}

export function createSharedCodexOAuthRuntime(
  log?: (message: string) => void,
): SharedCodexOAuthRuntime {
  const manager = new CodexOAuthManager(log);
  let initializationError: unknown;
  const initialized = import("@agentlink/node-host")
    .then(({ createKeychainSecretStorage }) =>
      createKeychainSecretStorage({
        account: CODEX_OAUTH_CREDENTIALS_STORAGE_KEY,
      }),
    )
    .then((storage) => manager.initializeStorage(storage))
    .catch((error: unknown) => {
      initializationError = error;
      log?.(
        `[codex-oauth] Shared credential storage unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
    });

  const ready = async (): Promise<CodexOAuthManager> => {
    await initialized;
    if (initializationError) throw initializationError;
    return manager;
  };
  const resolveAccount = async (
    account: CodexOAuthAccountInfo,
  ): Promise<CodexResolvedAuth | null> => {
    const storage = await ready();
    const bearerToken = await storage.getAccessTokenByAccountId(account.id);
    if (!bearerToken) return null;
    const refreshed = (await storage.getAccountById(account.id)) ?? account;
    return {
      method: "oauth",
      bearerToken,
      accountId: refreshed.chatgptAccountId,
      oauthAccountPoolId: refreshed.id,
      oauthAccountLabel: refreshed.label,
      oauthAccountEmail: refreshed.email,
      canRefresh: true,
    };
  };

  return {
    manager,
    provider: {
      async resolveAuth() {
        const storage = await ready();
        const active = await storage.getActiveAccount();
        return active ? await resolveAccount(active) : null;
      },
      async refreshAuth({ previousAuth }) {
        const storage = await ready();
        const accountId = previousAuth.oauthAccountPoolId;
        if (!accountId) return null;
        const bearerToken =
          await storage.forceRefreshAccessTokenByAccountId(accountId);
        if (!bearerToken) return null;
        const account = await storage.getAccountById(accountId);
        return account
          ? {
              method: "oauth",
              bearerToken,
              accountId: account.chatgptAccountId,
              oauthAccountPoolId: account.id,
              oauthAccountLabel: account.label,
              oauthAccountEmail: account.email,
              canRefresh: true,
            }
          : null;
      },
      oauthAccounts: {
        async markUsageLimit({ accountId }) {
          await (await ready()).markUsageLimit(accountId);
        },
        async listFallbackAccountIds({ accountId }) {
          return await (await ready()).getRoundRobinAccountIds(accountId);
        },
        async resolveAccount({ accountId }) {
          const storage = await ready();
          const account = await storage.getAccountById(accountId);
          return account ? await resolveAccount(account) : null;
        },
        async activateAccount({ accountId }) {
          await (await ready()).setActiveAccount(accountId, { notify: false });
        },
      },
    },
  };
}
