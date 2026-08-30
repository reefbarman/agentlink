import { describe, expect, it } from "vitest";

import { parseJsonWithComments } from "./jsonc.js";

describe("JSONC protocol parsing", () => {
  it("parses line comments, block comments, trailing commas, and BOM", () => {
    expect(
      parseJsonWithComments(`\uFEFF{
        // user note
        "mcpServers": {
          "agentlink": {
            "url": "http://localhost:4321/mcp", /* inline note */
            "args": [
              "--flag",
            ],
          },
        },
      }`),
    ).toEqual({
      mcpServers: {
        agentlink: {
          url: "http://localhost:4321/mcp",
          args: ["--flag"],
        },
      },
    });
  });

  it("preserves comment markers and comma-like text inside strings", () => {
    expect(
      parseJsonWithComments(`{
        "url": "https://example.com/a//b",
        "pattern": "/* literal */",
        "comma": ",}"
      }`),
    ).toEqual({
      url: "https://example.com/a//b",
      pattern: "/* literal */",
      comma: ",}",
    });
  });
});
