import { scanShellLexBoundaries, scanShellLexWords } from "./shellLex.js";

export type PredictableGitMetadataWriterSubcommand =
  | "add"
  | "commit"
  | "rm"
  | "mv"
  | "branch"
  | "stash"
  | "restore"
  | "checkout"
  | "switch"
  | "merge"
  | "reset";

export interface GitMetadataWriterClassificationInput {
  readonly command: string;
  readonly hasEnvironmentOverrides: boolean;
  readonly hasInlineFiles: boolean;
}

export interface PredictableGitMetadataWriterClassification {
  readonly kind: "predictable_git_metadata_writer";
  readonly subcommand: PredictableGitMetadataWriterSubcommand;
}

const SUBCOMMANDS = new Set<PredictableGitMetadataWriterSubcommand>([
  "add",
  "commit",
  "rm",
  "mv",
  "branch",
  "stash",
  "restore",
  "checkout",
  "switch",
  "merge",
  "reset",
]);

interface ParsedArguments {
  options: Map<string, string[]>;
  operands: string[];
  separatorIndex: number | undefined;
}

function hasUnsupportedShellSyntax(command: string): boolean {
  let quote: "single" | "double" | null = null;
  let escaped = false;
  for (let index = 0; index < command.length; index++) {
    const character = command[index];
    if (escaped) {
      if (character === "\n" || character === "\r") return true;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "single") {
      escaped = true;
      continue;
    }
    if (character === "'" && quote !== "double") {
      quote = quote === "single" ? null : "single";
      continue;
    }
    if (character === '"' && quote !== "single") {
      quote = quote === "double" ? null : "double";
      continue;
    }
    if (quote === "single") continue;
    if (character === "$" || character === "`" || character === "\0")
      return true;
    if (quote === "double") {
      if (character === "!") return true;
      continue;
    }
    if (
      character === "&" ||
      character === "|" ||
      character === ";" ||
      character === "<" ||
      character === ">" ||
      character === "(" ||
      character === ")" ||
      character === "*" ||
      character === "?" ||
      character === "[" ||
      character === "{" ||
      character === "\n" ||
      character === "\r" ||
      (character.charCodeAt(0) < 0x20 && character !== "\t")
    ) {
      return true;
    }
  }
  return escaped || quote !== null;
}

function decodeWord(raw: string): string | null {
  let decoded = "";
  let quote: "single" | "double" | null = null;
  for (let index = 0; index < raw.length; index++) {
    const character = raw[index];
    if (character === "\\" && quote !== "single") {
      const next = raw[++index];
      if (next === undefined || next === "\n" || next === "\r") return null;
      decoded += next;
      continue;
    }
    if (character === "'" && quote !== "double") {
      quote = quote === "single" ? null : "single";
      continue;
    }
    if (character === '"' && quote !== "single") {
      quote = quote === "double" ? null : "double";
      continue;
    }
    if (quote !== "single" && (character === "$" || character === "`")) {
      return null;
    }
    decoded += character;
  }
  return quote === null ? decoded : null;
}

function parseArguments(
  args: readonly string[],
  booleanOptions: ReadonlySet<string>,
  valueOptions: ReadonlySet<string>,
): ParsedArguments | null {
  const options = new Map<string, string[]>();
  const operands: string[] = [];
  let separatorIndex: number | undefined;
  let operandsStarted = false;

  const record = (name: string, value = ""): void => {
    const values = options.get(name) ?? [];
    values.push(value);
    options.set(name, values);
  };

  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === "--") {
      if (separatorIndex !== undefined) return null;
      separatorIndex = operands.length;
      operandsStarted = true;
      continue;
    }
    if (
      argument.startsWith("-") &&
      argument !== "-" &&
      separatorIndex === undefined
    ) {
      if (operandsStarted) return null;
      const equals = argument.indexOf("=");
      const name = equals < 0 ? argument : argument.slice(0, equals);
      if (booleanOptions.has(name)) {
        if (equals >= 0) return null;
        record(name);
        continue;
      }
      if (!valueOptions.has(name)) return null;
      const value = equals >= 0 ? argument.slice(equals + 1) : args[++index];
      if (!value) return null;
      record(name, value);
      continue;
    }
    operandsStarted = true;
    operands.push(argument);
  }
  return { options, operands, separatorIndex };
}

function hasAny(
  options: Map<string, string[]>,
  names: readonly string[],
): boolean {
  return names.some((name) => options.has(name));
}

