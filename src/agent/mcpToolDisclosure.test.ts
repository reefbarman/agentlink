import {
  DEFAULT_MCP_DISCLOSURE_TOKEN_THRESHOLD,
  buildMcpToolCatalogSection,
  partitionMcpToolsForDisclosure,
} from "./mcpToolDisclosure.js";
import { describe, expect, it } from "vitest";

import type { ToolDefinition } from "./providers/types.js";
import { estimateTokensFromChars } from "./contextBreakdown.js";

function tool(name: string, description = "test tool"): ToolDefinition {
  return {
    name,
    description,
    input_schema: {
      type: "object",
      properties: {
        value: {
          type: "string",
          description,
        },
      },
    },
  };
}

describe("partitionMcpToolsForDisclosure", () => {
  it("keeps small auto-mode servers inline", () => {
    const partition = partitionMcpToolsForDisclosure(
      [tool("small__search"), tool("small__fetch")],
      { perServerTokenThreshold: 10_000 },
    );

    expect(partition.inlineTools.map((t) => t.name)).toEqual([
      "small__search",
      "small__fetch",
    ]);
    expect(partition.deferredTools).toHaveLength(0);
    expect(partition.catalog).toEqual([
      expect.objectContaining({
        serverName: "small",
        toolCount: 2,
        representativeTools: ["fetch", "search"],
        deferred: false,
      }),
    ]);
  });

  it("defers auto-mode servers at or above the configured token threshold", () => {
    const partition = partitionMcpToolsForDisclosure(
      [tool("large__alpha"), tool("large__beta")],
      { perServerTokenThreshold: 1 },
    );

    expect(partition.inlineTools).toHaveLength(0);
    expect(partition.deferredTools.map((t) => t.name)).toEqual([
      "large__alpha",
      "large__beta",
    ]);
    expect(partition.catalog).toEqual([
      {
        serverName: "large",
        toolCount: 2,
        estimatedTokens: expect.any(Number),
        representativeTools: ["alpha", "beta"],
        capabilities: undefined,
        deferred: true,
      },
    ]);
  });

  it("honors explicit inline and deferred server modes", () => {
    const partition = partitionMcpToolsForDisclosure(
      [tool("linear__issue"), tool("notion__page")],
      {
        perServerTokenThreshold: 10_000,
        serverConfigs: [
          { serverName: "linear", mode: "deferred" },
          { serverName: "notion", mode: "inline" },
        ],
      },
    );

    expect(partition.inlineTools.map((t) => t.name)).toEqual(["notion__page"]);
    expect(partition.deferredTools.map((t) => t.name)).toEqual([
      "linear__issue",
    ]);
    expect(partition.catalog).toEqual([
      expect.objectContaining({ serverName: "linear", deferred: true }),
      expect.objectContaining({ serverName: "notion", deferred: false }),
    ]);
  });

  it("keeps non-MCP tool names inline", () => {
    const partition = partitionMcpToolsForDisclosure([tool("read_file")], {
      perServerTokenThreshold: 1,
    });

    expect(partition.inlineTools.map((t) => t.name)).toEqual(["read_file"]);
    expect(partition.deferredTools).toHaveLength(0);
  });

  it("uses the exact threshold boundary for auto-mode deferral", () => {
    const tools = [tool("boundary__search")];
    const estimatedTokens = estimateTokensFromChars(
      JSON.stringify(tools).length,
    );

    expect(
      partitionMcpToolsForDisclosure(tools, {
        perServerTokenThreshold: estimatedTokens + 1,
      }).inlineTools.map((t) => t.name),
    ).toEqual(["boundary__search"]);

    expect(
      partitionMcpToolsForDisclosure(tools, {
        perServerTokenThreshold: estimatedTokens,
      }).deferredTools.map((t) => t.name),
    ).toEqual(["boundary__search"]);
  });

  it("uses the default threshold for auto mode", () => {
    const partition = partitionMcpToolsForDisclosure([tool("default__small")]);

    expect(DEFAULT_MCP_DISCLOSURE_TOKEN_THRESHOLD).toBe(2_000);
    expect(partition.inlineTools.map((t) => t.name)).toEqual([
      "default__small",
    ]);
    expect(partition.catalog).toEqual([
      expect.objectContaining({
        serverName: "default",
        deferred: false,
      }),
    ]);
  });

  it("sorts catalog entries by server name", () => {
    const partition = partitionMcpToolsForDisclosure(
      [tool("zeta__search"), tool("alpha__search")],
      { perServerTokenThreshold: 1 },
    );

    expect(partition.catalog.map((entry) => entry.serverName)).toEqual([
      "alpha",
      "zeta",
    ]);
  });

  it("treats explicit auto mode like default auto mode", () => {
    const partition = partitionMcpToolsForDisclosure([tool("auto__small")], {
      perServerTokenThreshold: 10_000,
      serverConfigs: [{ serverName: "auto", mode: "auto" }],
    });

    expect(partition.inlineTools.map((t) => t.name)).toEqual(["auto__small"]);
    expect(partition.deferredTools).toHaveLength(0);
  });

  it("adds catalog entries for all inline MCP servers", () => {
    const partition = partitionMcpToolsForDisclosure(
      [
        tool("ddg-search__search"),
        tool("ddg-search__fetch_content"),
        tool("linear__list_issues"),
      ],
      { perServerTokenThreshold: 10_000 },
    );

    expect(partition.inlineTools.map((t) => t.name)).toEqual([
      "ddg-search__search",
      "ddg-search__fetch_content",
      "linear__list_issues",
    ]);
    expect(partition.deferredTools).toHaveLength(0);
    expect(partition.catalog).toEqual([
      expect.objectContaining({
        serverName: "ddg-search",
        capabilities: ["web-search"],
        deferred: false,
      }),
      expect.objectContaining({
        serverName: "linear",
        representativeTools: ["list_issues"],
        deferred: false,
      }),
    ]);

    const section = buildMcpToolCatalogSection(partition.catalog);
    expect(section).toContain("ddg-search: 2 tools, tools available directly");
    expect(section).toContain("linear: 1 tools, tools available directly");
    expect(section).not.toContain("ddg-search: 2 tools, ~");
  });

  it("explicitly tells the model how to use direct and deferred MCP servers", () => {
    const partition = partitionMcpToolsForDisclosure(
      [
        tool("linear__list_issues"),
        tool("notion__search_pages"),
        tool("notion__update_page"),
      ],
      {
        perServerTokenThreshold: 10_000,
        serverConfigs: [
          { serverName: "linear", mode: "inline" },
          { serverName: "notion", mode: "deferred" },
        ],
      },
    );

    const section = buildMcpToolCatalogSection(partition.catalog);
    expect(section).toContain("Connected MCP servers are available now");
    expect(section).toContain("linear: 1 tools, tools available directly");
    expect(section).toContain("notion: 2 tools, ~");
    expect(section).toContain("find_mcp_tools");
    expect(section).toContain("call_mcp_tool");
    expect(section).toContain(
      "Do not tell the user there is no way to interact",
    );
  });

  it("injects web-search and browser-automation capability hints", () => {
    const partition = partitionMcpToolsForDisclosure(
      [
        tool("ddg-search__search"),
        tool("ddg-search__fetch_content"),
        tool("chrome-devtools__navigate"),
        tool("chrome-devtools__screenshot"),
      ],
      { perServerTokenThreshold: 1 },
    );

    const section = buildMcpToolCatalogSection(partition.catalog);
    expect(section).toContain(
      "chrome-devtools: 2 tools, ~83 schema tokens deferred",
    );
    expect(section).toContain(
      "ddg-search: 2 tools, ~80 schema tokens deferred",
    );
    expect(section).toContain("MCP capability hints");
    expect(section).toContain("web-search (ddg-search)");
    expect(section).toContain("prefer checking the web");
    expect(section).toContain("browser-automation (chrome-devtools)");
    expect(section).toContain("verifying in the browser");
  });

  it("detects capabilities from all tool names, not just representative names", () => {
    const partition = partitionMcpToolsForDisclosure(
      [
        tool("chrome-devtools__aaa"),
        tool("chrome-devtools__bbb"),
        tool("chrome-devtools__ccc"),
        tool("chrome-devtools__ddd"),
        tool("chrome-devtools__eee"),
        tool("chrome-devtools__screenshot"),
      ],
      { perServerTokenThreshold: 1, representativeToolLimit: 5 },
    );

    expect(partition.catalog[0]).toMatchObject({
      serverName: "chrome-devtools",
      representativeTools: ["aaa", "bbb", "ccc", "ddd", "eee"],
      capabilities: ["browser-automation"],
    });
  });

  it("limits and sorts representative tool names", () => {
    const partition = partitionMcpToolsForDisclosure(
      [tool("srv__zeta"), tool("srv__alpha"), tool("srv__middle")],
      { perServerTokenThreshold: 1, representativeToolLimit: 2 },
    );

    expect(partition.catalog[0]?.representativeTools).toEqual([
      "alpha",
      "middle",
    ]);
  });
});
