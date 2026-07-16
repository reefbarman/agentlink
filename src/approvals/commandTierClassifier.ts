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
  "md5",
  "md5sum",
  "shasum",
  "stat",
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

    if (commandToken !== command) {
      return sensitive(
        "path-qualified executable",
        "unrecognized_executable",
        command,
      );
    }

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

    if (command === "arch" && args.length > 0) {
      return sensitive(
        "arch command execution",
        "unrecognized_operation",
        command,
      );
    }
    if (
      command === "date" &&
      args.some((arg) => !arg.startsWith("+") && arg !== "-u")
    ) {
      return sensitive(
        "date may set system time",
        "unrecognized_operation",
        command,
      );
    }
    if (
      command === "rg" &&
      args.some(
        (arg) =>
          arg === "--pre" ||
          arg.startsWith("--pre=") ||
          arg.startsWith("--pre-glob="),
      )
    ) {
      return dangerous(
        "ripgrep preprocessor execution",
        "opaque_shell",
        command,
      );
    }

    if (command === "find" && args.includes("-delete")) {
      return dangerous("find -delete deletes files", "destructive", command);
    }
    const findAction = args.find((arg) =>
      [
        "-exec",
        "-execdir",
        "-ok",
        "-okdir",
        "-fprint",
        "-fprint0",
        "-fprintf",
        "-fls",
      ].includes(arg),
    );
    if (command === "find" && findAction) {
      return dangerous(
        `find ${findAction} executes or writes`,
        "opaque_shell",
        command,
      );
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

export function isCommandEligibleForReadOnlyExecution(
  command: string,
  ctx: CommandTierContext,
): { eligible: true } | { eligible: false; reason: string } {
  const classified = classifyCommand(command, ctx);
  if (
    classified.tier !== "safe" ||
    classified.perSubCommand.length === 0 ||
    classified.perSubCommand.some(({ result }) => result.tier !== "safe")
  ) {
    const blocked = classified.perSubCommand.find(
      ({ result }) => result.tier !== "safe",
    );
    return {
      eligible: false,
      reason: `${blocked?.command ?? command}: ${blocked?.result.reason ?? `classified as ${classified.tier}`}`,
    };
  }

  for (const entry of classified.perSubCommand) {
    const rawWords = scanShellLexWords(entry.command).words.map(
      ({ raw }) => raw,
    );
    const unsafeExpansion = rawWords
      .slice(1)
      .find(hasUnquotedShellPathExpansion);
    if (unsafeExpansion) {
      return {
        eligible: false,
        reason: `shell path expansion is not read-only-safe: ${unsafeExpansion}`,
      };
    }

    const words = rawWords.map(stripQuotes);
    const executable = path.basename(words[0] ?? "");
    const args = words.slice(1);
    const readOptionResult = validateReadOnlyCommandOptions(executable, args);
    if (readOptionResult) {
      return { eligible: false, reason: readOptionResult };
    }
    if (executable === "git") {
      const gitResult = validateReadOnlyGit(args);
      if (gitResult) return { eligible: false, reason: gitResult };
    }
    if (executable === "rg") {
      const rgResult = validateReadOnlyRipgrep(args);
      if (rgResult) return { eligible: false, reason: rgResult };
    }
  }
  return { eligible: true };
}

function validateReadOnlyCommandOptions(
  command: string,
  args: string[],
): string | undefined {
  const unsafeFlags: Partial<Record<string, RegExp>> = {
    du: /^(?:-H|-L|--dereference(?:-args)?|--exclude-from(?:=|$))/,
    file: /^(?:-L|--dereference|--magic-file(?:=|$)|-m(?:.+|$))/,
    find: /^(?:-H|-L|-follow|-files0-from(?:=|$))/,
    grep: /^(?:-R|--dereference-recursive|--exclude-from(?:=|$)|--file(?:=|$)|-f(?:.+|$))/,
    ls: /^(?:-H|-L|--dereference(?:-command-line-symlink-to-dir)?)/,
    md5sum: /^(?:-c|--check)$/,
    rg: /^(?:-L|--follow|--hostname-bin(?:=|$)|--ignore-file(?:=|$)|--file(?:=|$)|-f(?:.+|$))/,
    shasum: /^(?:-c|--check)$/,
  };
  const unsafeFlag = args.find((arg) => unsafeFlags[command]?.test(arg));
  return unsafeFlag
    ? `${command} option is not read-only-safe: ${unsafeFlag}`
    : undefined;
}

function hasUnquotedShellPathExpansion(raw: string): boolean {
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (const char of raw) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (char === "'" || char === '"') {
      if (quote === char) quote = null;
      else if (quote === null) quote = char;
      continue;
    }
    if (quote === null && ["*", "?", "[", "]", "{", "}"].includes(char)) {
      return true;
    }
  }
  return quote === null && raw.startsWith("~");
}

