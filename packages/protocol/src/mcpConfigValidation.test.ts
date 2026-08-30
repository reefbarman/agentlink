import { describe, expect, expectTypeOf, it } from "vitest";

import {
  canonicalDraftToWriteDraft,
  validateMcpServerConfig,
  validateMcpServerDraft,
  type McpCanonicalServerDraft,
  type McpCanonicalTransport,
  type McpConfigDiagnosticCode,
} from "./mcpConfigValidation.js";

function errorCodes(
  result: ReturnType<typeof validateMcpServerConfig>,
): string[] {
  return result.diagnostics
    .filter((diagnostic) => diagnostic.severity === "error")
    .map((diagnostic) => diagnostic.code);
}

describe("MCP config validation protocol", () => {
  it("keeps canonical types and write translation stable", () => {
    expectTypeOf<McpCanonicalTransport>().toEqualTypeOf<
      "stdio" | "http" | "sse"
    >();
    expectTypeOf<McpConfigDiagnosticCode>().toEqualTypeOf<
      | "server_url_alias"
      | "name_normalized"
      | "transport_inferred"
      | "transport_normalized"
      | "legacy_sse_transport"
      | "unknown_field"
      | "invalid_json"
      | "invalid_fence"
      | "invalid_root"
      | "no_servers"
      | "duplicate_server_name"
      | "unknown_root_field"
      | "invalid_server_name"
      | "invalid_server_config"
      | "duplicate_endpoint"
      | "conflicting_endpoints"
      | "missing_endpoint"
      | "command_required"
      | "url_required"
      | "invalid_transport"
      | "invalid_command"
      | "invalid_args"
      | "invalid_env"
      | "invalid_headers"
      | "invalid_record_key"
      | "invalid_url"
      | "url_userinfo_not_allowed"
      | "invalid_timeout"
      | "invalid_tool_policy"
      | "invalid_tool_disclosure"
      | "invalid_parallel_tool_calls"
      | "invalid_allowed_tools"
      | "invalid_disabled"
    >();
    const draft: McpCanonicalServerDraft = {
      name: "remote",
      type: "http",
      url: "https://example.test/mcp",
      env: { TOKEN: "secret" },
      headers: { Authorization: "Bearer secret" },
    };
    expect(canonicalDraftToWriteDraft(draft)).toEqual({
      name: "remote",
      type: "http",
      url: "https://example.test/mcp",
      env: { mode: "replace", set: { TOKEN: "secret" } },
      headers: {
        mode: "replace",
        set: { Authorization: "Bearer secret" },
      },
    });
  });

  it("normalizes and preserves every supported field", () => {
    const result = validateMcpServerConfig(" remote ", {
      type: "streamable-http",
      serverUrl: "https://example.test/mcp?visible=true",
      disabled: false,
      headers: { Authorization: "Bearer header-secret" },
      timeout: 45_000,
      toolPolicy: "allow",
      toolDisclosure: "deferred",
      supportsParallelToolCalls: true,
      allowedTools: ["search", "read"],
    });

    expect(result.valid).toBe(true);
    expect(result.draft).toEqual({
      name: "remote",
      type: "http",
      url: "https://example.test/mcp?visible=true",
      disabled: false,
      headers: { Authorization: "Bearer header-secret" },
      timeout: 45_000,
      toolPolicy: "allow",
      toolDisclosure: "deferred",
      supportsParallelToolCalls: true,
      allowedTools: ["search", "read"],
    });
    expect(result.diagnostics.map(({ code }) => code)).toEqual([
      "name_normalized",
      "server_url_alias",
      "transport_normalized",
    ]);
  });

  it("preserves stdio fields and infers the transport", () => {
    const result = validateMcpServerConfig("local", {
      command: "npx",
      args: ["-y", "server package"],
      env: { API_TOKEN: "env-secret" },
      disabled: true,
      allowedTools: [],
    });

    expect(result).toMatchObject({
      valid: true,
      draft: {
        name: "local",
        type: "stdio",
        command: "npx",
        args: ["-y", "server package"],
        env: { API_TOKEN: "env-secret" },
        disabled: true,
        allowedTools: [],
      },
    });
    expect(result.diagnostics.map(({ code }) => code)).toContain(
      "transport_inferred",
    );
  });

  it("accepts SSE but emits a legacy warning", () => {
    const result = validateMcpServerConfig("events", {
      type: "sse",
      url: "http://localhost:3000/sse",
    });

    expect(result).toMatchObject({
      valid: true,
      draft: { name: "events", type: "sse" },
    });
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: "warning",
        code: "legacy_sse_transport",
      }),
    );
  });

  it.each([
    [
      "prototype-polluting name",
      "__proto__",
      { command: "mcp" },
      "invalid_server_name",
    ],
    ["reserved name", "constructor", { command: "mcp" }, "invalid_server_name"],
    [
      "invalid name characters",
      "bad name",
      { command: "mcp" },
      "invalid_server_name",
    ],
    ["non-object config", "server", [], "invalid_server_config"],
    [
      "command and URL",
      "server",
      { command: "mcp", url: "https://example.test" },
      "conflicting_endpoints",
    ],
    ["missing endpoint", "server", {}, "missing_endpoint"],
    ["stdio missing command", "server", { type: "stdio" }, "command_required"],
    ["HTTP missing URL", "server", { type: "http" }, "url_required"],
    [
      "unsupported transport",
      "server",
      { type: "websocket", url: "https://example.test" },
      "invalid_transport",
    ],
    ["blank command", "server", { command: "  " }, "invalid_command"],
    ["invalid URL", "server", { url: "not a URL" }, "invalid_url"],
    ["non-HTTP URL", "server", { url: "file:///tmp/mcp" }, "invalid_url"],
    [
      "URL userinfo",
      "server",
      { url: "https://user:secret@example.test/mcp" },
      "url_userinfo_not_allowed",
    ],
    [
      "non-string args",
      "server",
      { command: "mcp", args: ["ok", 3] },
      "invalid_args",
    ],
    ["non-object env", "server", { command: "mcp", env: [] }, "invalid_env"],
    [
      "non-string env",
      "server",
      { command: "mcp", env: { TOKEN: 3 } },
      "invalid_env",
    ],
    [
      "non-object headers",
      "server",
      { url: "https://example.test", headers: [] },
      "invalid_headers",
    ],
    [
      "non-string header",
      "server",
      { url: "https://example.test", headers: { Authorization: false } },
      "invalid_headers",
    ],
    [
      "invalid timeout type",
      "server",
      { command: "mcp", timeout: "30" },
      "invalid_timeout",
    ],
    [
      "invalid timeout value",
      "server",
      { command: "mcp", timeout: 0 },
      "invalid_timeout",
    ],
    [
      "invalid disabled",
      "server",
      { command: "mcp", disabled: "false" },
      "invalid_disabled",
    ],
    [
      "invalid policy",
      "server",
      { command: "mcp", toolPolicy: "always" },
      "invalid_tool_policy",
    ],
    [
      "invalid disclosure",
      "server",
      { command: "mcp", toolDisclosure: "hidden" },
      "invalid_tool_disclosure",
    ],
    [
      "invalid parallel support",
      "server",
      { command: "mcp", supportsParallelToolCalls: "yes" },
      "invalid_parallel_tool_calls",
    ],
    [
      "invalid allowed tools",
      "server",
      { command: "mcp", allowedTools: ["read", null] },
      "invalid_allowed_tools",
    ],
    [
      "both URL aliases",
      "server",
      { url: "https://one.test", serverUrl: "https://two.test" },
      "duplicate_endpoint",
    ],
  ] as const)("rejects %s", (_label, name, config, code) => {
    const result = validateMcpServerConfig(name, config);

    expect(result.valid).toBe(false);
    expect(result.draft).toBeUndefined();
    expect(errorCodes(result)).toContain(code);
  });

  it("accepts positive finite timeout values for compatibility", () => {
    expect(
      validateMcpServerConfig("minimum", { command: "mcp", timeout: 1 }),
    ).toMatchObject({
      valid: true,
      draft: { timeout: 1 },
    });
    expect(
      validateMcpServerConfig("long-running", {
        command: "mcp",
        timeout: 900_000,
      }),
    ).toMatchObject({
      valid: true,
      draft: { timeout: 900_000 },
    });
  });

  it("warns for unknown fields without copying them", () => {
    const result = validateMcpServerConfig("foreign", {
      command: "mcp",
      cwd: "/tmp/workspace",
      autoApprove: ["all"],
    });

    expect(result.valid).toBe(true);
    expect(result.draft).toEqual({
      name: "foreign",
      type: "stdio",
      command: "mcp",
    });
    expect(
      result.diagnostics.filter(({ code }) => code === "unknown_field"),
    ).toHaveLength(2);
  });

  it("never includes env or header values in diagnostics", () => {
    const envSecret = "ENV_SECRET_DO_NOT_LEAK";
    const headerSecret = "HEADER_SECRET_DO_NOT_LEAK";
    const result = validateMcpServerConfig("unsafe", {
      command: "mcp",
      env: { TOKEN: envSecret, BAD: 1 },
      headers: { Authorization: headerSecret, BAD: false },
    });

    const diagnostics = JSON.stringify(result.diagnostics);
    expect(diagnostics).not.toContain(envSecret);
    expect(diagnostics).not.toContain(headerSecret);
  });

  it("validates a named canonical draft", () => {
    expect(
      validateMcpServerDraft({
        name: "guided",
        type: "http",
        url: "https://example.test/mcp",
      }),
    ).toMatchObject({
      valid: true,
      draft: {
        name: "guided",
        type: "http",
        url: "https://example.test/mcp",
      },
    });
  });
});
