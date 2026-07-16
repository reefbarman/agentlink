import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { expandSubCommands, splitCompoundCommand } from "./commandSplitter.js";

import { scanShellLexWords } from "../util/shellLex.js";

export type CommandTier = "safe" | "sensitive" | "dangerous";

export type CommandRiskCode =
  | "read_only"
  | "version_check"
  | "workspace_mutation"
  | "project_toolchain"
  | "git_mutation"
  | "workspace_redirection"
  | "unrecognized_executable"
  | "unrecognized_operation"
  | "external_path"
  | "secret_path"
  | "network_or_external_effect"
  | "destructive"
  | "privileged"
  | "opaque_shell"
  | "inline_interpreter"
  | "other_dangerous";

export interface CommandTierResult {
  tier: CommandTier;
  code: CommandRiskCode;
  reason: string;
  executable?: string;
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
  "strings",
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

const WORKSPACE_MUTATION_COMMANDS = new Set(["cp", "mkdir", "mv", "touch"]);

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
  "strings",
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
    if (opaque) return dangerous(opaque, "opaque_shell");

    const tokens = scanShellLexWords(subCommand).words.map(({ raw }) => raw);
    if (tokens.length === 0) return safe("empty command", "read_only");

    const commandToken = stripQuotes(tokens[0] ?? "");
    if (isOpaqueCommandToken(commandToken)) {
      return dangerous("opaque command position", "opaque_shell");
    }

    const command = path.basename(commandToken);
    const args = tokens.slice(1).map(stripQuotes);

    const redirection = classifyRedirection(tokens, ctx, command);
    if (redirection?.tier === "dangerous") return redirection;

    if (isVersionOnly(command, args)) {
      return safe("version check", "version_check", command);
    }

    if (isDangerousInlineInterpreter(command, args)) {
      return dangerous(
        `inline interpreter execution (${command})`,
        "inline_interpreter",
        command,
      );
    }

    if (DANGEROUS_COMMANDS.has(command)) {
      return dangerous(
        `dangerous command (${command})`,
        dangerousCommandCode(command),
        command,
      );
    }

    const readGuard = classifyReadPathGuard(command, args, ctx);
    if (readGuard?.tier === "dangerous") return readGuard;

    const mutationGuard = classifyMutationPathGuard(command, args, ctx);
    if (mutationGuard?.tier === "dangerous") return mutationGuard;

    if (command === "git") {
      return classifyGit(args);
    }

    if (command === "find" && args.includes("-delete")) {
      return dangerous("find -delete deletes files", "destructive", command);
    }
    if (command === "find" && args.includes("-exec")) {
      return dangerous("find -exec executes commands", "opaque_shell", command);
    }

    if (command === "npm" || command === "pnpm" || command === "yarn") {
      return classifyPackageManager(command, args);
    }

    if (SENSITIVE_COMMANDS.has(command)) {
      const code = WORKSPACE_MUTATION_COMMANDS.has(command)
        ? "workspace_mutation"
        : classifySensitiveCommandCode(command, args);
      return sensitive(`workspace-local command (${command})`, code, command);
    }

    if (SAFE_COMMANDS.has(command)) {
      return (
        redirection ??
        safe(`read-only command (${command})`, "read_only", command)
      );
    }

    return (
      redirection ??
      sensitive("unrecognized command", "unrecognized_executable", command)
    );
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
  if (!subcommand) return safe("git command inspection", "read_only", "git");

  if (DANGEROUS_GIT_SUBCOMMANDS.has(subcommand)) {
    if (subcommand === "reset" && !args.includes("--hard")) {
      return sensitive(
        "git reset without --hard",
        "unrecognized_operation",
        "git",
      );
    }
    return dangerous(
      `dangerous git subcommand (${subcommand})`,
      subcommand === "push" ? "network_or_external_effect" : "destructive",
      "git",
    );
  }

  if (
    subcommand === "branch" &&
    args.some((a) => ["-d", "-D", "-m", "-M"].includes(a))
  ) {
    return sensitive("git branch mutation", "unrecognized_operation", "git");
  }

  if (
    subcommand === "remote" &&
    args.some((a) => ["add", "remove", "rm", "set-url"].includes(a))
  ) {
    return sensitive(
      "git remote mutation",
      "network_or_external_effect",
      "git",
    );
  }

  if (subcommand === "stash") {
    return args[args.indexOf("stash") + 1] === "list"
      ? safe("git stash list", "read_only", "git")
      : sensitive("git stash mutation", "unrecognized_operation", "git");
  }

  if (SAFE_GIT_SUBCOMMANDS.has(subcommand)) {
    return safe(`git ${subcommand}`, "read_only", "git");
  }
  if (SENSITIVE_GIT_SUBCOMMANDS.has(subcommand)) {
    const code = ["fetch", "pull"].includes(subcommand)
      ? "network_or_external_effect"
      : ["add", "commit"].includes(subcommand)
        ? "git_mutation"
        : "unrecognized_operation";
    return sensitive(`git ${subcommand}`, code, "git");
  }
  return sensitive(
    "unrecognized git subcommand",
    "unrecognized_operation",
    "git",
  );
}

