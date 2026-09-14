import type {
  CodexCredentialProvider,
  CodexResolvedAuth,
} from "@agentlink/core/codex";

import {
  CODEX_OAUTH_CREDENTIALS_STORAGE_KEY,
  CodexOAuthManager,
  type CodexOAuthAccountInfo,
} from "./codexOAuthManager.js";
import {
  createKeychainSecretStorage,
  type KeychainSecretStorageOptions,
} from "./keychainSecretStorage.js";

export interface CreateCodexOAuthRuntimeOptions {
  log?: (message: string) => void;
  keychain?: Omit<KeychainSecretStorageOptions, "account">;
}

export interface CodexOAuthRuntime<TContext = unknown> {
  manager: CodexOAuthManager;
  provider: CodexCredentialProvider<TContext>;
  ready(): Promise<void>;
}

export function createCodexOAuthRuntime<TContext = unknown>(
  options: CreateCodexOAuthRuntimeOptions = {},
): CodexOAuthRuntime<TContext> {
  const manager = new CodexOAuthManager(options.log);
  let initializationError: unknown;
  const initialized = createKeychainSecretStorage({
    ...options.keychain,
    account: CODEX_OAUTH_CREDENTIALS_STORAGE_KEY,
  })
    .then((storage) => manager.initializeStorage(storage))
    .catch((error: unknown) => {
      initializationError = error;
      options.log?.(
        `[codex-oauth] Shared credential storage unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
    });

  const ready = async (): Promise<void> => {
    await initialized;
    if (initializationError) throw initializationError;
  };
  const resolveAccount = async (
    account: CodexOAuthAccountInfo,
  ): Promise<CodexResolvedAuth | null> => {
    await ready();
    const bearerToken = await manager.getAccessTokenByAccountId(account.id);
    if (!bearerToken) return null;
    const refreshed = (await manager.getAccountById(account.id)) ?? account;
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
    ready,
    provider: {
      async resolveAuth() {
        await ready();
        const active = await manager.getActiveAccount();
        return active ? await resolveAccount(active) : null;
      },
      async refreshAuth({ previousAuth }) {
        await ready();
        const accountId = previousAuth.oauthAccountPoolId;
        if (!accountId) return null;
        const bearerToken =
          await manager.forceRefreshAccessTokenByAccountId(accountId);
        if (!bearerToken) return null;
        const account = await manager.getAccountById(accountId);
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
          await ready();
          await manager.markUsageLimit(accountId);
        },
        async listFallbackAccountIds({ accountId }) {
          await ready();
          return await manager.getRoundRobinAccountIds(accountId);
        },
        async resolveAccount({ accountId }) {
          await ready();
          const account = await manager.getAccountById(accountId);
          return account ? await resolveAccount(account) : null;
        },
        async activateAccount({ accountId }) {
          await ready();
          await manager.setActiveAccount(accountId, { notify: false });
        },
      },
    },
  };
}
