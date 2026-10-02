import { describe, expect, it } from "vitest";

import { isSupportedStandaloneMcpOAuthDestination } from "./standaloneMcpOAuthPolicy.js";

describe("native Desktop MCP OAuth networking parity", () => {
  it.each([
    "https://mcp.example.com/oauth",
    "https://private.tailnet.test/oauth",
    "https://100.64.0.2/oauth",
    "https://10.0.0.2/oauth",
    "http://localhost:3000/oauth",
    "http://127.0.0.1/oauth",
    "http://[::1]/oauth",
    "https://[fd00::1]/oauth",
  ])(
    "allows HTTP(S) OAuth without a public-network-only restriction: %s",
    (value) => {
      expect(isSupportedStandaloneMcpOAuthDestination(new URL(value))).toBe(
        true,
      );
    },
  );

  it.each([
    "file:///etc/passwd",
    "javascript:alert(1)",
    "ftp://example.com/oauth",
    "https://user:password@example.com/oauth",
  ])("rejects unsupported URL forms: %s", (value) => {
    expect(isSupportedStandaloneMcpOAuthDestination(new URL(value))).toBe(
      false,
    );
  });
});
