import { describe, expect, it } from "vitest";

import { isForwardedBuiltinCommand } from "./builtinCommandForwarding";

describe("isForwardedBuiltinCommand", () => {
  it.each([
    "skills",
    "plugin",
    "plugins",
    "mcp",
    "mcp-config",
    "mcp-refresh",
    "btw",
    "worktree",
    "review",
    "pair",
    "usage",
    "condense",
    "context-doctor",
    "workspace",
    "checkpoint",
    "revert",
  ])("forwards the VS Code command %s", (name) => {
    expect(isForwardedBuiltinCommand("vscode", name)).toBe(true);
  });

  it.each([
    "condense",
    "context-doctor",
    "checkpoint",
    "revert",
    "mcp-config",
    "mcp-refresh",
    "btw",
    "help",
  ])("forwards the browser command %s", (name) => {
    expect(isForwardedBuiltinCommand("browser", name)).toBe(true);
  });

  it.each([
    ["vscode", "unknown"],
    ["vscode", "help"],
    ["vscode", "new"],
    ["vscode", "mode"],
    ["vscode", "model"],
    ["browser", "unknown"],
    ["browser", "skills"],
    ["browser", "plugin"],
    ["browser", "plugins"],
    ["browser", "usage"],
    ["browser", "new"],
    ["browser", "mode"],
    ["browser", "model"],
    ["browser", "mcp"],
    ["browser", "pair"],
    ["browser", "worktree"],
    ["browser", "review"],
    ["browser", "workspace"],
  ] as const)("does not forward %s command %s", (surface, name) => {
    expect(isForwardedBuiltinCommand(surface, name)).toBe(false);
  });
});