function classifyAdd(args: readonly string[]): boolean {
  const parsed = parseArguments(
    args,
    new Set([
      "-A",
      "--all",
      "-u",
      "--update",
      "--renormalize",
      "-N",
      "--intent-to-add",
      "--sparse",
      "-f",
      "--force",
    ]),
    new Set(),
  );
  return Boolean(
    parsed &&
    (parsed.operands.length > 0 ||
      hasAny(parsed.options, [
        "-A",
        "--all",
        "-u",
        "--update",
        "--renormalize",
      ])),
  );
}

function classifyCommit(args: readonly string[]): boolean {
  const parsed = parseArguments(
    args,
    new Set([
      "-a",
      "--all",
      "--amend",
      "--no-edit",
      "--allow-empty",
      "--no-verify",
      "-s",
      "--signoff",
      "--no-gpg-sign",
      "-q",
      "--quiet",
    ]),
    new Set(["-m", "--message", "--author", "--date", "--cleanup"]),
  );
  if (!parsed) return false;
  if (parsed.operands.length > 0 && parsed.separatorIndex === undefined)
    return false;
  const hasMessage = hasAny(parsed.options, ["-m", "--message"]);
  return (
    hasMessage ||
    (parsed.options.has("--amend") && parsed.options.has("--no-edit"))
  );
}

function classifyRm(args: readonly string[]): boolean {
  const parsed = parseArguments(
    args,
    new Set([
      "-r",
      "--cached",
      "--ignore-unmatch",
      "--sparse",
      "-q",
      "--quiet",
    ]),
    new Set(),
  );
  return Boolean(parsed && parsed.operands.length > 0);
}

function classifyMv(args: readonly string[]): boolean {
  const parsed = parseArguments(args, new Set(["-k", "-n", "-v"]), new Set());
  return Boolean(parsed && parsed.operands.length >= 2);
}

function classifyBranch(args: readonly string[]): boolean {
  if (args.length === 0) return false;
  const operation = args[0];
  const operands = args.slice(1);
  const hasOnlyOperands = operands.every(
    (operand) => operand !== "--" && !operand.startsWith("-"),
  );
  if (["-d", "--delete"].includes(operation)) {
    return operands.length >= 1 && hasOnlyOperands;
  }
  if (["-m", "--move", "-c", "--copy"].includes(operation)) {
    return (operands.length === 1 || operands.length === 2) && hasOnlyOperands;
  }
  if (operation === "--unset-upstream")
    return operands.length <= 1 && hasOnlyOperands;
  if (operation === "--set-upstream-to") {
    return (operands.length === 1 || operands.length === 2) && hasOnlyOperands;
  }
  if (operation.startsWith("--set-upstream-to=")) {
    return (
      operation.length > "--set-upstream-to=".length &&
      operands.length <= 1 &&
      hasOnlyOperands
    );
  }
  const parsed = parseArguments(
    args,
    new Set(["--track", "--no-track"]),
    new Set(),
  );
  return Boolean(
    parsed && parsed.operands.length >= 1 && parsed.operands.length <= 2,
  );
}

function classifyStash(args: readonly string[]): boolean {
  if (args.length === 0) return true;
  const operation = args[0];
  const rest = args.slice(1);
  if (operation === "push") {
    const parsed = parseArguments(
      rest,
      new Set([
        "-k",
        "--keep-index",
        "-S",
        "--staged",
        "-u",
        "--include-untracked",
        "-a",
        "--all",
        "-q",
        "--quiet",
      ]),
      new Set(["-m", "--message"]),
    );
    return Boolean(
      parsed &&
      (parsed.operands.length === 0 || parsed.separatorIndex !== undefined),
    );
  }
  if (operation === "pop" || operation === "apply") {
    const parsed = parseArguments(
      rest,
      new Set(["--index", "-q", "--quiet"]),
      new Set(),
    );
    return Boolean(parsed && parsed.operands.length <= 1);
  }
  if (operation === "drop") {
    const parsed = parseArguments(rest, new Set(["-q", "--quiet"]), new Set());
    return Boolean(parsed && parsed.operands.length <= 1);
  }
  if (operation === "branch") return rest.length === 1 || rest.length === 2;
  if (operation === "store") {
    const parsed = parseArguments(
      rest,
      new Set(["-q", "--quiet"]),
      new Set(["-m", "--message"]),
    );
    return Boolean(parsed && parsed.operands.length === 1);
  }
  return false;
}

