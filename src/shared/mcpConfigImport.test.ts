import { describe, expect, it } from "vitest";

import { parseMcpConfigImport } from "./mcpConfigImport.js";

function rowErrorCodes(raw: string): string[] {
  return parseMcpConfigImport(raw).rows.flatMap((row) =>
    row.diagnostics
      .filter((diagnostic) => diagnostic.severity === "error")
      .map((diagnostic) => diagnostic.code),
  );
}

describe("parseMcpConfigImport", () => {
  it.each([
    {
      label: "mcpServers wrapper",
      input: JSON.stringify({ mcpServers: { alpha: { command: "alpha" } } }),
      rootKind: "mcpServers",
    },
    {
      label: "servers wrapper",
      input: JSON.stringify({ servers: { alpha: { command: "alpha" } } }),
      rootKind: "servers",
    },
    {
      label: "named single config",
      input: JSON.stringify({ name: "alpha", command: "alpha" }),
      rootKind: "named",
    },
    {
      label: "bare map",
      input: JSON.stringify({ alpha: { command: "alpha" } }),
      rootKind: "bare",
    },
  ] as const)("accepts $label", ({ input, rootKind }) => {
    const result = parseMcpConfigImport(input);

    expect(result).toMatchObject({
      valid: true,
      rootKind,
      rows: [
        {
          name: "alpha",
          selected: true,
          valid: true,
          draft: { name: "alpha", type: "stdio", command: "alpha" },
        },
      ],
    });
  });

  it.each([
    {
      label: "JSON",
      input: '{"mcpServers":{"alpha":{"command":"alpha"}}}',
    },
    {
      label: "JSONC",
      input: `{
        // accepted comment
        "mcpServers": {
          "alpha": {
            "command": "alpha",
          },
        },
      }`,
    },
    {
      label: "BOM",
      input: '\uFEFF{"mcpServers":{"alpha":{"command":"alpha"}}}',
    },
    {
      label: "complete JSON fence",
      input: '```json\n{"mcpServers":{"alpha":{"command":"alpha"}}}\n```',
    },
    {
      label: "complete JSONC fence",
      input: '```jsonc\n{"mcpServers":{"alpha":{"command":"alpha",},},}\n```',
    },
    {
      label: "unlabeled fence",
      input: '```\n{"mcpServers":{"alpha":{"command":"alpha"}}}\n```',
    },
  ])("accepts $label input", ({ input }) => {
    expect(parseMcpConfigImport(input)).toMatchObject({
      valid: true,
      rows: [{ name: "alpha", valid: true }],
    });
  });

  it('accepts a bare-map server named "name"', () => {
    const result = parseMcpConfigImport(
      JSON.stringify({ name: { command: "name-server" } }),
    );

    expect(result).toMatchObject({
      valid: true,
      rootKind: "bare",
      rows: [
        {
          name: "name",
          draft: {
            name: "name",
            type: "stdio",
            command: "name-server",
          },
        },
      ],
    });
  });

  it("imports the supplied Unity serverUrl example", () => {
    const result = parseMcpConfigImport(`{
      "mcpServers": {
        "unityMCP": {
          "serverUrl": "http://127.0.0.1:8080/mcp",
          "type": "http",
          "disabled": false
        }
      }
    }`);

    expect(result).toMatchObject({
      valid: true,
      rootKind: "mcpServers",
      rows: [
        {
          name: "unityMCP",
          valid: true,
          selected: true,
          draft: {
            name: "unityMCP",
            type: "http",
            url: "http://127.0.0.1:8080/mcp",
            disabled: false,
          },
        },
      ],
    });
    expect(result.rows[0].diagnostics).toContainEqual(
      expect.objectContaining({ severity: "info", code: "server_url_alias" }),
    );
  });

  it("imports and reviews multiple servers with canonical transports", () => {
    const result = parseMcpConfigImport(`{
      "servers": {
        "local": {
          "command": "npx",
          "args": ["-y", "@example/mcp"],
          "env": { "TOKEN": "env-secret" },
          "toolPolicy": "allow"
        },
        "remote": {
          "type": "streamable-http",
          "url": "https://example.test/mcp",
          "headers": { "Authorization": "Bearer header-secret" },
          "timeout": 30000,
          "toolDisclosure": "inline",
          "allowedTools": ["search"]
        },
        "events": {
          "type": "sse",
          "url": "http://localhost:3000/sse",
          "disabled": true
        }
      }
    }`);

    expect(result.valid).toBe(true);
    expect(result.rows.map((row) => row.draft)).toEqual([
      {
        name: "local",
        type: "stdio",
        command: "npx",
        args: ["-y", "@example/mcp"],
        env: { TOKEN: "env-secret" },
        toolPolicy: "allow",
      },
      {
        name: "remote",
        type: "http",
        url: "https://example.test/mcp",
        headers: { Authorization: "Bearer header-secret" },
        timeout: 30_000,
        toolDisclosure: "inline",
        allowedTools: ["search"],
      },
      {
        name: "events",
        type: "sse",
        url: "http://localhost:3000/sse",
        disabled: true,
      },
    ]);
    expect(result.rows[2].diagnostics).toContainEqual(
      expect.objectContaining({ code: "legacy_sse_transport" }),
    );
  });

  it("warns about unsupported root and server fields", () => {
    const result = parseMcpConfigImport(`{
      "version": 1,
      "mcpServers": {
        "foreign": {
          "command": "mcp",
          "cwd": "/tmp/project",
          "autoApprove": true
        }
      }
    }`);

    expect(result.valid).toBe(true);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: "warning",
        code: "unknown_root_field",
        path: "$.version",
      }),
    );
    expect(
      result.rows[0].diagnostics.filter(({ code }) => code === "unknown_field"),
    ).toHaveLength(2);
    expect(result.rows[0].draft).toEqual({
      name: "foreign",
      type: "stdio",
      command: "mcp",
    });
  });

  it.each([
    ["malformed JSON", '{"mcpServers":', "invalid_json"],
    ["unclosed fence", '```json\n{"mcpServers":{}}', "invalid_fence"],
    [
      "trailing prose after fence",
      '```json\n{"mcpServers":{}}\n```\ntext',
      "invalid_fence",
    ],
    ["multiple fences", "```json\n{}\n```\n```json\n{}\n```", "invalid_fence"],
    ["non-JSON fence", "```yaml\nmcpServers: {}\n```", "invalid_fence"],
    ["array root", "[]", "invalid_root"],
    ["scalar root", "null", "invalid_root"],
    ["ambiguous wrappers", '{"mcpServers":{},"servers":{}}', "invalid_root"],
    ["invalid wrapper", '{"mcpServers":[]}', "invalid_root"],
    ["non-server bare value", '{"alpha":"command"}', "invalid_root"],
    ["empty wrapper", '{"mcpServers":{}}', "no_servers"],
  ])("rejects %s", (_label, input, code) => {
    const result = parseMcpConfigImport(input);

    expect(result.valid).toBe(false);
    expect(result.diagnostics.map((entry) => entry.code)).toContain(code);
  });

  it.each([
    [
      "prototype name",
      '{"mcpServers":{"__proto__":{"command":"mcp"}}}',
      "invalid_server_name",
    ],
    [
      "command and URL",
      '{"mcpServers":{"bad":{"command":"mcp","url":"https://example.test"}}}',
      "conflicting_endpoints",
    ],
    ["missing endpoint", '{"mcpServers":{"bad":{}}}', "missing_endpoint"],
    [
      "invalid transport",
      '{"mcpServers":{"bad":{"type":"ws","url":"https://example.test"}}}',
      "invalid_transport",
    ],
    [
      "invalid URL",
      '{"mcpServers":{"bad":{"url":"file:///tmp/mcp"}}}',
      "invalid_url",
    ],
    [
      "URL userinfo",
      '{"mcpServers":{"bad":{"url":"https://user:password@example.test"}}}',
      "url_userinfo_not_allowed",
    ],
    [
      "non-string array",
      '{"mcpServers":{"bad":{"command":"mcp","args":[1]}}}',
      "invalid_args",
    ],
    [
      "non-string record",
      '{"mcpServers":{"bad":{"command":"mcp","env":{"TOKEN":1}}}}',
      "invalid_env",
    ],
    [
      "invalid boolean",
      '{"mcpServers":{"bad":{"command":"mcp","disabled":0}}}',
      "invalid_disabled",
    ],
    [
      "invalid number",
      '{"mcpServers":{"bad":{"command":"mcp","timeout":-1}}}',
      "invalid_timeout",
    ],
    [
      "invalid policy",
      '{"mcpServers":{"bad":{"command":"mcp","toolPolicy":"always"}}}',
      "invalid_tool_policy",
    ],
    [
      "invalid disclosure",
      '{"mcpServers":{"bad":{"command":"mcp","toolDisclosure":"none"}}}',
      "invalid_tool_disclosure",
    ],
  ])("keeps a review row for %s", (_label, input, code) => {
    const result = parseMcpConfigImport(input);

    expect(result.valid).toBe(false);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ selected: false, valid: false });
    expect(rowErrorCodes(input)).toContain(code);
  });

  it("rejects duplicate normalized names", () => {
    const result = parseMcpConfigImport(`{
      "mcpServers": {
        "duplicate": { "command": "one" },
        " duplicate ": { "command": "two" }
      }
    }`);

    expect(result.valid).toBe(false);
    expect(result.rows).toHaveLength(2);
    expect(result.rows.every((row) => !row.valid && !row.selected)).toBe(true);
    expect(
      result.rows.every((row) =>
        row.diagnostics.some(
          (diagnostic) => diagnostic.code === "duplicate_server_name",
        ),
      ),
    ).toBe(true);
  });

  it("never includes env or header values in diagnostics or row summaries", () => {
    const envSecret = "ENV_SECRET_DO_NOT_LEAK";
    const headerSecret = "HEADER_SECRET_DO_NOT_LEAK";
    const result = parseMcpConfigImport(`{
      "mcpServers": {
        "unsafe": {
          "command": "mcp",
          "url": "https://example.test",
          "env": { "TOKEN": "${envSecret}", "BAD": 1 },
          "headers": { "Authorization": "${headerSecret}", "BAD": false }
        }
      }
    }`);

    const safeSummary = JSON.stringify({
      diagnostics: result.diagnostics,
      rows: result.rows.map(({ name, valid, selected, diagnostics }) => ({
        name,
        valid,
        selected,
        diagnostics,
      })),
    });
    expect(safeSummary).not.toContain(envSecret);
    expect(safeSummary).not.toContain(headerSecret);
  });
});
