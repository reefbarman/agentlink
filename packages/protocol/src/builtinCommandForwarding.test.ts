import { describe, expect, expectTypeOf, it } from "vitest";

import {
  isForwardedBuiltinCommand,
  type BuiltinCommandSurface,
} from "./builtinCommandForwarding.js";

const VSCODE_FORWARDED_COMMANDS = [
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
  "handoff",
  "context-doctor",
  "workspace",
  "checkpoint",
  "revert",
] as const;

const BROWSER_FORWARDED_COMMANDS = [
  "condense",
  "handoff",
  "context-doctor",
  "checkpoint",
  "revert",
  "mcp-config",
  "mcp-refresh",
  "btw",
  "help",
] as const;

describe("built-in command forwarding protocol", () => {
  it("keeps the supported surface union stable", () => {
    expectTypeOf<BuiltinCommandSurface>().toEqualTypeOf<"vscode" | "browser">();
  });

  it.each(VSCODE_FORWARDED_COMMANDS)(
    "forwards the VS Code command %s",
    (name) => {
      expect(isForwardedBuiltinCommand("vscode", name)).toBe(true);
    },
  );

  it.each(BROWSER_FORWARDED_COMMANDS)(
    "forwards the browser command %s",
    (name) => {
      expect(isForwardedBuiltinCommand("browser", name)).toBe(true);
    },
  );

  it("preserves commands shared by both surfaces", () => {
    expect(
      VSCODE_FORWARDED_COMMANDS.filter((name) =>
        BROWSER_FORWARDED_COMMANDS.includes(
          name as (typeof BROWSER_FORWARDED_COMMANDS)[number],
        ),
      ),
    ).toEqual([
      "mcp-config",
      "mcp-refresh",
      "btw",
      "condense",
      "handoff",
      "context-doctor",
      "checkpoint",
      "revert",
    ]);
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
