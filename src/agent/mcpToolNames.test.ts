import { describe, expect, it } from "vitest";
import { isMcpToolName, parseMcpToolName } from "./mcpToolNames.js";

describe("MCP tool name parsing", () => {
  it("parses server and bare tool name from the first separator", () => {
    expect(parseMcpToolName("linear__list_issues")).toEqual({
      serverName: "linear",
      bareToolName: "list_issues",
    });
    expect(parseMcpToolName("server__name__tool")).toEqual({
      serverName: "server",
      bareToolName: "name__tool",
    });
  });

  it("matches existing runtime classification for degenerate names", () => {
    expect(isMcpToolName("__broken")).toBe(true);
    expect(parseMcpToolName("__broken")).toEqual({
      serverName: "",
      bareToolName: "broken",
    });
    expect(isMcpToolName("broken__")).toBe(true);
    expect(parseMcpToolName("broken__")).toEqual({
      serverName: "broken",
      bareToolName: "",
    });
  });

  it("does not classify names without a separator as MCP tools", () => {
    expect(isMcpToolName("read_file")).toBe(false);
    expect(parseMcpToolName("read_file")).toBeNull();
  });
});