function validateReadOnlyGit(args: string[]): string | undefined {
  const subcommand = args.find((arg) => arg && !arg.startsWith("-"));
  if (!subcommand) return "git requires an explicit read-only subcommand";
  const unsafeFlag = args.find(
    (arg) =>
      arg === "-c" ||
      arg === "-C" ||
      arg === "--git-dir" ||
      arg.startsWith("--git-dir=") ||
      arg === "--work-tree" ||
      arg.startsWith("--work-tree=") ||
      arg === "--namespace" ||
      arg.startsWith("--namespace=") ||
      arg === "--config-env" ||
      arg.startsWith("--config-env=") ||
      arg === "--ext-diff" ||
      arg === "--textconv" ||
      arg === "--no-index" ||
      arg === "-O" ||
      /^-O.+/.test(arg) ||
      arg === "--open-files-in-pager" ||
      arg.startsWith("--open-files-in-pager=") ||
      arg === "--output" ||
      arg.startsWith("--output="),
  );
  if (unsafeFlag) return `git option is not read-only-safe: ${unsafeFlag}`;

  if (["diff", "show", "log", "blame", "grep"].includes(subcommand)) {
    if (!args.includes("--no-pager")) {
      return `git ${subcommand} requires --no-pager for read-only execution`;
    }
    if (
      ["diff", "show", "log", "blame"].includes(subcommand) &&
      (!args.includes("--no-ext-diff") || !args.includes("--no-textconv"))
    ) {
      return `git ${subcommand} requires --no-ext-diff and --no-textconv for read-only execution`;
    }
  }
  return undefined;
}

function validateReadOnlyRipgrep(args: string[]): string | undefined {
  if (!args.includes("--no-config")) {
    return "ripgrep requires --no-config for read-only execution";
  }
  const unsafeFlag = args.find(
    (arg) =>
      arg === "--pre" ||
      arg.startsWith("--pre=") ||
      arg.startsWith("--pre-glob="),
  );
  return unsafeFlag
    ? `ripgrep option is not read-only-safe: ${unsafeFlag}`
    : undefined;
}

export function isTierAtOrBelow(
  tier: CommandTier,
  threshold: "off" | "safe" | "sensitive",
): boolean {
  if (threshold === "off") return false;
  return TIER_RANK[tier] <= TIER_RANK[threshold];
}

