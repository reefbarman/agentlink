import { describe, expect, it } from "vitest";
import { isMcpToolName, parseMcpToolName } from "../core/mcpToolNames.js";

describe("core MCP tool name parsing", () => {
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
  });

  it("does not classify names without the canonical separator", () => {
    expect(parseMcpToolName("read_file")).toBeNull();
    expect(isMcpToolName("read_file")).toBe(false);
    expect(isMcpToolName("searxng__searxng_web_search")).toBe(true);
  });
});
