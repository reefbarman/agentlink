import { describe, expect, expectTypeOf, it } from "vitest";

import {
  isMcpToolName,
  parseMcpToolName,
  type ParsedMcpToolName,
} from "./mcpToolIdentity.js";

describe("MCP tool identity", () => {
  it("parses server and bare tool names from the first separator", () => {
    expect(parseMcpToolName("linear__list_issues")).toEqual({
      serverName: "linear",
      bareToolName: "list_issues",
    });
    expect(parseMcpToolName("server__name__tool")).toEqual({
      serverName: "server",
      bareToolName: "name__tool",
    });
  });

  it("preserves established degenerate-name behavior", () => {
    expect(parseMcpToolName("__broken")).toEqual({
      serverName: "",
      bareToolName: "broken",
    });
    expect(parseMcpToolName("broken__")).toEqual({
      serverName: "broken",
      bareToolName: "",
    });
    expect(isMcpToolName("__broken")).toBe(true);
    expect(isMcpToolName("broken__")).toBe(true);
  });

  it("does not classify names without the canonical separator", () => {
    expect(parseMcpToolName("read_file")).toBeNull();
    expect(isMcpToolName("read_file")).toBe(false);
    expect(isMcpToolName("searxng__searxng_web_search")).toBe(true);
  });

  it("returns the complete serializable identity DTO", () => {
    const parsed = parseMcpToolName("linear__list_issues");
    expectTypeOf(parsed).toEqualTypeOf<ParsedMcpToolName | null>();
  });
});
