import { describe, expect, expectTypeOf, it } from "vitest";

import {
  parseMcpConfigImport,
  type McpConfigImportReview,
  type McpConfigImportRootKind,
} from "./mcpConfigImport.js";

describe("MCP config import protocol compatibility shim", () => {
  it("preserves the legacy review DTO and parser behavior", () => {
    expectTypeOf<McpConfigImportRootKind>().toEqualTypeOf<
      "mcpServers" | "servers" | "named" | "bare"
    >();
    expectTypeOf<McpConfigImportReview>().toHaveProperty("rows");
    const result = parseMcpConfigImport(`{
      // accepted comment
      "mcpServers": {
        " remote ": {
          "type": "streamable-http",
          "serverUrl": "https://example.test/mcp",
        },
      },
    }`);
    expect(result).toMatchObject({
      valid: true,
      rootKind: "mcpServers",
      rows: [
        {
          sourceName: "remote",
          name: "remote",
          selected: true,
          valid: true,
          draft: {
            name: "remote",
            type: "http",
            url: "https://example.test/mcp",
          },
        },
      ],
    });
    expect(result.rows[0].diagnostics.map(({ code }) => code)).toEqual([
      "name_normalized",
      "server_url_alias",
      "transport_normalized",
    ]);
  });
});