function classifyRestore(args: readonly string[]): boolean {
  const parsed = parseArguments(
    args,
    new Set([
      "-S",
      "--staged",
      "-W",
      "--worktree",
      "--ours",
      "--theirs",
      "--overlay",
      "--no-overlay",
    ]),
    new Set(["-s", "--source"]),
  );
  return Boolean(
    parsed && parsed.separatorIndex === 0 && parsed.operands.length > 0,
  );
}

function classifyCheckout(args: readonly string[]): boolean {
  if (args.length === 0) return false;
  if (args[0] === "-b") return args.length === 2 || args.length === 3;
  if (args[0] === "--detach") return args.length === 2;
  if (args[0] === "--ours" || args[0] === "--theirs") {
    return args[1] === "--" && args.length > 2;
  }
  const separator = args.indexOf("--");
  if (separator >= 0) {
    return (
      (separator === 0 ||
        (separator === 1 && !args[0].startsWith("-") && args[0] !== "-")) &&
      args.length > separator + 1
    );
  }
  if (args[0] === "--no-guess") return args.length === 2;
  return args.length === 1 && !args[0].startsWith("-");
}

function classifySwitch(args: readonly string[]): boolean {
  if (args.length === 0) return false;
  if (["-c", "--create"].includes(args[0]))
    return args.length === 2 || args.length === 3;
  if (args[0] === "--detach") return args.length === 2;
  if (args[0] === "--no-guess") return args.length === 2;
  return args.length === 1 && !args[0].startsWith("-");
}

function classifyMerge(args: readonly string[]): boolean {
  if (args.length === 1 && ["--abort", "--quit"].includes(args[0])) return true;
  const parsed = parseArguments(
    args,
    new Set([
      "--no-edit",
      "--ff",
      "--no-ff",
      "--ff-only",
      "--squash",
      "--no-squash",
      "--commit",
      "--no-commit",
      "--stat",
      "--no-stat",
      "--no-log",
      "--no-verify",
      "-q",
      "--quiet",
      "-v",
      "--verbose",
    ]),
    new Set(),
  );
  return Boolean(
    parsed && parsed.options.has("--no-edit") && parsed.operands.length > 0,
  );
}

function classifyReset(args: readonly string[]): boolean {
  if (args.length === 2 && ["--soft", "--mixed"].includes(args[0])) return true;
  const separator = args.indexOf("--");
  return (
    (separator === 0 ||
      (separator === 1 && !args[0].startsWith("-") && args[0] !== "-")) &&
    args.length > separator + 1
  );
}

const CLASSIFIERS: Record<
  PredictableGitMetadataWriterSubcommand,
  (args: readonly string[]) => boolean
> = {
  add: classifyAdd,
  commit: classifyCommit,
  rm: classifyRm,
  mv: classifyMv,
  branch: classifyBranch,
  stash: classifyStash,
  restore: classifyRestore,
  checkout: classifyCheckout,
  switch: classifySwitch,
  merge: classifyMerge,
  reset: classifyReset,
};

/**
 * Recognizes a deliberately narrow set of direct local Git metadata writers.
 * A match enables guidance only; it never grants or selects execution authority.
 * `null` means unrecognized or ineligible, not safe.
 */
export function classifyPredictableGitMetadataWriter(
  input: GitMetadataWriterClassificationInput,
): PredictableGitMetadataWriterClassification | null {
  const { command } = input;
  if (
    input.hasEnvironmentOverrides ||
    input.hasInlineFiles ||
    !command.trim() ||
    hasUnsupportedShellSyntax(command)
  ) {
    return null;
  }
  const boundaries = scanShellLexBoundaries(command);
  if (
    boundaries.boundaries.length > 0 ||
    boundaries.finalState.quote !== null ||
    boundaries.finalState.danglingEscape
  ) {
    return null;
  }
  const wordScan = scanShellLexWords(command);
  if (
    wordScan.finalState.quote !== null ||
    wordScan.finalState.danglingEscape ||
    wordScan.words.length < 2 ||
    wordScan.words[0].raw !== "git" ||
    wordScan.words[1].raw !== wordScan.words[1].raw.toLowerCase()
  ) {
    return null;
  }
  const subcommand = wordScan.words[1]
    .raw as PredictableGitMetadataWriterSubcommand;
  if (!SUBCOMMANDS.has(subcommand)) return null;
  const args = wordScan.words.slice(2).map(({ raw }) => decodeWord(raw));
  if (args.some((argument) => argument === null)) return null;
  return CLASSIFIERS[subcommand](args as string[])
    ? { kind: "predictable_git_metadata_writer", subcommand }
    : null;
}
