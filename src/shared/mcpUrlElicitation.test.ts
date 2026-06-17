import { describe, expect, it } from "vitest";

import { validateMcpElicitationUrl } from "./mcpUrlElicitation.js";

describe("validateMcpElicitationUrl", () => {
  it("accepts http and https URLs and returns display metadata", () => {
    expect(validateMcpElicitationUrl("https://example.com/path?q=1")).toEqual({
      ok: true,
      value: {
        url: "https://example.com/path?q=1",
        origin: "https://example.com",
        host: "example.com",
        isLocalAddress: false,
      },
    });
  });

  it("rejects non-web URL schemes", () => {
    expect(validateMcpElicitationUrl("javascript:alert(1)")).toEqual({
      ok: false,
      error: "Unsupported URL scheme: javascript",
    });
    expect(validateMcpElicitationUrl("file:///etc/passwd")).toEqual({
      ok: false,
      error: "Unsupported URL scheme: file",
    });
    expect(validateMcpElicitationUrl("vscode://agentlink/test")).toEqual({
      ok: false,
      error: "Unsupported URL scheme: vscode",
    });
  });

  it("flags local and private network hosts", () => {
    for (const url of [
      "http://localhost:3000/callback",
      "http://127.0.0.1/callback",
      "http://10.0.0.5/callback",
      "http://172.16.4.1/callback",
      "http://192.168.1.10/callback",
      "http://agentlink.local/callback",
    ]) {
      const result = validateMcpElicitationUrl(url);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.isLocalAddress).toBe(true);
    }
  });
});
