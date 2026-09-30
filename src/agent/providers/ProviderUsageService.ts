import type {
  ProviderUsageEntry,
  ProviderUsageSnapshot,
} from "../../shared/providerUsage.js";

import { queryCodexUsage } from "./codex/CodexUsageClient.js";

export type {
  ProviderUsageAccount,
  ProviderUsageAccountWindow,
  ProviderUsageEntry,
  ProviderUsageSnapshot,
  ProviderUsageWindow,
} from "../../shared/providerUsage.js";

const MAX_REASON_LENGTH = 240;
const URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi;

/**
 * Final-boundary sanitisation: usage results reach paired browsers, so a
 * thrown error must never leak URLs, tokens or unbounded upstream text.
 */
export function sanitizeProviderUsageReason(reason: unknown): string {
  const text =
    typeof reason === "string"
      ? reason
      : reason instanceof Error
        ? reason.message
        : "";
  const cleaned = text
    .replace(URL_PATTERN, "[url]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "Usage is unavailable.";
  return cleaned.length > MAX_REASON_LENGTH
    ? `${cleaned.slice(0, MAX_REASON_LENGTH - 1)}…`
    : cleaned;
}

export interface ProviderUsageSelection {
  providerId: string;
  providerName: string;
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

function sanitizeEntry(entry: ProviderUsageEntry): ProviderUsageEntry {
  return {
    ...entry,
    ...(entry.reason !== undefined
      ? { reason: sanitizeProviderUsageReason(entry.reason) }
      : {}),
    ...(entry.notice !== undefined
      ? { notice: sanitizeProviderUsageReason(entry.notice) }
      : {}),
    ...(entry.accounts
      ? {
          accounts: entry.accounts.map((account) =>
            account.reason === undefined
              ? account
              : {
                  ...account,
                  reason: sanitizeProviderUsageReason(account.reason),
                },
          ),
        }
      : {}),
  };
}

export async function queryProviderUsage(
  adapters: readonly ProviderUsageAdapter[] = [createCodexUsageAdapter()],
  selection?: ProviderUsageSelection,
): Promise<ProviderUsageSnapshot> {
  const selectedAdapters = selection
    ? adapters.filter((adapter) => adapter.providerId === selection.providerId)
    : adapters;
  if (selection && selectedAdapters.length === 0) {
    return {
      providers: [
        {
          ...selection,
          available: false,
          reason:
            "Usage reporting is not available for the selected model's provider.",
        },
      ],
      queriedAt: Date.now(),
    };
  }
  const providers = await Promise.all(
    selectedAdapters.map(async (adapter): Promise<ProviderUsageEntry> => {
      try {
        return sanitizeEntry({
          providerId: adapter.providerId,
          providerName: adapter.providerName,
          ...(await adapter.query()),
        });
      } catch (error) {
        return {
          providerId: adapter.providerId,
          providerName: adapter.providerName,
          available: false,
          reason: sanitizeProviderUsageReason(error),
        };
      }
    }),
  );
  return { providers, queriedAt: Date.now() };
}
