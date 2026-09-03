import { randomUUID } from "crypto";

import { getCodexOriginator, getCodexUserAgent } from "@agentlink/core/codex";
import { agentLinkFetch } from "../../../util/httpDispatcher.js";
import {
  openAiCodexAuthManager,
  type OpenAiCodexAuthManager,
  type OpenAiCodexResolvedAuth,
} from "./OpenAiCodexAuthManager.js";

export interface CodexRateLimitWindow {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
}

export interface CodexRateLimitSnapshot {
  limitId: string | null;
  limitName: string | null;
  primary: CodexRateLimitWindow | null;
  secondary: CodexRateLimitWindow | null;
  planType: string | null;
  credits: {
    hasCredits: boolean;
    unlimited: boolean;
    balance: string | null;
  } | null;
  individualLimit: {
    limit: string;
    used: string;
    remainingPercent: number;
    resetsAt: number;
  } | null;
  rateLimitReachedType: string | null;
}

export interface CodexSubscriptionUsage {
  account: {
    type: "chatgpt" | "apiKey" | "amazonBedrock" | "unknown";
    email: string | null;
    planType: string | null;
  };
  rateLimits: CodexRateLimitSnapshot;
  rateLimitsByLimitId: Record<string, CodexRateLimitSnapshot> | null;
  rateLimitResetCredits: { availableCount: number } | null;
  tokenUsage: {
    summary: {
      lifetimeTokens: number | null;
      peakDailyTokens: number | null;
      longestRunningTurnSec: number | null;
      currentStreakDays: number | null;
      longestStreakDays: number | null;
    };
    dailyUsageBuckets: Array<{ startDate: string; tokens: number }> | null;
  };
}

export type CodexUsageResult =
  | { available: true; usage: CodexSubscriptionUsage }
  | { available: false; reason: string };

/** @deprecated Use CodexUsageResult. */
export type CodexCliUsageResult = CodexUsageResult;

const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const PROFILE_URL = "https://chatgpt.com/backend-api/wham/profiles/me";
const REQUEST_TIMEOUT_MS = 10_000;

type CodexUsageAuthManager = Pick<
  OpenAiCodexAuthManager,
  "resolveModelAuth" | "forceRefreshModelAuth"
>;

interface QueryCodexUsageOptions {
  authManager?: CodexUsageAuthManager;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  sessionId?: string;
}

class CodexUsageHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "CodexUsageHttpError";
  }
}

interface UsageResponses {
  usage: PromiseSettledResult<unknown>;
  profile: PromiseSettledResult<unknown>;
}

/**
 * Reads subscription usage directly from the ChatGPT backend with AgentLink's
 * active OAuth account. The local Codex CLI is not read or spawned.
 */