function classifyPackageManager(
  command: string,
  args: string[],
): CommandTierResult {
  const subcommand = args.find((arg) => arg && !arg.startsWith("-"));
  if (!subcommand) {
    return sensitive(`${command} command`, "project_toolchain", command);
  }

  if (["publish", "login", "logout", "token", "owner"].includes(subcommand)) {
    return dangerous(
      `${command} ${subcommand}`,
      "network_or_external_effect",
      command,
    );
  }
  if (
    ["view", "info", "ls", "list", "audit", "outdated", "why"].includes(
      subcommand,
    )
  ) {
    return safe(`${command} ${subcommand}`, "read_only", command);
  }
  const subcommandIndex = args.indexOf(subcommand);
  const operation =
    subcommand === "run" ? args[subcommandIndex + 1] : subcommand;
  return sensitive(
    `${command} ${subcommand}`,
    classifyProjectOperation(operation),
    command,
  );
}

function classifySensitiveCommandCode(
  command: string,
  args: string[],
): CommandRiskCode {
  const operation = args.find((arg) => arg && !arg.startsWith("-"));
  if (command === "npx") return "unrecognized_operation";
  if (command === "bun" && operation === "publish") {
    return "network_or_external_effect";
  }
  if (
    command === "cargo" &&
    ["publish", "install", "login"].includes(operation ?? "")
  ) {
    return "network_or_external_effect";
  }
  if (command === "go" && ["get", "install"].includes(operation ?? "")) {
    return "network_or_external_effect";
  }
  return classifyProjectOperation(operation);
}

function classifyProjectOperation(
  operation: string | undefined,
): CommandRiskCode {
  if (!operation) return "unrecognized_operation";
  if (/^(?:deploy|publish|release)(?::|$)/i.test(operation)) {
    return "network_or_external_effect";
  }
  return /^(?:build|check|clippy|compile|fmt|format|lint|test|typecheck|verify)(?::|$)/i.test(
    operation,
  )
    ? "project_toolchain"
    : "unrecognized_operation";
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
  executable: string,
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
      return dangerous(
        "redirection target outside workspace",
        "external_path",
        executable,
      );
    }
  }
  return sensitive("output redirection", "workspace_redirection", executable);
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
    if (isSecretPath(resolved)) {
      return dangerous("read targets secret path", "secret_path", command);
    }
    if (!isInsideAnyRoot(resolved, ctx.workspaceRoots)) {
      return dangerous(
        "read target outside workspace",
        "external_path",
        command,
      );
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
    return dangerous(
      "mutating command cwd outside workspace",
      "external_path",
      command,
    );
  }
  for (const arg of args) {
    if (!arg || arg.startsWith("-")) continue;
    if (
      (command === "npm" ||
        command === "npx" ||
        command === "pnpm" ||
        command === "yarn") &&
      looksLikePackageSpecifier(arg)
    ) {
      continue;
    }
    const resolved = resolvePathLike(arg, ctx.cwd);
    if (!isInsideAnyRoot(resolved, ctx.workspaceRoots)) {
      return dangerous(
        "mutating command target outside workspace",
        "external_path",
        command,
      );
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
  const resolved = normalizeForCompare(resolvePhysicalPath(absPath));
  return roots.some((root) => {
    const normalizedRoot = normalizeForCompare(resolvePhysicalPath(root));
    return (
      resolved === normalizedRoot ||
      resolved.startsWith(normalizedRoot + path.sep)
    );
  });
}

function resolvePhysicalPath(value: string): string {
  const resolved = path.resolve(value);
  let existing = resolved;
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) return resolved;
    existing = parent;
  }
  try {
    return path.join(
      fs.realpathSync(existing),
      path.relative(existing, resolved),
    );
  } catch {
    return resolved;
  }
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

function dangerousCommandCode(command: string): CommandRiskCode {
  if (["sudo", "doas", "chmod", "chown"].includes(command)) {
    return "privileged";
  }
  if (["curl", "nc", "netcat", "scp", "ssh", "wget"].includes(command)) {
    return "network_or_external_effect";
  }
  if (["dd", "diskutil", "mkfs", "rm", "rmdir"].includes(command)) {
    return "destructive";
  }
  return "other_dangerous";
}

function safe(
  reason: string,
  code: CommandRiskCode,
  executable?: string,
): CommandTierResult {
  return { tier: "safe", code, reason, executable };
}

function sensitive(
  reason: string,
  code: CommandRiskCode,
  executable?: string,
): CommandTierResult {
  return { tier: "sensitive", code, reason, executable };
}

function dangerous(
  reason: string,
  code: CommandRiskCode,
  executable?: string,
): CommandTierResult {
  return { tier: "dangerous", code, reason, executable };
}
