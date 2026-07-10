import { describe, expect, it } from "vitest";
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
});
