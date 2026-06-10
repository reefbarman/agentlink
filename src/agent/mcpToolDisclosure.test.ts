import {
  DEFAULT_MCP_DISCLOSURE_TOKEN_THRESHOLD,
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
    expect(partition.catalog).toHaveLength(0);
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
    expect(partition.catalog.map((entry) => entry.serverName)).toEqual([
      "linear",
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
    expect(partition.catalog).toHaveLength(0);
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
