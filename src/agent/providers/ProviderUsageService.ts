import { queryCodexUsage } from "./codex/CodexUsageClient.js";

export interface ProviderUsageWindow {
  usedPercent: number;
  resetsAt: number | null;
}

export interface ProviderUsageEntry {
  providerId: string;
  providerName: string;
  available: boolean;
  reason?: string;
  accountLabel?: string;
  accountSource?: string;
  switchAccountInstructions?: string;
  planType?: string;
  rateLimits?: Array<{
    id: string;
    name?: string;
    primary?: ProviderUsageWindow;
    secondary?: ProviderUsageWindow;
  }>;
  lifetimeTokens?: number;
  peakDailyTokens?: number;
  resetCredits?: number;
}

export interface ProviderUsageSnapshot {
  providers: ProviderUsageEntry[];
  queriedAt: number;
}

export interface ProviderUsageAdapter {
  providerId: string;
  providerName: string;
  query(): Promise<Omit<ProviderUsageEntry, "providerId" | "providerName">>;
}

export function createCodexUsageAdapter(): ProviderUsageAdapter {
  return {
    providerId: "openai-codex",
    providerName: "Codex",
    async query() {
      const result = await queryCodexUsage();
      if (!result.available) return result;

      const usage = result.usage;
      const snapshots = usage.rateLimitsByLimitId
        ? Object.entries(usage.rateLimitsByLimitId)
        : [[usage.rateLimits.limitId ?? "codex", usage.rateLimits] as const];
      return {
        available: true,
        accountLabel:
          usage.account.email ??
          (usage.account.type === "chatgpt"
            ? "ChatGPT account (email unavailable)"
            : usage.account.type),
        accountSource: "Active AgentLink ChatGPT/Codex account",
        switchAccountInstructions:
          "Use AgentLink: Switch Active ChatGPT/Codex Account, then run /usage again.",
        ...((usage.account.planType ?? usage.rateLimits.planType)
          ? { planType: usage.account.planType ?? usage.rateLimits.planType! }
          : {}),
        rateLimits: snapshots.map(([id, snapshot]) => ({
          id,
          ...(snapshot.limitName ? { name: snapshot.limitName } : {}),
          ...(snapshot.primary
            ? {
                primary: {
                  usedPercent: snapshot.primary.usedPercent,
                  resetsAt: snapshot.primary.resetsAt,
                },
              }
            : {}),
          ...(snapshot.secondary
            ? {
                secondary: {
                  usedPercent: snapshot.secondary.usedPercent,
                  resetsAt: snapshot.secondary.resetsAt,
                },
              }
            : {}),
        })),
        ...(usage.tokenUsage.summary.lifetimeTokens === null
          ? {}
          : { lifetimeTokens: usage.tokenUsage.summary.lifetimeTokens }),
        ...(usage.tokenUsage.summary.peakDailyTokens === null
          ? {}
          : { peakDailyTokens: usage.tokenUsage.summary.peakDailyTokens }),
        ...(usage.rateLimitResetCredits
          ? {
              resetCredits: usage.rateLimitResetCredits.availableCount,
            }
          : {}),
      };
    },
  };
}

export async function queryProviderUsage(
  adapters: ProviderUsageAdapter[] = [createCodexUsageAdapter()],
): Promise<ProviderUsageSnapshot> {
  const providers = await Promise.all(
    adapters.map(async (adapter): Promise<ProviderUsageEntry> => {
      try {
        return {
          providerId: adapter.providerId,
          providerName: adapter.providerName,
          ...(await adapter.query()),
        };
      } catch (error) {
        return {
          providerId: adapter.providerId,
          providerName: adapter.providerName,
          available: false,
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );
  return { providers, queriedAt: Date.now() };
}