export async function queryCodexUsage(
  options: QueryCodexUsageOptions = {},
): Promise<CodexUsageResult> {
  const authManager = options.authManager ?? openAiCodexAuthManager;
  const webFetch = options.fetch ?? agentLinkFetch;
  let auth = await authManager.resolveModelAuth();
  if (!auth || auth.method !== "oauth") {
    return {
      available: false,
      reason:
        "Sign in to ChatGPT/Codex in AgentLink to view subscription usage.",
    };
  }

  const sessionId = options.sessionId ?? randomUUID();
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? REQUEST_TIMEOUT_MS,
  );

  try {
    let responses = await fetchUsageResponses(
      webFetch,
      auth,
      sessionId,
      controller.signal,
    );
    if (hasUnauthorizedResponse(responses)) {
      const refreshed = await authManager.forceRefreshModelAuth("oauth", {
        oauthAccountPoolId: auth.oauthAccountPoolId,
      });
      if (!refreshed || refreshed.method !== "oauth") {
        return {
          available: false,
          reason:
            "ChatGPT/Codex authentication expired. Sign in again in AgentLink.",
        };
      }
      auth = refreshed;
      responses = await fetchUsageResponses(
        webFetch,
        auth,
        sessionId,
        controller.signal,
      );
    }

    if (responses.usage.status === "rejected") {
      return {
        available: false,
        reason: errorMessage(responses.usage.reason),
      };
    }

    const rateLimits = parseRateLimitPayload(responses.usage.value);
    const tokenUsage =
      responses.profile.status === "fulfilled"
        ? parseTokenUsagePayload(responses.profile.value)
        : emptyTokenUsage();
    const primary = rateLimits.snapshots[0];
    if (!primary) {
      return {
        available: false,
        reason: "Codex usage response did not include rate-limit data.",
      };
    }

    return {
      available: true,
      usage: {
        account: {
          type: "chatgpt",
          email: auth.oauthAccountEmail ?? null,
          planType: primary.planType,
        },
        rateLimits: primary,
        rateLimitsByLimitId:
          rateLimits.snapshots.length > 1 ? rateLimits.byLimitId : null,
        rateLimitResetCredits: rateLimits.resetCredits,
        tokenUsage,
      },
    };
  } catch (error) {
    return {
      available: false,
      reason:
        error instanceof Error && error.name === "AbortError"
          ? "Codex usage query timed out"
          : errorMessage(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchUsageResponses(
  webFetch: typeof globalThis.fetch,
  auth: OpenAiCodexResolvedAuth,
  sessionId: string,
  signal: AbortSignal,
): Promise<UsageResponses> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    Authorization: `Bearer ${auth.bearerToken}`,
    "User-Agent": getCodexUserAgent(),
    originator: getCodexOriginator(),
    session_id: sessionId,
  };
  if (auth.accountId) headers["ChatGPT-Account-Id"] = auth.accountId;

  const [usage, profile] = await Promise.allSettled([
    fetchJson(webFetch, USAGE_URL, headers, signal),
    fetchJson(webFetch, PROFILE_URL, headers, signal),
  ]);
  return { usage, profile };
}

async function fetchJson(
  webFetch: typeof globalThis.fetch,
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<unknown> {
  const response = await webFetch(url, { method: "GET", headers, signal });
  const body = await response.text();
  if (!response.ok) {
    throw new CodexUsageHttpError(
      response.status,
      `Codex usage request failed (${response.status})${body.trim() ? `: ${summarizeBody(body)}` : ""}`,
    );
  }
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new Error("Codex usage endpoint returned invalid JSON.");
  }
}

function hasUnauthorizedResponse(responses: UsageResponses): boolean {
  return [responses.usage, responses.profile].some(
    (result) =>
      result.status === "rejected" &&
      result.reason instanceof CodexUsageHttpError &&
      result.reason.status === 401,
  );
}

function parseRateLimitPayload(value: unknown): {
  snapshots: CodexRateLimitSnapshot[];
  byLimitId: Record<string, CodexRateLimitSnapshot>;
  resetCredits: { availableCount: number } | null;
} {
  const root = record(value);
  if (!root)
    throw new Error("Codex usage endpoint returned an invalid payload.");
  const planType = stringValue(root.plan_type);
  const primary = parseRateLimitSnapshot("codex", null, root.rate_limit, {
    planType,
    credits: root.credits,
    individualLimit: record(root.spend_control)?.individual_limit,
    rateLimitReachedType: record(root.rate_limit_reached_type)?.type,
  });
  const snapshots = [primary];
  for (const item of arrayValue(root.additional_rate_limits)) {
    const entry = record(item);
    if (!entry) continue;
    const id = stringValue(entry.metered_feature);
    if (!id || id === "codex") continue;
    snapshots.push(
      parseRateLimitSnapshot(
        id,
        stringValue(entry.limit_name),
        entry.rate_limit,
        {
          planType,
        },
      ),
    );
  }
  return {
    snapshots,
    byLimitId: Object.fromEntries(
      snapshots.map((snapshot) => [snapshot.limitId ?? "codex", snapshot]),
    ),
    resetCredits: parseResetCredits(root.rate_limit_reset_credits),
  };
}

function parseRateLimitSnapshot(
  limitId: string,
  limitName: string | null,
  value: unknown,
  metadata: {
    planType: string | null;
    credits?: unknown;
    individualLimit?: unknown;
    rateLimitReachedType?: unknown;
  },
): CodexRateLimitSnapshot {
  const details = record(value);
  return {
    limitId,
    limitName,
    primary: parseWindow(details?.primary_window),
    secondary: parseWindow(details?.secondary_window),
    planType: metadata.planType,
    credits: parseCredits(metadata.credits),
    individualLimit: parseIndividualLimit(metadata.individualLimit),
    rateLimitReachedType: stringValue(metadata.rateLimitReachedType),
  };
}

function parseWindow(value: unknown): CodexRateLimitWindow | null {
  const window = record(value);
  if (!window) return null;
  const usedPercent = numberValue(window.used_percent);
  if (usedPercent === null) return null;
  const seconds = numberValue(window.limit_window_seconds);
  return {
    usedPercent,
    windowDurationMins: seconds === null ? null : seconds / 60,
    resetsAt: numberValue(window.reset_at),
  };
}

function parseCredits(value: unknown): CodexRateLimitSnapshot["credits"] {
  const credits = record(value);
  if (!credits) return null;
  const hasCredits = booleanValue(credits.has_credits);
  const unlimited = booleanValue(credits.unlimited);
  if (hasCredits === null || unlimited === null) return null;
  return {
    hasCredits,
    unlimited,
    balance: stringValue(credits.balance),
  };
}

function parseIndividualLimit(
  value: unknown,
): CodexRateLimitSnapshot["individualLimit"] {
  const limit = record(value);
  if (!limit) return null;
  const amount = stringValue(limit.limit);
  const used = stringValue(limit.used);
  const remainingPercent = numberValue(limit.remaining_percent);
  const resetsAt = numberValue(limit.reset_at);
  if (
    amount === null ||
    used === null ||
    remainingPercent === null ||
    resetsAt === null
  ) {
    return null;
  }
  return { limit: amount, used, remainingPercent, resetsAt };
}

function parseResetCredits(value: unknown): { availableCount: number } | null {
  const credits = record(value);
  const availableCount = numberValue(credits?.available_count);
  return availableCount === null ? null : { availableCount };
}

function parseTokenUsagePayload(
  value: unknown,
): CodexSubscriptionUsage["tokenUsage"] {
  const stats = record(record(value)?.stats);
  if (!stats) return emptyTokenUsage();
  const buckets = arrayValue(stats.daily_usage_buckets)
    .map((value) => {
      const bucket = record(value);
      const startDate = stringValue(bucket?.start_date);
      const tokens = numberValue(bucket?.tokens);
      return startDate === null || tokens === null
        ? null
        : { startDate, tokens };
    })
    .filter(
      (value): value is { startDate: string; tokens: number } => value !== null,
    );
  return {
    summary: {
      lifetimeTokens: numberValue(stats.lifetime_tokens),
      peakDailyTokens: numberValue(stats.peak_daily_tokens),
      longestRunningTurnSec: numberValue(stats.longest_running_turn_sec),
      currentStreakDays: numberValue(stats.current_streak_days),
      longestStreakDays: numberValue(stats.longest_streak_days),
    },
    dailyUsageBuckets: buckets.length > 0 ? buckets : null,
  };
}

function emptyTokenUsage(): CodexSubscriptionUsage["tokenUsage"] {
  return {
    summary: {
      lifetimeTokens: null,
      peakDailyTokens: null,
      longestRunningTurnSec: null,
      currentStreakDays: null,
      longestStreakDays: null,
    },
    dailyUsageBuckets: null,
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function booleanValue(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function summarizeBody(body: string): string {
  const normalized = body.replace(/\s+/g, " ").trim();
  return normalized.length > 300 ? `${normalized.slice(0, 300)}…` : normalized;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
