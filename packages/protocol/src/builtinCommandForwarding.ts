export type BuiltinCommandSurface = "vscode" | "browser";

const FORWARDED_BUILTIN_COMMANDS: Record<
  BuiltinCommandSurface,
  ReadonlySet<string>
> = {
  vscode: new Set([
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
  ]),
  browser: new Set([
    "condense",
    "handoff",
    "context-doctor",
    "checkpoint",
    "revert",
    "mcp-config",
    "mcp-refresh",
    "btw",
    "help",
  ]),
};

export function isForwardedBuiltinCommand(
  surface: BuiltinCommandSurface,
  name: string,
): boolean {
  return FORWARDED_BUILTIN_COMMANDS[surface].has(name);
}
