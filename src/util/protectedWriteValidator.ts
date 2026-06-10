import * as fs from "fs";
import * as path from "path";

import { isMemoryProtectedPath } from "../approvals/protectedPaths.js";

export interface ProtectedWriteValidationResult {
  message: string;
  protectedPath: string;
  command: string;
}

const WRITE_COMMANDS_WITH_DESTINATION = new Set(["cp", "mv", "install"]);
const IN_PLACE_COMMANDS = new Set(["sed", "perl"]);

function stripShellWrapper(tokens: string[]): string[] {
  if (
    tokens.length >= 3 &&
    (tokens[0] === "bash" || tokens[0] === "sh" || tokens[0] === "zsh")
  ) {
    const scriptFlagIndex = tokens.findIndex(
      (token) => token === "-c" || token === "--command",
    );
    if (scriptFlagIndex >= 0 && tokens[scriptFlagIndex + 1]) {
      return tokenize(tokens[scriptFlagIndex + 1]);
    }
  }
  return tokens;
}

function resolveCommandPath(rawPath: string, cwd: string): string | undefined {
  const stripped = stripQuotes(rawPath.trim());
  if (!stripped || stripped === "-" || stripped.startsWith("$"))
    return undefined;
  if (stripped.includes("*") || stripped.includes("?")) return undefined;
  if (stripped.includes("$(") || stripped.includes("`")) return undefined;
  if (stripped.startsWith("~")) {
    // Let the protected fallback still catch basename-only instruction files,
    // but avoid guessing home expansion in command text here.
    return stripped;
  }
  return path.isAbsolute(stripped) ? stripped : path.resolve(cwd, stripped);
}

function isProtectedTarget(rawPath: string, cwd: string): string | undefined {
  const resolved = resolveCommandPath(rawPath, cwd);
  if (!resolved) return undefined;
  return isMemoryProtectedPath(resolved, { cwd }) ? resolved : undefined;
}

function result(
  command: string,
  protectedPath: string,
): ProtectedWriteValidationResult {
  return {
    command,
    protectedPath,
    message: [
      `Command rejected: it appears to write to protected instructions or memory (${protectedPath}).`,
      ``,
      `Use propose_memory for durable memory/instruction changes, or write_file/apply_diff for an explicit user-reviewed diff.`,
      `force=true cannot bypass protected memory/instruction write detection.`,
    ].join("\n"),
  };
}

export function validateProtectedWriteCommand(
  command: string,
  cwd: string,
): ProtectedWriteValidationResult | null {
  for (const subCommand of splitOnCompoundOperators(command)) {
    for (const segment of splitOnUnquotedPipes(subCommand)) {
      const trimmed = segment.trim();
      if (!trimmed) continue;
      const tokens = stripShellWrapper(tokenize(trimmed));
      if (tokens.length === 0) continue;

      const redirectionTarget = findOutputRedirectionTarget(tokens);
      if (redirectionTarget) {
        const protectedPath = isProtectedTarget(redirectionTarget, cwd);
        if (protectedPath) return result(command, protectedPath);
      }

      const cmd = path.basename(tokens[0]);

      if (cmd === "tee") {
        for (const target of findTeeTargets(tokens.slice(1))) {
          const protectedPath = isProtectedTarget(target, cwd);
          if (protectedPath) return result(command, protectedPath);
        }
      }

      if (IN_PLACE_COMMANDS.has(cmd) && hasInPlaceFlag(tokens.slice(1))) {
        const target = findLastNonOption(tokens.slice(1));
        if (target) {
          const protectedPath = isProtectedTarget(target, cwd);
          if (protectedPath) return result(command, protectedPath);
        }
      }

      if (cmd === "dd") {
        const outputArg = tokens.find((token) => token.startsWith("of="));
        if (outputArg) {
          const protectedPath = isProtectedTarget(outputArg.slice(3), cwd);
          if (protectedPath) return result(command, protectedPath);
        }
      }

      if (WRITE_COMMANDS_WITH_DESTINATION.has(cmd)) {
        for (const target of findCopyMoveTargets(tokens.slice(1), cwd)) {
          const protectedPath = isProtectedTarget(target, cwd);
          if (protectedPath) return result(command, protectedPath);
        }
      }

      if (
        (cmd === "git" &&
          (tokens[1] === "checkout" || tokens[1] === "restore")) ||
        cmd === "restore"
      ) {
        for (const target of findGitRestoreTargets(
          tokens.slice(cmd === "git" ? 2 : 1),
        )) {
          const protectedPath = isProtectedTarget(target, cwd);
          if (protectedPath) return result(command, protectedPath);
        }
      }
    }
  }

  return null;
}

function findOutputRedirectionTarget(tokens: string[]): string | undefined {
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (
      token === ">" ||
      token === ">>" ||
      /^\d?>>$/.test(token) ||
      /^\d?>$/.test(token)
    ) {
      return tokens[i + 1];
    }
    const attached = token.match(/^(?:\d?)>>?(.+)$/);
    if (attached?.[1]) return attached[1];
  }
  return undefined;
}

function findTeeTargets(args: string[]): string[] {
  const targets: string[] = [];
  let stopOptions = false;
  for (const arg of args) {
    if (!stopOptions && arg === "--") {
      stopOptions = true;
      continue;
    }
    if (!stopOptions && arg.startsWith("-")) continue;
    if (arg !== "-") targets.push(arg);
  }
  return targets;
}

