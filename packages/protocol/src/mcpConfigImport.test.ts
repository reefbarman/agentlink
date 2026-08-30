import { describe, expect, expectTypeOf, it } from "vitest";

import {
  parseMcpConfigImport,
  type McpConfigImportReview,
  type McpConfigImportRootKind,
} from "./mcpConfigImport.js";

function rowErrorCodes(raw: string): string[] {
  return parseMcpConfigImport(raw).rows.flatMap((row) =>
    row.diagnostics
      .filter((diagnostic) => diagnostic.severity === "error")
      .map((diagnostic) => diagnostic.code),
  );
}

describe("MCP config import protocol", () => {
  it("keeps review DTOs and root kinds stable", () => {
    expectTypeOf<McpConfigImportRootKind>().toEqualTypeOf<
      "mcpServers" | "servers" | "named" | "bare"
    >();
    expectTypeOf<McpConfigImportReview>().toHaveProperty("valid");
    expectTypeOf<McpConfigImportReview>().toHaveProperty("rows");
    expectTypeOf<McpConfigImportReview>().toHaveProperty("diagnostics");
  });

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
    expect(parseMcpConfigImport(input)).toMatchObject({
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
    '{"mcpServers":{"alpha":{"command":"alpha"}}}',
    `{
      // accepted comment
      "mcpServers": { "alpha": { "command": "alpha", }, },
    }`,
    '\uFEFF{"mcpServers":{"alpha":{"command":"alpha"}}}',
    '```json\n{"mcpServers":{"alpha":{"command":"alpha"}}}\n```',
    '```jsonc\n{"mcpServers":{"alpha":{"command":"alpha",},},}\n```',
    '```\n{"mcpServers":{"alpha":{"command":"alpha"}}}\n```',
  ])("accepts JSON, JSONC, BOM, and complete JSON fences", (input) => {
    expect(parseMcpConfigImport(input)).toMatchObject({
      valid: true,
      rows: [{ name: "alpha", valid: true }],
    });
  });

  it("imports multiple canonical transports and preserves secret-bearing drafts", () => {
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

  it("keeps review rows for invalid servers and rejects duplicate normalized names", () => {
    expect(
      rowErrorCodes(
        '{"mcpServers":{"bad":{"command":"mcp","url":"https://example.test"}}}',
      ),
    ).toContain("conflicting_endpoints");

    const duplicates = parseMcpConfigImport(`{
      "mcpServers": {
        "duplicate": { "command": "one" },
        " duplicate ": { "command": "two" }
      }
    }`);
    expect(duplicates.valid).toBe(false);
    expect(duplicates.rows).toHaveLength(2);
    expect(duplicates.rows.every((row) => !row.valid && !row.selected)).toBe(
      true,
    );
    expect(
      duplicates.rows.every((row) =>
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
