import * as os from "os";
import * as path from "path";

import { expandSubCommands, splitCompoundCommand } from "./commandSplitter.js";

export type CommandTier = "safe" | "sensitive" | "dangerous";

export interface CommandTierResult {
  tier: CommandTier;
  reason: string;
}

export interface CommandTierContext {
  cwd: string;
  workspaceRoots: string[];
}

export interface CommandTierClassifier {
  classify(subCommand: string, ctx: CommandTierContext): CommandTierResult;
}

export interface ClassifiedCommand {
  tier: CommandTier;
  perSubCommand: Array<{ command: string; result: CommandTierResult }>;
}

const TIER_RANK: Record<CommandTier, number> = {
  safe: 1,
  sensitive: 2,
  dangerous: 3,
};

const SAFE_COMMANDS = new Set([
  "arch",
  "basename",
  "date",
  "df",
  "dirname",
  "du",
  "echo",
  "file",
  "find",
  "grep",
  "id",
  "ls",
  "md5",
  "md5sum",
  "pwd",
  "rg",
  "shasum",
  "stat",
  "true",
  "uname",
  "wc",
  "which",
  "whoami",
]);

const SAFE_VERSION_COMMANDS = new Set([
  "bun",
  "cargo",
  "deno",
  "go",
  "java",
  "node",
  "npm",
  "pnpm",
  "python",
  "python3",
  "ruby",
  "rustc",
  "tsc",
  "yarn",
]);

const SENSITIVE_COMMANDS = new Set([
  "bun",
  "cargo",
  "cp",
  "go",
  "git",
  "make",
  "mkdir",
  "mv",
  "npm",
  "npx",
  "pnpm",
  "task",
  "touch",
  "yarn",
]);

const DANGEROUS_COMMANDS = new Set([
  "bash",
  "chmod",
  "chown",
  "crontab",
  "curl",
  "dd",
  "defaults",
  "diskutil",
  "doas",
  "env",
  "eval",
  "export",
  "fish",
  "kill",
  "killall",
  "launchctl",
  "mkfs",
  "nc",
  "netcat",
  "osascript",
  "perl",
  "php",
  "pkill",
  "printenv",
  "python",
  "python3",
  "rm",
  "rmdir",
  "ruby",
  "scp",
  "sh",
  "ssh",
  "sudo",
  "wget",
  "xargs",
  "zsh",
]);

const SAFE_GIT_SUBCOMMANDS = new Set([
  "blame",
  "branch",
  "diff",
  "grep",
  "log",
  "remote",
  "rev-parse",
  "show",
  "status",
  "stash",
]);

const SENSITIVE_GIT_SUBCOMMANDS = new Set([
  "add",
  "checkout",
  "commit",
  "fetch",
  "merge",
  "pull",
  "restore",
  "stash",
  "switch",
]);

const DANGEROUS_GIT_SUBCOMMANDS = new Set(["clean", "push", "reset"]);

const SECRET_PATH_PARTS = [
  `${path.sep}.ssh${path.sep}`,
  `${path.sep}.aws${path.sep}`,
  `${path.sep}.gnupg${path.sep}`,
  `${path.sep}.config${path.sep}gh${path.sep}`,
];

const READ_COMMANDS = new Set([
  "cat",
  "du",
  "file",
  "find",
  "grep",
  "head",
  "ls",
  "rg",
  "tail",
  "wc",
]);

const MUTATING_COMMANDS = new Set([
  "cp",
  "mkdir",
  "mv",
  "npm",
  "npx",
  "pnpm",
  "touch",
  "yarn",
]);

