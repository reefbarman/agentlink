import {
  buildToolContextBreakdown,
  estimateTokensFromChars,
  measureContextItem,
} from "./contextBreakdown.js";
import { describe, expect, it } from "vitest";

import type { ToolDefinition } from "./providers/types.js";

describe("contextBreakdown", () => {
  it("estimates tokens from chars conservatively", () => {
    expect(estimateTokensFromChars(0)).toBe(0);
    expect(estimateTokensFromChars(1)).toBe(1);
    expect(estimateTokensFromChars(4)).toBe(1);
    expect(estimateTokensFromChars(5)).toBe(2);
  });

  it("measures prompt sections", () => {
    expect(measureContextItem("base", "abcd", 2)).toEqual({
      label: "base",
      chars: 4,
      estimatedTokens: 1,
      count: 2,
    });
  });

  it("splits tool schemas into native and per-MCP-server buckets", () => {
    const tools: ToolDefinition[] = [
      {
        name: "read_file",
        description: "Read files",
        input_schema: {
          type: "object",
          properties: { path: { type: "string" } },
        },
      },
      {
        name: "linear__get_issue",
        description: "Get issue",
        input_schema: {
          type: "object",
          properties: { id: { type: "string" } },
        },
      },
      {
        name: "linear__save_issue",
        description: "Save issue",
        input_schema: {
          type: "object",
          properties: { title: { type: "string" } },
        },
      },
      {
        name: "notion__notion-fetch",
        description: "Fetch page",
        input_schema: {
          type: "object",
          properties: { id: { type: "string" } },
        },
      },
    ];

    const breakdown = buildToolContextBreakdown(tools);

    expect(breakdown.totalToolCount).toBe(4);
    expect(breakdown.native.count).toBe(1);
    expect(breakdown.mcp.totalServerCount).toBe(2);
    expect(breakdown.mcp.totalToolCount).toBe(3);
    expect(breakdown.mcp.servers.map((server) => server.serverName)).toEqual([
      "linear",
      "notion",
    ]);
    expect(breakdown.mcp.servers[0]?.toolCount).toBe(2);
    expect(breakdown.totalChars).toBe(
      breakdown.native.chars + breakdown.mcp.totalChars,
    );
  });
});
