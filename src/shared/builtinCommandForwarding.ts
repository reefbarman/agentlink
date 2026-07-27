export type BuiltinCommandSurface = "vscode" | "browser";

const FORWARDED_BUILTIN_COMMANDS: Record<
  BuiltinCommandSurface,
  ReadonlySet<string>
> = {
  vscode: new Set([
    "skills",
    "mcp",
    "mcp-config",
    "mcp-refresh",
    "btw",
    "worktree",
    "pair",
    "usage",
    "condense",
    "context-doctor",
    "checkpoint",
    "revert",
  ]),
  browser: new Set([
    "condense",
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
