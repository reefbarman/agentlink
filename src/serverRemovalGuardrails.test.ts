import * as fs from "fs";
import * as path from "path";
import * as toolSchemas from "./shared/toolSchemas.js";

import { describe, expect, it } from "vitest";

import { TOOL_REGISTRY } from "./shared/toolRegistry.js";

const root = path.join(__dirname, "..");

const removedPaths = [
  "src/server/McpServerHost.ts",
  "src/server/registerTools.ts",
  "src/server/tools",
  "src/agents",
  "src/setup.ts",
  "src/tools/handshake.ts",
  "resources/claude-instructions.md",
  "resources/agents-instructions.md",
  "resources/enforce-agentlink.sh",
  "resources/enforce-agentlink.ps1",
];

const retainedPaths = [
  "src/server/ToolCallTracker.ts",
  "src/agent/McpClientHub.ts",
];

describe("external MCP server removal guardrails", () => {
  it("keeps removed server and external-agent setup modules absent", () => {
    for (const relativePath of removedPaths) {
      expect(fs.existsSync(path.join(root, relativePath)), relativePath).toBe(
        false,
      );
    }
    expect(Object.hasOwn(TOOL_REGISTRY, "handshake")).toBe(false);
    expect(Object.hasOwn(toolSchemas, "handshakeSchema")).toBe(false);
  });

  it("retains built-in tracking and MCP client contracts", () => {
    for (const relativePath of retainedPaths) {
      expect(fs.existsSync(path.join(root, relativePath)), relativePath).toBe(
        true,
      );
    }

    const extensionPackage = JSON.parse(
      fs.readFileSync(path.join(root, "package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };
    expect(
      Object.hasOwn(
        extensionPackage.dependencies ?? {},
        "@modelcontextprotocol/sdk",
      ),
    ).toBe(true);
  });
});
