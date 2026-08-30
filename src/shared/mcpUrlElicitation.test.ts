import {
  validateMcpElicitationUrl,
  type McpUrlElicitationRequest,
  type ValidatedMcpUrl,
} from "./mcpUrlElicitation.js";
import { describe, expect, expectTypeOf, it } from "vitest";

describe("MCP URL elicitation protocol compatibility shim", () => {
  it("preserves the legacy request and validation contracts", () => {
    expectTypeOf<McpUrlElicitationRequest>().toHaveProperty("elicitationId");
    expectTypeOf<ValidatedMcpUrl>().toHaveProperty("origin");
    expect(validateMcpElicitationUrl("https://example.com/path")).toEqual({
      ok: true,
      value: {
        url: "https://example.com/path",
        origin: "https://example.com",
        host: "example.com",
        isLocalAddress: false,
      },
    });
  });
});
