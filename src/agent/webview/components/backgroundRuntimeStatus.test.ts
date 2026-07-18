import { describe, expect, it } from "vitest";

import { formatBackgroundRuntimeStatus } from "./backgroundRuntimeStatus";

describe("formatBackgroundRuntimeStatus", () => {
  it("shows provider request elapsed time while waiting", () => {
    expect(
      formatBackgroundRuntimeStatus(
        { phase: "waiting_for_provider", requestStartedAt: 1_000 },
        66_000,
      ),
    ).toBe("Waiting for provider · request 1:05");
  });

  it("shows thinking time against the same provider request", () => {
    expect(
      formatBackgroundRuntimeStatus(
        { phase: "thinking", requestStartedAt: 10_000 },
        24_000,
      ),
    ).toBe("Thinking · request 14s");
  });

  it("shows retry timing", () => {
    expect(
      formatBackgroundRuntimeStatus(
        {
          phase: "retrying_provider",
          requestStartedAt: 10_000,
          retryAt: 42_000,
        },
        40_000,
      ),
    ).toBe("Retrying provider · request 30s · retry in 2s");
  });
});
