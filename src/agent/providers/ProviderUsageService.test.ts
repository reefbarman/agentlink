import { describe, expect, it, vi } from "vitest";
import {
  queryProviderUsage,
  type ProviderUsageAdapter,
} from "./ProviderUsageService.js";

describe("queryProviderUsage", () => {
  it("aggregates multiple provider adapters", async () => {
    const adapters: ProviderUsageAdapter[] = [
      {
        providerId: "first",
        providerName: "First Provider",
        async query() {
          return {
            available: true,
            rateLimits: [
              {
                id: "main",
                primary: { usedPercent: 30, resetsAt: 1_800_000_000 },
              },
            ],
          };
        },
      },
      {
        providerId: "second",
        providerName: "Second Provider",
        async query() {
          return { available: false, reason: "CLI not installed" };
        },
      },
    ];

    const result = await queryProviderUsage(adapters);

    expect(result.providers).toHaveLength(2);
    expect(result.providers[0]).toMatchObject({
      providerId: "first",
      available: true,
    });
    expect(result.providers[1]).toEqual({
      providerId: "second",
      providerName: "Second Provider",
      available: false,
      reason: "CLI not installed",
    });
  });

  it("queries only the selected provider before fetching usage", async () => {
    const codexQuery = vi.fn(async () => ({ available: true }));
    const claudeQuery = vi.fn(async () => ({ available: true }));
    const result = await queryProviderUsage(
      [
        {
          providerId: "openai-codex",
          providerName: "Codex",
          query: codexQuery,
        },
        {
          providerId: "openai-compatible:claude",
          providerName: "Claude",
          query: claudeQuery,
        },
      ],
      { providerId: "openai-compatible:claude", providerName: "Claude" },
    );

    expect(result.providers).toEqual([
      {
        providerId: "openai-compatible:claude",
        providerName: "Claude",
        available: true,
      },
    ]);
    expect(claudeQuery).toHaveBeenCalledOnce();
    expect(codexQuery).not.toHaveBeenCalled();
  });

  it("reports unsupported selected providers without querying other providers", async () => {
    const query = vi.fn(async () => ({ available: true }));
    const result = await queryProviderUsage(
      [{ providerId: "openai-codex", providerName: "Codex", query }],
      { providerId: "other", providerName: "Other" },
    );

    expect(result.providers).toEqual([
      {
        providerId: "other",
        providerName: "Other",
        available: false,
        reason:
          "Usage reporting is not available for the selected model's provider.",
      },
    ]);
    expect(query).not.toHaveBeenCalled();
  });

  it("isolates adapter failures", async () => {
    const result = await queryProviderUsage([
      {
        providerId: "broken",
        providerName: "Broken Provider",
        async query() {
          throw new Error("boom");
        },
      },
    ]);

    expect(result.providers[0]).toMatchObject({
      providerId: "broken",
      available: false,
      reason: "boom",
    });
  });

  it("sanitises reasons before they can reach a paired browser", async () => {
    const result = await queryProviderUsage([
      {
        providerId: "thrown",
        providerName: "Thrown",
        async query() {
          throw new Error(
            `fetch https://user:pw@host.invalid/x failed Bearer abc123 ${"x".repeat(400)}`,
          );
        },
      },
      {
        providerId: "returned",
        providerName: "Returned",
        async query() {
          return {
            available: true,
            accounts: [
              {
                id: "a",
                label: "a",
                isActive: false,
                available: false,
                reason: "see http://secret.invalid/path",
                stale: false,
                observedAtMs: null,
                windows: [],
              },
            ],
          };
        },
      },
    ]);

    const thrown = result.providers[0]!.reason!;
    expect(thrown).not.toMatch(/host\.invalid|abc123/);
    expect(thrown.length).toBeLessThanOrEqual(240);
    expect(result.providers[1]!.accounts![0]!.reason).toBe("see [url]");
  });
});