const OPAQUE_SHELL_RE =
  /(?:<<<?|<\(|>\(|\$\(|\$\{?[A-Za-z_]|`|\{\s|\}\s*;|\([^)]*\)|(?:^|\s)&(?:\s|$))/;
const ENV_ASSIGNMENT_RE = /^(?:[A-Za-z_][A-Za-z0-9_]*=.*\s+)+\S+/;

export class StaticCommandTierClassifier implements CommandTierClassifier {
  classify(subCommand: string, ctx: CommandTierContext): CommandTierResult {
    const opaque = detectOpaqueShellSyntax(subCommand);
    if (opaque) return dangerous(opaque);

    const tokens = tokenize(subCommand);
    if (tokens.length === 0) return safe("empty command");

    const commandToken = stripQuotes(tokens[0] ?? "");
    if (isOpaqueCommandToken(commandToken)) {
      return dangerous("opaque command position");
    }

    const command = path.basename(commandToken);
    const args = tokens.slice(1).map(stripQuotes);

    const redirection = classifyRedirection(tokens, ctx);
    if (redirection?.tier === "dangerous") return redirection;

    if (isVersionOnly(command, args)) {
      return safe("version check");
    }

    if (isDangerousInlineInterpreter(command, args)) {
      return dangerous(`inline interpreter execution (${command})`);
    }

    if (DANGEROUS_COMMANDS.has(command)) {
      return dangerous(`dangerous command (${command})`);
    }

    const readGuard = classifyReadPathGuard(command, args, ctx);
    if (readGuard?.tier === "dangerous") return readGuard;

    const mutationGuard = classifyMutationPathGuard(command, args, ctx);
    if (mutationGuard?.tier === "dangerous") return mutationGuard;

    if (command === "git") {
      return classifyGit(args);
    }

    if (command === "find" && args.includes("-delete")) {
      return dangerous("find -delete deletes files");
    }
    if (command === "find" && args.includes("-exec")) {
      return dangerous("find -exec executes commands");
    }

    if (command === "npm" || command === "pnpm" || command === "yarn") {
      return classifyPackageManager(command, args);
    }

    if (SENSITIVE_COMMANDS.has(command)) {
      return sensitive(`workspace-local command (${command})`);
    }

    if (SAFE_COMMANDS.has(command)) {
      return redirection ?? safe(`read-only command (${command})`);
    }

    return redirection ?? sensitive("unrecognized command");
  }
}

export function classifyCommand(
  command: string,
  ctx: CommandTierContext,
  classifier: CommandTierClassifier = new StaticCommandTierClassifier(),
): ClassifiedCommand {
  const subCommands = expandSubCommands(splitCompoundCommand(command));
  const perSubCommand = subCommands.map((subCommand) => ({
    command: subCommand,
    result: classifier.classify(subCommand, ctx),
  }));
  const tier = perSubCommand.reduce<CommandTier>(
    (max, entry) =>
      TIER_RANK[entry.result.tier] > TIER_RANK[max] ? entry.result.tier : max,
    "safe",
  );
  return { tier, perSubCommand };
}

export function isTierAtOrBelow(
  tier: CommandTier,
  threshold: "off" | "safe" | "sensitive",
): boolean {
  if (threshold === "off") return false;
  return TIER_RANK[tier] <= TIER_RANK[threshold];
}

function classifyGit(args: string[]): CommandTierResult {
  const subcommand = args.find((arg) => arg && !arg.startsWith("-"));
  if (!subcommand) return safe("git command inspection");

  if (DANGEROUS_GIT_SUBCOMMANDS.has(subcommand)) {
    if (subcommand === "reset" && !args.includes("--hard")) {
      return sensitive("git reset without --hard");
    }
    return dangerous(`dangerous git subcommand (${subcommand})`);
  }

  if (
    subcommand === "branch" &&
    args.some((a) => ["-d", "-D", "-m", "-M"].includes(a))
  ) {
    return sensitive("git branch mutation");
  }

  if (
    subcommand === "remote" &&
    args.some((a) => ["add", "remove", "rm", "set-url"].includes(a))
  ) {
    return sensitive("git remote mutation");
  }

  if (subcommand === "stash") {
    return args[args.indexOf("stash") + 1] === "list"
      ? safe("git stash list")
      : sensitive("git stash mutation");
  }

  if (SAFE_GIT_SUBCOMMANDS.has(subcommand)) return safe(`git ${subcommand}`);
  if (SENSITIVE_GIT_SUBCOMMANDS.has(subcommand)) {
    return sensitive(`git ${subcommand}`);
  }
  return sensitive("unrecognized git subcommand");
}

function classifyPackageManager(
  command: string,
  args: string[],
): CommandTierResult {
  const subcommand = args.find((arg) => arg && !arg.startsWith("-"));
  if (!subcommand) return sensitive(`${command} command`);

  if (["publish", "login", "logout", "token", "owner"].includes(subcommand)) {
    return dangerous(`${command} ${subcommand}`);
  }
  if (
    ["view", "info", "ls", "list", "audit", "outdated", "why"].includes(
      subcommand,
    )
  ) {
    return safe(`${command} ${subcommand}`);
  }
  return sensitive(`${command} ${subcommand}`);
}

function isVersionOnly(command: string, args: string[]): boolean {
  if (!SAFE_VERSION_COMMANDS.has(command)) return false;
  return (
    args.length > 0 &&
    args.every((arg) => ["-v", "--version", "version"].includes(arg))
  );
}

function isDangerousInlineInterpreter(
  command: string,
  args: string[],
): boolean {
  if (["sh", "bash", "zsh", "fish"].includes(command)) {
    return args.includes("-c");
  }
  if (["node", "ruby", "perl"].includes(command)) {
    return args.some((arg) => ["-e", "--eval"].includes(arg));
  }
  if (["python", "python3"].includes(command)) {
    return args.some((arg) => ["-c", "-m"].includes(arg));
  }
  if (command === "php") return args.includes("-r");
  return false;
}

function classifyRedirection(
  tokens: string[],
  ctx: CommandTierContext,
): CommandTierResult | null {
  if (
    !hasRedirection(tokens) &&
    !tokens.some((t) => stripQuotes(t) === "tee")
  ) {
    return null;
  }

  const target = findRedirectionTarget(tokens);
  if (target) {
    const resolved = resolvePathLike(target, ctx.cwd);
    if (!isInsideAnyRoot(resolved, ctx.workspaceRoots)) {
      return dangerous("redirection target outside workspace");
    }
  }
  return sensitive("output redirection");
}

function hasRedirection(tokens: string[]): boolean {
  return tokens.some((rawToken) => {
    if (isFullyQuoted(rawToken)) return false;
    const token = stripQuotes(rawToken);
    return /(?:\d?>\|?|\d?>>|&>)/.test(token);
  });
}

function findRedirectionTarget(tokens: string[]): string | undefined {
  for (let i = 0; i < tokens.length; i++) {
    const token = stripQuotes(tokens[i] ?? "");
    if (/^\d?>\|?$/.test(token) || /^\d?>>$/.test(token) || token === "&>") {
      return tokens[i + 1] ? stripQuotes(tokens[i + 1]) : undefined;
    }
    const attached = token.match(/^(?:.*?)(?:\d?>\|?|\d?>>|&>)(.+)$/);
    if (attached) return attached[1];
  }
  const teeIndex = tokens.map(stripQuotes).indexOf("tee");
  if (teeIndex >= 0) {
    return tokens
      .slice(teeIndex + 1)
      .map(stripQuotes)
      .find((arg) => arg && !arg.startsWith("-"));
  }
  return undefined;
}

function classifyReadPathGuard(
  command: string,
  args: string[],
  ctx: CommandTierContext,
): CommandTierResult | null {
  if (!READ_COMMANDS.has(command)) return null;
  for (const arg of args) {
    if (!arg || arg.startsWith("-")) continue;
    const resolved = resolvePathLike(arg, ctx.cwd);
    if (isSecretPath(resolved)) return dangerous("read targets secret path");
    if (!isInsideAnyRoot(resolved, ctx.workspaceRoots)) {
      return dangerous("read target outside workspace");
    }
  }
  return null;
}

function classifyMutationPathGuard(
  command: string,
  args: string[],
  ctx: CommandTierContext,
): CommandTierResult | null {
  if (!MUTATING_COMMANDS.has(command)) return null;
  if (!isInsideAnyRoot(path.resolve(ctx.cwd), ctx.workspaceRoots)) {
    return dangerous("mutating command cwd outside workspace");
  }
  for (const arg of args) {
    if (!arg || arg.startsWith("-")) continue;
    if (looksLikePackageSpecifier(arg)) continue;
    const resolved = resolvePathLike(arg, ctx.cwd);
    if (!isInsideAnyRoot(resolved, ctx.workspaceRoots)) {
      return dangerous("mutating command target outside workspace");
    }
  }
  return null;
}

function detectOpaqueShellSyntax(command: string): string | null {
  if (ENV_ASSIGNMENT_RE.test(command.trim()))
    return "environment assignment prefix";
  if (OPAQUE_SHELL_RE.test(command)) return "opaque shell syntax";
  return null;
}

function isOpaqueCommandToken(token: string): boolean {
  return (
    token.startsWith("$") ||
    token.includes('"') ||
    token.includes("'") ||
    token.includes("\\")
  );
}

function isSecretPath(absPath: string): boolean {
  const normalized = path.resolve(absPath);
  const home = os.homedir();
  if (
    normalized.endsWith(`${path.sep}.env`) ||
    path.basename(normalized).startsWith(".env")
  ) {
    return true;
  }
  if (normalized === path.join(home, ".ssh")) return true;
  return SECRET_PATH_PARTS.some((part) => normalized.includes(part));
}

function resolvePathLike(rawPath: string, cwd: string): string {
  const stripped = stripQuotes(rawPath.trim());
  if (stripped.startsWith("~"))
    return path.join(os.homedir(), stripped.slice(1));
  return path.resolve(cwd, stripped);
}

function isInsideAnyRoot(absPath: string, roots: string[]): boolean {
  const resolved = normalizeForCompare(path.resolve(absPath));
  return roots.some((root) => {
    const normalizedRoot = normalizeForCompare(path.resolve(root));
    return (
      resolved === normalizedRoot ||
      resolved.startsWith(normalizedRoot + path.sep)
    );
  });
}

function normalizeForCompare(value: string): string {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function looksLikePackageSpecifier(value: string): boolean {
  return (
    value.startsWith("@") ||
    /^[a-zA-Z0-9._-]+(?:@[\w.-]+)?$/.test(value) ||
    /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+(?:@[\w.-]+)?$/.test(value)
  );
}

function tokenize(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (ch === "\\" && i + 1 < command.length && !inSingle) {
      current += ch + command[i + 1];
      i++;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      current += ch;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      current += ch;
      continue;
    }
    if (/\s/.test(ch) && !inSingle && !inDouble) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (current) tokens.push(current);
  return tokens;
}

function isFullyQuoted(value: string): boolean {
  return (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  );
}

function stripQuotes(value: string): string {
  if (isFullyQuoted(value)) {
    return value.slice(1, -1);
  }
  return value;
}

function safe(reason: string): CommandTierResult {
  return { tier: "safe", reason };
}

function sensitive(reason: string): CommandTierResult {
  return { tier: "sensitive", reason };
}

function dangerous(reason: string): CommandTierResult {
  return { tier: "dangerous", reason };
}
