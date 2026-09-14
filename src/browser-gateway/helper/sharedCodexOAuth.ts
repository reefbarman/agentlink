import type {
  CodexCredentialProvider,
  CodexResolvedAuth,
} from "@agentlink/core/codex";
import type { CodexOAuthRuntime } from "@agentlink/node-host" with {
  "resolution-mode": "import",
};

export interface SharedCodexOAuthContext {
  sessionId: string;
}

export interface SharedCodexOAuthRuntime {
  provider: CodexCredentialProvider<SharedCodexOAuthContext>;
}

export function createSharedCodexOAuthRuntime(
  log?: (message: string) => void,
): SharedCodexOAuthRuntime {
  const runtime = import("@agentlink/node-host").then(
    ({ createCodexOAuthRuntime }) =>
      createCodexOAuthRuntime<SharedCodexOAuthContext>({ log }),
  );
  const ready = async (): Promise<CodexOAuthRuntime<SharedCodexOAuthContext>> =>
    await runtime;
  const resolveAccount = async (request: {
    context: SharedCodexOAuthContext;
    modelId: string;
    purpose: "stream" | "complete" | "catalog" | "authStatus" | "nativeWeb";
    accountId: string;
  }): Promise<CodexResolvedAuth | null> => {
    const provider = (await ready()).provider;
    return (await provider.oauthAccounts?.resolveAccount(request)) ?? null;
  };

  return {
    provider: {
      async resolveAuth(request) {
        return await (await ready()).provider.resolveAuth(request);
      },
      async refreshAuth(request) {
        return (await (await ready()).provider.refreshAuth?.(request)) ?? null;
      },
      oauthAccounts: {
        async markUsageLimit(request) {
          await (await ready()).provider.oauthAccounts?.markUsageLimit(request);
        },
        async listFallbackAccountIds(request) {
          return (
            (await (
              await ready()
            ).provider.oauthAccounts?.listFallbackAccountIds(request)) ?? []
          );
        },
        resolveAccount,
        async activateAccount(request) {
          await (
            await ready()
          ).provider.oauthAccounts?.activateAccount(request);
        },
      },
    },
  };
}
