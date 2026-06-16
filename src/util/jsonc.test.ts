import { describe, expect, it } from "vitest";

import { parseJsonWithComments } from "./jsonc.js";

describe("parseJsonWithComments", () => {
  it("parses line comments, block comments, and trailing commas", () => {
    expect(
      parseJsonWithComments(`{
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

  it("preserves comment markers inside strings", () => {
    expect(
      parseJsonWithComments(`{
        "url": "https://example.com/a//b",
        "pattern": "/* literal */"
      }`),
    ).toEqual({
      url: "https://example.com/a//b",
      pattern: "/* literal */",
    });
  });
});
