import { describe, expect, it, vi } from "vitest";

import { isSafeStandaloneMcpOAuthDestination } from "./standaloneMcpOAuthPolicy.js";

describe("standalone MCP OAuth destination policy", () => {
  it.each([
    "https://127.0.0.1/oauth",
    "https://100.64.0.1/oauth",
    "https://[::1]/oauth",
    "https://[::ffff:127.0.0.1]/oauth",
    "https://[fe80::1]/oauth",
    "https://[fd00::1]/oauth",
    "https://[2001::1]/oauth",
    "https://[2002:0a00:0001::]/oauth",
  ])("blocks private or reserved literal address %s", async (value) => {
    await expect(
      isSafeStandaloneMcpOAuthDestination(new URL(value)),
    ).resolves.toBe(false);
  });

  it("blocks a hostname when any resolved address is private", async () => {
    const resolveAddresses = vi.fn(async () => ["93.184.216.34", "10.0.0.2"]);
    await expect(
      isSafeStandaloneMcpOAuthDestination(
        new URL("https://accounts.example.test/oauth"),
        resolveAddresses,
      ),
    ).resolves.toBe(false);
  });

  it("allows an HTTPS hostname only when every resolved address is public", async () => {
    const resolveAddresses = vi.fn(async () => [
      "93.184.216.34",
      "2606:2800:220:1:248:1893:25c8:1946",
    ]);
    await expect(
      isSafeStandaloneMcpOAuthDestination(
        new URL("https://accounts.example.test/oauth"),
        resolveAddresses,
      ),
    ).resolves.toBe(true);
  });

  it("rejects credentials, non-HTTPS URLs, and failed DNS resolution", async () => {
    await expect(
      isSafeStandaloneMcpOAuthDestination(new URL("http://example.com/oauth")),
    ).resolves.toBe(false);
    await expect(
      isSafeStandaloneMcpOAuthDestination(
        new URL("https://user:password@example.com/oauth"),
      ),
    ).resolves.toBe(false);
    await expect(
      isSafeStandaloneMcpOAuthDestination(
        new URL("https://accounts.example.test/oauth"),
        async () => {
          throw new Error("dns failed");
        },
      ),
    ).resolves.toBe(false);
  });
});
