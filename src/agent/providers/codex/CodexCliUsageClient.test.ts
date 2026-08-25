import { describe, expect, it, vi } from "vitest";

import { queryCodexCliUsage } from "./CodexCliUsageClient.js";

describe("queryCodexCliUsage compatibility export", () => {
  it("uses AgentLink auth without spawning the local CLI", async () => {
    const authManager = {
      resolveModelAuth: vi.fn(async () => null),
      forceRefreshModelAuth: vi.fn(async () => null),
    };
    const fetch = vi.fn();

    await expect(queryCodexCliUsage({ authManager, fetch })).resolves.toEqual({
      available: false,
      reason:
        "Sign in to ChatGPT/Codex in AgentLink to view subscription usage.",
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});