function classifyGit(args: string[]): CommandTierResult {
  const unsafeGlobalFlag = args.find((arg) =>
    [
      "-C",
      "-c",
      "--git-dir",
      "--work-tree",
      "--namespace",
      "--config-env",
    ].some((flag) => arg === flag || arg.startsWith(`${flag}=`)),
  );
  if (unsafeGlobalFlag) {
    return sensitive(
      `git path or config override (${unsafeGlobalFlag})`,
      "external_path",
      "git",
    );
  }

  const subcommand = args.find((arg) => arg && !arg.startsWith("-"));
  if (!subcommand) return safe("git command inspection", "read_only", "git");
  const subcommandIndex = args.indexOf(subcommand);
  const subcommandArgs = args.slice(subcommandIndex + 1);
  const unsafeInspectionFlag = args.find(
    (arg) =>
      arg === "--ext-diff" ||
      arg === "--textconv" ||
      arg === "--no-index" ||
      arg === "-O" ||
      /^-O.+/.test(arg) ||
      arg === "--open-files-in-pager" ||
      arg.startsWith("--open-files-in-pager=") ||
      arg === "--output" ||
      arg.startsWith("--output="),
  );
  if (unsafeInspectionFlag) {
    return sensitive(
      `git executable or output option (${unsafeInspectionFlag})`,
      unsafeInspectionFlag.startsWith("--output")
        ? "workspace_redirection"
        : "unrecognized_operation",
      "git",
    );
  }

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

  if (subcommand === "branch") {
    const safeBranchFlags = new Set([
      "-a",
      "--all",
      "-r",
      "--remotes",
      "-v",
      "-vv",
      "--verbose",
      "--list",
      "--show-current",
      "--contains",
      "--no-contains",
      "--merged",
      "--no-merged",
      "--sort",
      "--format",
      "--column",
      "--no-column",
      "--color",
      "--no-color",
      "--ignore-case",
    ]);
    const hasMutationFlag = subcommandArgs.some((arg) =>
      [
        "-c",
        "-C",
        "-d",
        "-D",
        "-m",
        "-M",
        "--copy",
        "--move",
        "--delete",
      ].includes(arg),
    );
    const hasUnscopedPositional =
      !subcommandArgs.includes("--list") &&
      subcommandArgs.some(
        (arg) => !arg.startsWith("-") && !safeBranchFlags.has(arg),
      );
    if (hasMutationFlag || hasUnscopedPositional) {
      return sensitive("git branch mutation", "git_mutation", "git");
    }
  }

  if (subcommand === "remote") {
    const operation = subcommandArgs.find((arg) => !arg.startsWith("-"));
    if (operation) {
      return sensitive(
        `git remote operation (${operation})`,
        operation === "update"
          ? "network_or_external_effect"
          : "unrecognized_operation",
        "git",
      );
    }
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
  if (["view", "info", "audit", "outdated"].includes(subcommand)) {
    return sensitive(
      `${command} ${subcommand}`,
      "network_or_external_effect",
      command,
    );
  }
  if (["ls", "list", "why"].includes(subcommand)) {
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
    if (!isCommandPathInsideWorkspace(resolved, ctx.workspaceRoots)) {
      return dangerous(
        "redirection target outside workspace",
        "external_path",
        executable,
      );
    }
  }
  return sensitive("shell redirection", "workspace_redirection", executable);
}

function hasRedirection(tokens: string[]): boolean {
  return tokens.some((rawToken) => {
    if (isFullyQuoted(rawToken)) return false;
    const token = stripQuotes(rawToken);
    return /(?:\d?>\|?|\d?>>|&>|\d?<)/.test(token);
  });
}

function findRedirectionTarget(tokens: string[]): string | undefined {
  for (let i = 0; i < tokens.length; i++) {
    const token = stripQuotes(tokens[i] ?? "");
    if (
      /^\d?>\|?$/.test(token) ||
      /^\d?>>$/.test(token) ||
      token === "&>" ||
      /^\d?<$/.test(token)
    ) {
      return tokens[i + 1] ? stripQuotes(tokens[i + 1]) : undefined;
    }
    const attached = token.match(/^(?:.*?)(?:\d?>\|?|\d?>>|&>|\d?<)(.+)$/);
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
    if (!isCommandPathInsideWorkspace(resolved, ctx.workspaceRoots)) {
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
  if (
    !isCommandPathInsideWorkspace(path.resolve(ctx.cwd), ctx.workspaceRoots)
  ) {
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
    if (!isCommandPathInsideWorkspace(resolved, ctx.workspaceRoots)) {
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

export function isCommandPathInsideWorkspace(
  absPath: string,
  roots: string[],
): boolean {
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