function hasInPlaceFlag(args: string[]): boolean {
  return args.some(
    (arg) =>
      arg === "-i" ||
      arg === "--in-place" ||
      arg.startsWith("-i") ||
      (/^-[a-hj-zA-Z]*i/.test(arg) && !arg.startsWith("--")),
  );
}

function findLastNonOption(args: string[]): string | undefined {
  for (let i = args.length - 1; i >= 0; i--) {
    const arg = args[i];
    if (!arg || arg === "--") continue;
    if (arg.startsWith("-")) continue;
    return arg;
  }
  return undefined;
}

function findCopyMoveTargets(args: string[], cwd: string): string[] {
  const operands: string[] = [];
  let stopOptions = false;
  let targetDirectory: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!stopOptions && arg === "--") {
      stopOptions = true;
      continue;
    }

    if (!stopOptions && arg.startsWith("--target-directory=")) {
      targetDirectory = arg.slice("--target-directory=".length);
      continue;
    }

    if (!stopOptions && arg.startsWith("-t") && arg !== "-t") {
      targetDirectory = arg.slice(2);
      continue;
    }

    if (!stopOptions && arg.startsWith("-")) {
      if (["-t", "--target-directory"].includes(arg)) {
        targetDirectory = args[i + 1];
        i++;
      } else if (optionConsumesNextArg(arg)) {
        i++;
      }
      continue;
    }

    operands.push(arg);
  }

  if (targetDirectory) {
    return expandDirectoryDestination(targetDirectory, operands, cwd);
  }

  const destination = operands[operands.length - 1];
  if (!destination) return [];
  const sources = operands.slice(0, -1);
  return [
    destination,
    ...expandDirectoryDestination(destination, sources, cwd),
  ];
}

function optionConsumesNextArg(arg: string): boolean {
  return [
    "-b",
    "--backup",
    "-g",
    "--group",
    "-m",
    "--mode",
    "-o",
    "--owner",
    "-S",
    "--suffix",
  ].includes(arg);
}

function expandDirectoryDestination(
  destination: string,
  sources: string[],
  cwd: string,
): string[] {
  if (!isDirectoryLikeDestination(destination, cwd)) return [];

  return sources
    .map((source) => stripQuotes(source.trim()))
    .filter((source) => source && !source.startsWith("$"))
    .filter((source) => !source.includes("$(") && !source.includes("`"))
    .map((source) => path.join(destination, path.basename(source)));
}

function isDirectoryLikeDestination(rawPath: string, cwd: string): boolean {
  const stripped = stripQuotes(rawPath.trim());
  if (!stripped || stripped.startsWith("$")) return false;
  if (stripped.endsWith("/") || stripped.endsWith("\\")) return true;
  if (stripped === "." || stripped === "..") return true;
  if ([".agentlink", ".agents", ".claude"].includes(path.basename(stripped))) {
    return true;
  }

  const resolved = resolveCommandPath(stripped, cwd);
  if (!resolved || resolved.startsWith("~")) return false;

  try {
    return fs.statSync(resolved).isDirectory();
  } catch {
    return false;
  }
}

function findGitRestoreTargets(args: string[]): string[] {
  const targets: string[] = [];
  let stopOptions = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!stopOptions && arg === "--") {
      stopOptions = true;
      continue;
    }
    if (!stopOptions && arg.startsWith("-")) {
      if (["--source", "-s"].includes(arg)) i++;
      continue;
    }
    targets.push(arg);
  }
  return targets;
}

function splitOnCompoundOperators(command: string): string[] {
  const result: string[] = [];
  let current = "";
  let quote: string | null = null;
  let escaped = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    const next = command[i + 1];

    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      current += ch;
      escaped = true;
      continue;
    }
    if ((ch === '"' || ch === "'") && !quote) {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === quote) {
      quote = null;
      current += ch;
      continue;
    }
    if (
      !quote &&
      (ch === ";" ||
        (ch === "&" && next === "&") ||
        (ch === "|" && next === "|"))
    ) {
      if (current.trim()) result.push(current.trim());
      current = "";
      if (ch !== ";") i++;
      continue;
    }
    current += ch;
  }
  if (current.trim()) result.push(current.trim());
  return result;
}

function splitOnUnquotedPipes(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: string | null = null;
  let escaped = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      current += ch;
      escaped = true;
      continue;
    }
    if ((ch === '"' || ch === "'") && !quote) {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === quote) {
      quote = null;
      current += ch;
      continue;
    }
    if (!quote && ch === "|") {
      segments.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  segments.push(current);
  return segments;
}

function tokenize(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: string | null = null;
  let escaped = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if ((ch === '"' || ch === "'") && !quote) {
      quote = ch;
      continue;
    }
    if (ch === quote) {
      quote = null;
      continue;
    }
    if (!quote && /\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    if (!quote && (ch === ">" || ch === "<")) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      if (ch === ">" && command[i + 1] === ">") {
        tokens.push(">>");
        i++;
      } else {
        tokens.push(ch);
      }
      continue;
    }
    current += ch;
  }
  if (current) tokens.push(current);
  return tokens;
}

function stripQuotes(value: string): string {
  if (
    (value.startsWith("'") && value.endsWith("'")) ||
    (value.startsWith('"') && value.endsWith('"'))
  ) {
    return value.slice(1, -1);
  }
  return value;
}
