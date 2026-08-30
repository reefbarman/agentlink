import { describe, expect, expectTypeOf, it } from "vitest";

import {
  canonicalDraftToWriteDraft,
  validateMcpServerConfig,
  validateMcpServerDraft,
  type McpCanonicalTransport,
  type McpConfigDiagnosticCode,
} from "./mcpConfigValidation.js";

describe("MCP config validation protocol compatibility shim", () => {
  it("preserves canonical types, validation, and write translation", () => {
    expectTypeOf<McpCanonicalTransport>().toEqualTypeOf<
      "stdio" | "http" | "sse"
    >();
    expectTypeOf<McpConfigDiagnosticCode>().toMatchTypeOf<string>();
    const result = validateMcpServerConfig(" remote ", {
      type: "streamable-http",
      serverUrl: "https://example.test/mcp",
      headers: { Authorization: "Bearer secret" },
    });
    expect(result).toMatchObject({
      valid: true,
      draft: {
        name: "remote",
        type: "http",
        url: "https://example.test/mcp",
      },
    });
    expect(result.diagnostics.map(({ code }) => code)).toEqual([
      "name_normalized",
      "server_url_alias",
      "transport_normalized",
    ]);
    expect(validateMcpServerDraft(result.draft).valid).toBe(true);
    expect(canonicalDraftToWriteDraft(result.draft!)).toEqual({
      name: "remote",
      type: "http",
      url: "https://example.test/mcp",
      headers: {
        mode: "replace",
        set: { Authorization: "Bearer secret" },
      },
    });
  });
});
