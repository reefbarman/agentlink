import { describe, expect, it, vi } from "vitest";

import type { OpenAiCodexResolvedAuth } from "./OpenAiCodexAuthManager.js";
import { queryCodexUsage } from "./CodexUsageClient.js";

const oauthAuth: OpenAiCodexResolvedAuth = {
  method: "oauth",
  bearerToken: "token-1",
  accountId: "chatgpt-account-1",
  oauthAccountPoolId: "local-account-1",
  oauthAccountLabel: "Work",
  oauthAccountEmail: "person@example.com",
  canRefresh: true,
};

function authManager(auth: OpenAiCodexResolvedAuth | null = oauthAuth) {
  return {
    resolveModelAuth: vi.fn(
      async (): Promise<OpenAiCodexResolvedAuth | null> => auth,
    ),
    forceRefreshModelAuth: vi.fn(
      async (
        _method: "oauth" | "apiKey",
        _options?: { oauthAccountPoolId?: string },
      ): Promise<OpenAiCodexResolvedAuth | null> => null,
    ),
  };
}

function response(body: unknown, status = 200): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function usagePayload() {
  return {
    plan_type: "plus",
    rate_limit: {
      primary_window: {
        used_percent: 42,
        limit_window_seconds: 18_000,
        reset_at: 1_800_000_000,
      },
      secondary_window: {
        used_percent: 5,
        limit_window_seconds: 604_800,
        reset_at: 1_800_500_000,
      },
    },
    credits: { has_credits: true, unlimited: false, balance: "12.5" },
    spend_control: {
      individual_limit: {
        limit: "25000",
        used: "8000",
        remaining_percent: 68,
        reset_at: 1_800_500_000,
      },
    },
    rate_limit_reached_type: {
      type: "workspace_member_usage_limit_reached",
    },
    additional_rate_limits: [
      {
        limit_name: "Codex Spark",
        metered_feature: "codex_spark",
        rate_limit: {
          primary_window: {
            used_percent: 88,
            limit_window_seconds: 1_800,
            reset_at: 1_800_000_100,
          },
        },
      },
    ],
    rate_limit_reset_credits: { available_count: 3 },
  };
}

function profilePayload() {
  return {
    stats: {
      lifetime_tokens: 1_234,
      peak_daily_tokens: 500,
      longest_running_turn_sec: 120,
      current_streak_days: 2,
      longest_streak_days: 4,
      daily_usage_buckets: [{ start_date: "2026-07-10", tokens: 42 }],
    },
  };
}

describe("queryCodexUsage", () => {
  it("reads rate limits and token activity with AgentLink OAuth", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) =>
      String(input).endsWith("/wham/usage")
        ? response(usagePayload())
        : response(profilePayload()),
    );
    const manager = authManager();

    const result = await queryCodexUsage({
      authManager: manager,
      fetch,
      sessionId: "session-1",
    });

    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(result.usage.account).toEqual({
      type: "chatgpt",
      email: "person@example.com",
      planType: "plus",
    });
    expect(result.usage.rateLimits).toMatchObject({
      limitId: "codex",
      primary: { usedPercent: 42, windowDurationMins: 300 },
      credits: { hasCredits: true, unlimited: false, balance: "12.5" },
      individualLimit: { remainingPercent: 68 },
      rateLimitReachedType: "workspace_member_usage_limit_reached",
    });
    expect(result.usage.rateLimitsByLimitId?.codex_spark).toMatchObject({
      limitName: "Codex Spark",
      primary: { usedPercent: 88, windowDurationMins: 30 },
    });
    expect(result.usage.rateLimitResetCredits).toEqual({ availableCount: 3 });
    expect(result.usage.tokenUsage).toEqual({
      summary: {
        lifetimeTokens: 1_234,
        peakDailyTokens: 500,
        longestRunningTurnSec: 120,
        currentStreakDays: 2,
        longestStreakDays: 4,
      },
      dailyUsageBuckets: [{ startDate: "2026-07-10", tokens: 42 }],
    });

    expect(fetch).toHaveBeenCalledTimes(2);
    for (const [, init] of fetch.mock.calls) {
      expect(init?.headers).toMatchObject({
        Authorization: "Bearer token-1",
        "ChatGPT-Account-Id": "chatgpt-account-1",
        originator: expect.any(String),
        session_id: "session-1",
      });
    }
  });

  it("refreshes OAuth once and retries both requests after a 401", async () => {
    const refreshedAuth = { ...oauthAuth, bearerToken: "token-2" };
    const manager = authManager();
    manager.forceRefreshModelAuth.mockResolvedValue(refreshedAuth);
    let requestCount = 0;
    const fetch = vi.fn(
      async (input: RequestInfo | URL, _init?: RequestInit) => {
        requestCount += 1;
        if (requestCount <= 2) return response("unauthorized", 401);
        return String(input).endsWith("/wham/usage")
          ? response(usagePayload())
          : response(profilePayload());
      },
    );

    const result = await queryCodexUsage({ authManager: manager, fetch });

    expect(result.available).toBe(true);
    expect(manager.forceRefreshModelAuth).toHaveBeenCalledWith("oauth", {
      oauthAccountPoolId: "local-account-1",
    });
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(fetch.mock.calls[2]?.[1]?.headers).toMatchObject({
      Authorization: "Bearer token-2",
    });
  });

  it("keeps rate limits available when profile activity fails", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) =>
      String(input).endsWith("/wham/usage")
        ? response(usagePayload())
        : response("profile unavailable", 500),
    );

    const result = await queryCodexUsage({ authManager: authManager(), fetch });

    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(result.usage.rateLimits.primary?.usedPercent).toBe(42);
    expect(result.usage.tokenUsage.summary.lifetimeTokens).toBeNull();
  });

  it("requires AgentLink ChatGPT/Codex OAuth and never invokes fetch otherwise", async () => {
    const fetch = vi.fn();
    const manager = authManager({
      method: "apiKey",
      bearerToken: "sk-test",
      canRefresh: false,
    });

    await expect(
      queryCodexUsage({ authManager: manager, fetch }),
    ).resolves.toEqual({
      available: false,
      reason:
        "Sign in to ChatGPT/Codex in AgentLink to view subscription usage.",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns an unavailable result for malformed rate-limit payloads", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) =>
      String(input).endsWith("/wham/usage")
        ? response([])
        : response(profilePayload()),
    );

    const result = await queryCodexUsage({ authManager: authManager(), fetch });

    expect(result).toEqual({
      available: false,
      reason: "Codex usage endpoint returned an invalid payload.",
    });
  });
});
