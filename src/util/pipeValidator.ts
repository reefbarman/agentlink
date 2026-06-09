/**
 * Validate commands before execution. Rejects:
 * 1. Direct file-reading commands (head/tail/cat/grep on files) — use read_file/search_files
 * 2. Piped filtering (cmd | head/tail/grep) — use output_head/output_tail/output_grep params
 *
 * Returns null if the command is clean, or a rejection object with
 * a helpful message suggesting the correct tool or parameters.
 */

interface PipeViolation {
  /** The piped command name (head, tail, grep) */
  command: string;
  /** The full piped segment (e.g. "head -5", "grep -i error") */
  segment: string;
  /** Suggested tool parameters */
  suggestions: Record<string, string | number>;
}

interface ValidationResult {
  message: string;
  /** 'direct' = standalone head/tail/cat/grep/sed; 'pipe' = piped filtering */
  type: "direct" | "pipe";
  /** For pipe violations: the command with piped filtering segments stripped */
  strippedCommand?: string;
}

/**
 * Validate a command for disallowed patterns.
 * Returns null if the command is clean, or a result with a rejection message.
 */
export function validateCommand(command: string): ValidationResult | null {
  // Check 1: Direct file-reading commands (head/tail/cat/grep used standalone)
  const directViolation = checkDirectFileCommands(command);
  if (directViolation) return directViolation;

  // Check 2: Inline scripting used to write files outside write_file/apply_diff
  const inlineScriptWriteViolation = checkInlineScriptFileWriters(command);
  if (inlineScriptWriteViolation) return inlineScriptWriteViolation;

  // Check 3: Piped filtering (cmd | head/tail/grep)
  return detectPipedFiltering(command);
}

// Commands that should use read_file or search_files instead
const DIRECT_FILE_COMMANDS = new Map<
  string,
  { tool: string; description: string; reason: string }
>([
  [
    "head",
    {
      tool: "read_file",
      description: "read the beginning of files",
      reason:
        "read_file provides line numbers, file metadata, git status, and diagnostics",
    },
  ],
  [
    "tail",
    {
      tool: "read_file",
      description: "read the end of files",
      reason:
        "read_file provides line numbers, file metadata, git status, and diagnostics",
    },
  ],
  [
    "cat",
    {
      tool: "read_file",
      description: "read files",
      reason:
        "read_file provides line numbers, file metadata, git status, and diagnostics",
    },
  ],
  [
    "grep",
    {
      tool: "search_files",
      description: "search file contents",
      reason:
        "search_files uses ripgrep with context lines, supports regex, and returns structured results",
    },
  ],
  [
    "sed",
    {
      tool: "apply_diff",
      description: "edit files",
      reason:
        "apply_diff opens a diff view for user review, and find_and_replace supports bulk regex substitution",
    },
  ],
]);

const PDF_READING_COMMANDS = new Set([
  "pdftotext",
  "pdfinfo",
  "mutool",
  "qpdf",
]);

/**
 * Check if any sub-command in a compound command starts with head/tail/cat/grep.
 * Splits on && ; || but NOT on | (pipe case is handled separately).
 */
function checkDirectFileCommands(command: string): ValidationResult | null {
  const subCommands = splitOnCompoundOperators(command);

  for (const sub of subCommands) {
    const trimmed = sub.trim();
    if (!trimmed) continue;

    const pipeSegments = splitOnUnquotedPipes(trimmed);
    for (const rawSegment of pipeSegments) {
      const segment = rawSegment.trim();
      const segmentTokens = tokenize(segment);
      if (segmentTokens.length === 0) continue;

      const segmentCmd = segmentTokens[0];

      const pdfReadViolation = checkPdfReadingCommand(
        segmentCmd,
        segmentTokens,
      );
      if (pdfReadViolation) return pdfReadViolation;

      if (segmentCmd === "tee") {
        const teeFiles = findTeeFileTargets(segmentTokens.slice(1));
        if (teeFiles.length > 0) {
          return {
            type: "direct",
            message: [
              `Command rejected: "tee" with file targets should not be run in the terminal — it bypasses user review.`,
              `\nUse the write_file or apply_diff tool instead — they open a diff view for the user to review and approve changes, and return diagnostics from the language server.`,
            ].join("\n"),
          };
        }
      }

      if (
        (segmentCmd === "echo" || segmentCmd === "printf") &&
        hasOutputRedirection(segment)
      ) {
        return {
          type: "direct",
          message: [
            `Command rejected: "${segmentCmd}" with output redirection should not be run in the terminal — it bypasses user review.`,
            `\nUse the write_file or apply_diff tool instead — they open a diff view for the user to review and approve changes, and return diagnostics from the language server.`,
          ].join("\n"),
        };
      }
    }

    const tokens = tokenize(trimmed);
    if (tokens.length === 0) continue;

    const cmd = tokens[0];
    const info = DIRECT_FILE_COMMANDS.get(cmd);
    if (!info) continue;

    // Allow commands whose arguments contain shell expansion ($(), backticks,
    // $VAR) — our tools can't resolve dynamic paths so the rejection would
    // be a false positive.
    const argsText = trimmed.slice(cmd.length);
    if (hasShellExpansion(argsText)) continue;

    // Detect cat used in write context (heredoc or output redirection)
    if (cmd === "cat") {
      // cat in a pipeline (e.g. `cat file1 file2 | diff`) is legitimate — skip
      const pipeSegments = splitOnUnquotedPipes(trimmed);
      if (pipeSegments.length > 1) continue;

      const isHeredoc = trimmed.includes("<<");
      const hasRedirect = tokens.some((t) => t === ">" || t === ">>");
      if (isHeredoc || hasRedirect) {
        return {
          type: "direct",
          message: [
            `Command rejected: "cat" with redirection should not be run in the terminal — it bypasses user review.`,
            `\nUse the write_file or apply_diff tool instead — they open a diff view for the user to review and approve changes, and return diagnostics from the language server.`,
          ].join("\n"),
        };
      }
    }

    // ── Check sed -i (in-place file editing) ──────────────────────
    if (cmd === "sed") {
      const sedArgs = tokens.slice(1);
      const hasSedInPlace = sedArgs.some(
        (a: string) =>
          a === "-i" ||
          a === "--in-place" ||
          a.startsWith("-i.") ||
          a.startsWith("-i'") ||
          a.startsWith('-i"') ||
          // Combined flags containing i, e.g. -ie, -ni
          (/^-[a-hj-zA-Z]*i/.test(a) && !a.startsWith("--")),
      );
      if (hasSedInPlace) {
        return {
          type: "direct",
          message: [
            `Command rejected: "sed -i" edits files in-place, bypassing user review.`,
            ``,
            `Use the apply_diff tool for targeted edits (search/replace blocks with diff view),`,
            `or find_and_replace for bulk regex substitution across files.`,
          ].join("\n"),
        };
      }

      // sed in a pipeline (e.g. `echo foo | sed 's/a/b/'`) is a legitimate stdout transform
      const pipeSegments = splitOnUnquotedPipes(trimmed);
      if (pipeSegments.length > 1) continue;

      // Standalone sed -n (print/filter mode) — should use read_file or search_files
      const hasQuietFlag = sedArgs.some(
        (a: string) =>
          a === "-n" ||
          a === "--quiet" ||
          a === "--silent" ||
          (/^-[a-hj-mo-zA-Z]*n/.test(a) && !a.startsWith("--")),
      );
      if (hasQuietFlag) {
        return {
          type: "direct",
          message: [
            `Command rejected: "sed -n" reads/filters file content in the terminal.`,
            ``,
            `• To read specific lines: use read_file with offset and limit`,
            `• To find lines matching a pattern: use search_files with regex`,
          ].join("\n"),
        };
      }

      // Standalone sed with a file argument (not -i, not pipeline) — previewing a
      // transform that should use our editing tools instead
      const sedFileArg = findSedFileArg(sedArgs);
      if (sedFileArg) {
        return {
          type: "direct",
          message: [
            `Command rejected: "sed" with a file argument should not be run in the terminal.`,
            ``,
            `Use apply_diff for targeted edits (search/replace blocks with diff view),`,
            `or find_and_replace for bulk regex substitution across files.`,
          ].join("\n"),
        };
      }

      // Bare sed with no file (reads stdin) — unlikely but not harmful
      continue;
    }

    // Build a helpful message
    const lines: string[] = [];
    lines.push(
      `Command rejected: "${cmd}" should not be run in the terminal. Use the ${info.tool} tool to ${info.description} — ${info.reason}.`,
    );

    // Add specific guidance based on the command
    if (cmd === "cat" && tokens.length >= 2) {
      const file = stripQuotes(tokens[tokens.length - 1]);
      lines.push(`\nUse: ${info.tool} with path: "${file}"`);
    } else if (cmd === "head" && tokens.length >= 2) {
      const headArgs = parseHeadArgs(tokens.slice(1));
      const file = findFileArg(tokens.slice(1));
      if (file) {
        const limit = headArgs.output_head ?? 10;
        lines.push(
          `\nUse: ${info.tool} with path: "${file}" and limit: ${limit}`,
        );
      }
    } else if (cmd === "tail" && tokens.length >= 2) {
      const file = findFileArg(tokens.slice(1));
      if (file) {
        lines.push(`\nUse: ${info.tool} with path: "${file}"`);
      }
    } else if (cmd === "grep" && tokens.length >= 2) {
      const grepArgs = parseGrepArgs(tokens.slice(1));
      const pattern = grepArgs.output_grep;
      const file = findFileArg(tokens.slice(1), true);
      lines.push(
        `\nUse: ${info.tool} with${file ? ` path: "${file}" and` : ""} regex: "${pattern ?? "..."}"`,
      );
    }

    return { type: "direct", message: lines.join("\n") };
  }

  return null;
}

interface InlineInterpreter {
  /** Commands that invoke this interpreter (matched against argv[0]) */
  commands: Set<string>;
  /** Display name used in the rejection message */
  displayName: string;
  /** Flags that pass a script inline (e.g. "-c", "-e") */
  inlineFlags: Set<string>;
  /** Detects a file-write API call in the script body */
  writesFile: (script: string) => boolean;
}

const INLINE_INTERPRETERS: InlineInterpreter[] = [
  {
    commands: new Set(["python", "python3"]),
    displayName: "Python",
    inlineFlags: new Set(["-c", "--command"]),
    writesFile: containsPythonFileWrite,
  },
  {
    commands: new Set(["node", "bun", "deno", "tsx", "ts-node"]),
    displayName: "JavaScript/TypeScript",
    inlineFlags: new Set(["-e", "--eval", "-p", "--print"]),
    writesFile: containsJsFileWrite,
  },
  {
    commands: new Set(["perl"]),
    displayName: "Perl",
    inlineFlags: new Set(["-e", "-E"]),
    writesFile: containsPerlFileWrite,
  },
  {
    commands: new Set(["ruby"]),
    displayName: "Ruby",
    inlineFlags: new Set(["-e"]),
    writesFile: containsRubyFileWrite,
  },
  {
    commands: new Set(["osascript"]),
    displayName: "osascript",
    inlineFlags: new Set(["-e"]),
    writesFile: containsOsascriptFileWrite,
  },
];

function checkInlineScriptFileWriters(
  command: string,
): ValidationResult | null {
  // Heredoc bodies commonly contain semicolons. Check the full command first so
  // compound splitting does not detach the interpreter invocation from its body.
  if (command.includes("<<")) {
    const heredocMatch = extractInlineInterpreterScript(command.trim());
    if (heredocMatch?.interpreter.writesFile(heredocMatch.script)) {
      return buildInlineScriptWriteViolation(heredocMatch.interpreter);
    }
  }

  const subCommands = splitOnCompoundOperators(command);

  for (const sub of subCommands) {
    const trimmed = sub.trim();
    if (!trimmed) continue;

    const pipeSegments = splitOnUnquotedPipes(trimmed);
    for (const rawSegment of pipeSegments) {
      const segment = rawSegment.trim();
      if (!segment) continue;

      const match = extractInlineInterpreterScript(segment);
      if (!match) continue;

      if (!match.interpreter.writesFile(match.script)) continue;

      return buildInlineScriptWriteViolation(match.interpreter);
    }
  }

  return null;
}

function checkPdfReadingCommand(
  cmd: string,
  tokens: string[],
): ValidationResult | null {
  if (!PDF_READING_COMMANDS.has(cmd)) return null;

  const pdfPath = tokens
    .slice(1)
    .find((token) => stripQuotes(token).toLowerCase().endsWith(".pdf"));
  if (!pdfPath) return null;

  const path = stripQuotes(pdfPath);
  return {
    type: "direct",
    message: [
      `Command rejected: "${cmd}" should not be used to read local PDFs in the terminal.`,
      ``,
      `Use read_file with path: "${path}" instead — it supports PDF text extraction and keeps file reads in AgentLink's structured tool flow.`,
    ].join("\n"),
  };
}

function buildInlineScriptWriteViolation(
  interpreter: InlineInterpreter,
): ValidationResult {
  return {
    type: "direct",
    message: [
      `Command rejected: inline ${interpreter.displayName} that writes files should not be run in the terminal — it bypasses user review.`,
      ``,
      `Use the write_file or apply_diff tool instead — they open a diff view for the user to review and approve changes, and return diagnostics from the language server.`,
    ].join("\n"),
  };
}

/**
 * Find the file/path argument in a token list (skip flags and their values).
 * For grep, the file arg is the second positional arg (first is the pattern).
 */
function findFileArg(
  args: string[],
  skipFirstPositional = false,
): string | null {
  let skippedFirst = !skipFirstPositional;

  // Simple flag-value pairs to skip
  const valueFlags = new Set(["-n", "--lines", "-c", "-C", "-A", "-B", "-e"]);

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg.startsWith("-")) {
      // Skip flag
      if (valueFlags.has(arg) || arg.match(/^--\w+=/) === null) {
        // If it's a known value flag without =, skip the next token too
        if (valueFlags.has(arg) && i + 1 < args.length) {
          i++;
        }
      }
      continue;
    }

    // Positional argument
    if (!skippedFirst) {
      skippedFirst = true;
      continue;
    }

    return stripQuotes(arg);
  }

  return null;
}

/**
 * Find a file argument in sed's token list.
 * Skips flags, -e/-f values, and the first positional (the sed expression).
 */
function findSedFileArg(args: string[]): string | null {
  let hasExplicitExpr = false;
  let seenImplicitExpr = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    // -e expression or -f script-file — consume the next token
    if ((arg === "-e" || arg === "-f") && i + 1 < args.length) {
      if (arg === "-e") hasExplicitExpr = true;
      i++;
      continue;
    }
    // Combined short flags ending in e or f (e.g. -ne, -nf) — next token is value
    if (
      /^-[a-zA-Z]*[ef]$/.test(arg) &&
      !arg.startsWith("--") &&
      i + 1 < args.length
    ) {
      if (arg.includes("e")) hasExplicitExpr = true;
      i++;
      continue;
    }

    // Skip any other flags
    if (arg.startsWith("-")) continue;

    // First positional is the expression (when no -e was given)
    if (!seenImplicitExpr && !hasExplicitExpr) {
      seenImplicitExpr = true;
      continue;
    }

    // This is a file argument
    return stripQuotes(arg);
  }

  return null;
}

function findTeeFileTargets(args: string[]): string[] {
  const files: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (!arg || arg === "-") continue;

    if (arg === "--") {
      for (let j = i + 1; j < args.length; j++) {
        const tailArg = args[j];
        if (tailArg && tailArg !== "-") files.push(stripQuotes(tailArg));
      }
      break;
    }

    if (arg.startsWith("-")) {
      continue;
    }

    files.push(stripQuotes(arg));
  }

  return files;
}

function extractInlineInterpreterScript(
  segment: string,
): { interpreter: InlineInterpreter; script: string } | null {
  const tokens = tokenize(segment);
  if (tokens.length === 0) return null;

  // Strip an optional `npx` prefix so `npx tsx -e '...'` matches the tsx entry.
  let cmdIndex = 0;
  if (tokens[0] === "npx") {
    // Skip npx flags like -y / --yes / -p <pkg>
    let j = 1;
    while (j < tokens.length && tokens[j].startsWith("-")) {
      if (tokens[j] === "-p" || tokens[j] === "--package") j += 2;
      else j++;
    }
    if (j >= tokens.length) return null;
    cmdIndex = j;
  }

  const cmd = tokens[cmdIndex];
  const interpreter = INLINE_INTERPRETERS.find((i) => i.commands.has(cmd));
  if (!interpreter) return null;

  if (segment.includes("<<")) {
    return { interpreter, script: segment };
  }

  for (let i = cmdIndex + 1; i < tokens.length; i++) {
    const token = tokens[i];

    if (interpreter.inlineFlags.has(token) && i + 1 < tokens.length) {
      return { interpreter, script: stripQuotes(tokens[i + 1]) };
    }

    // Combined short form like -c<script> or -e<script>
    for (const flag of interpreter.inlineFlags) {
      if (flag.length !== 2 || !flag.startsWith("-")) continue;
      if (token.length <= flag.length || !token.startsWith(flag)) continue;
      return { interpreter, script: stripQuotes(token.slice(flag.length)) };
    }
  }

  return null;
}

function containsPythonFileWrite(script: string): boolean {
  return (
    /\.write_text\s*\(/s.test(script) ||
    /\.write_bytes\s*\(/s.test(script) ||
    /\.open\s*\(\s*([rubt]*)(['"])(?:w|a|x|wb|ab|xb|wt|at|xt)\2/s.test(
      script,
    ) ||
    /\bopen\s*\([^,\n]+,\s*([rubt]*)(['"])(?:w|a|x|wb|ab|xb|wt|at|xt)\2/s.test(
      script,
    )
  );
}

function containsJsFileWrite(script: string): boolean {
  return (
    // Node fs — writeFileSync, appendFileSync, createWriteStream, writeSync, cpSync (copyFileSync), renameSync, etc.
    /\b(?:writeFileSync|appendFileSync|createWriteStream|copyFileSync|renameSync|truncateSync|mkdirSync|rmSync|rmdirSync|unlinkSync|symlinkSync|linkSync|chmodSync|chownSync)\s*\(/s.test(
      script,
    ) ||
    // Promises / async forms: fs.writeFile(…), fs.promises.writeFile, await writeFile(…)
    /\b(?:fs|fsp|fsPromises)\s*\.\s*(?:promises\s*\.\s*)?(?:writeFile|appendFile|copyFile|rename|truncate|mkdir|rm|rmdir|unlink|symlink|link|chmod|chown)\s*\(/s.test(
      script,
    ) ||
    // fs.promises destructuring / direct imports: writeFile(path, data)
    /\b(?:writeFile|appendFile)\s*\([^)]*,\s*/s.test(script) ||
    // Bun
    /\bBun\s*\.\s*write\s*\(/s.test(script) ||
    // Deno
    /\bDeno\s*\.\s*(?:writeTextFile|writeFile|create|remove|rename|mkdir|copyFile|symlink|link|chmod|chown)(?:Sync)?\s*\(/s.test(
      script,
    )
  );
}

function containsPerlFileWrite(script: string): boolean {
  // Perl open in write/append mode: open(FH, ">file"), open FH, ">>file", three-arg open(FH, ">", $file)
  if (/\bopen\s*\(?\s*[\w$]+\s*,\s*["']\s*[>+]{1,2}/s.test(script)) return true;
  // Three-arg open with mode as its own argument
  if (/\bopen\s*\(?\s*[\w$]+\s*,\s*["']\s*[>+]{1,2}\s*["']\s*,/s.test(script))
    return true;
  // File-mutating built-ins
  if (
    /\b(?:unlink|rename|symlink|link|mkdir|rmdir|chmod|chown|truncate)\s*\(/.test(
      script,
    )
  )
    return true;
  return false;
}

function containsRubyFileWrite(script: string): boolean {
  // File.write(path, data) / IO.write(…) are always writes
  if (/\b(?:File|IO)\s*\.\s*write\s*\(/s.test(script)) return true;
  // File.open(path, "w"|"a"|"w+"|"a+"|"wb"|"ab") — mode string indicates write
  if (
    /\bFile\s*\.\s*(?:open|new)\s*\([^)]*["'](?:w|a|r\+|w\+|a\+|wb|ab)["']/s.test(
      script,
    )
  )
    return true;
  // FileUtils mutating operations
  if (
    /\bFileUtils\s*\.\s*(?:cp|mv|mkdir|mkdir_p|rm|rm_r|rm_rf|touch|chmod|chown|ln_s)\b/s.test(
      script,
    )
  )
    return true;
  return false;
}

function containsOsascriptFileWrite(script: string): boolean {
  // AppleScript file writes: "write … to file", "open for access … with write permission"
  return (
    /\bwrite\s+.+\s+to\s+(?:file|POSIX\s+file)/is.test(script) ||
    /\bopen\s+for\s+access\b/is.test(script)
  );
}

function hasOutputRedirection(command: string): boolean {
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];

    if (ch === "\\" && i + 1 < command.length) {
      i++;
      continue;
    }

    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }

    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }

    if (inSingle || inDouble || ch !== ">") continue;

    const next = i + 1 < command.length ? command[i + 1] : "";

    // Ignore FD redirects like 2>&1, 1>&2, 3>&-, >&2
    if (next === "&") continue;

    return true;
  }

  return false;
}

/**
 * Split a command on && ; || (compound operators) while respecting quotes.
 * Does NOT split on | (single pipe) — that's handled by the pipe validator.
 */
function splitOnCompoundOperators(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let i = 0;

  while (i < command.length) {
    const ch = command[i];

    // Backslash escape
    if (ch === "\\" && i + 1 < command.length) {
      current += ch + command[i + 1];
      i += 2;
      continue;
    }

    // Quote tracking
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      current += ch;
      i++;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      current += ch;
      i++;
      continue;
    }

    if (!inSingle && !inDouble) {
      // && operator
      if (ch === "&" && i + 1 < command.length && command[i + 1] === "&") {
        segments.push(current);
        current = "";
        i += 2;
        continue;
      }

      // || operator
      if (ch === "|" && i + 1 < command.length && command[i + 1] === "|") {
        segments.push(current);
        current = "";
        i += 2;
        continue;
      }

      // ; separator
      if (ch === ";") {
        segments.push(current);
        current = "";
        i++;
        continue;
      }
    }

    current += ch;
    i++;
  }

  segments.push(current);
  return segments;
}

/**
 * Scan a command for unquoted pipes to head, tail, or grep.
 * Returns null if the command is clean, or a result with a rejection message.
 */
function detectPipedFiltering(command: string): ValidationResult | null {
  const segments = splitOnUnquotedPipes(command);
  if (segments.length < 2) return null;

  const violations: PipeViolation[] = [];
  const keptSegments: string[] = [segments[0]];

  for (let i = 1; i < segments.length; i++) {
    const segment = segments[i].trim();
    const violation = checkSegment(segment);
    if (violation) {
      violations.push(violation);
    } else {
      keptSegments.push(segments[i]);
    }
  }

  if (violations.length === 0) return null;

  const strippedCommand = keptSegments.join(" | ").trim();

  // Build the message
  const lines: string[] = [];

  lines.push(
    `Command rejected: piping through ${violations.map((v) => `"${v.command}"`).join(" and ")} hides output from the user's terminal.`,
  );
  lines.push("");

  // Suggest parameters
  const allSuggestions: Record<string, string | number> = {};
  for (const v of violations) {
    Object.assign(allSuggestions, v.suggestions);
  }

  const paramList = Object.entries(allSuggestions)
    .map(([k, v]) => `  ${k}: ${typeof v === "string" ? `"${v}"` : v}`)
    .join("\n");
  lines.push(`Use these tool parameters instead:\n${paramList}`);
  lines.push("");
  lines.push(`Run this command instead: ${strippedCommand}`);
  lines.push("");
  lines.push(
    `Do NOT retry with force=true — pipe filtering is never a false positive. Use the suggested parameters instead.`,
  );

  return {
    type: "pipe",
    message: lines.join("\n"),
    strippedCommand,
  };
}

const REJECTED_COMMANDS = new Set(["head", "tail", "grep"]);

/**
 * Check if a pipe segment is a head/tail/grep invocation.
 * Returns a violation with parsed suggestions, or null if it's not one of those.
 */
function checkSegment(segment: string): PipeViolation | null {
  const tokens = tokenize(segment);
  if (tokens.length === 0) return null;

  const cmd = tokens[0];
  if (!REJECTED_COMMANDS.has(cmd)) return null;

  const args = tokens.slice(1);

  switch (cmd) {
    case "head":
      return {
        command: cmd,
        segment,
        suggestions: ensurePositive(parseHeadArgs(args)),
      };
    case "tail":
      return {
        command: cmd,
        segment,
        suggestions: ensurePositive(parseTailArgs(args)),
      };
    case "grep":
      return { command: cmd, segment, suggestions: parseGrepArgs(args) };
    default:
      return null;
  }
}

/**
 * Parse head arguments: head -5, head -n 5, head -n5, head --lines=5
 */
function parseHeadArgs(args: string[]): Record<string, number> {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    // head -5 (shorthand)
    const shortMatch = arg.match(/^-(\d+)$/);
    if (shortMatch) {
      return { output_head: parseInt(shortMatch[1], 10) };
    }

    // head -n5 or head -n 5
    if (arg === "-n" || arg === "--lines") {
      const next = args[i + 1];
      if (next && /^\d+$/.test(next)) {
        return { output_head: parseInt(next, 10) };
      }
    }
    const nMatch = arg.match(/^-n(\d+)$/);
    if (nMatch) {
      return { output_head: parseInt(nMatch[1], 10) };
    }

    // head --lines=5
    const longMatch = arg.match(/^--lines=(\d+)$/);
    if (longMatch) {
      return { output_head: parseInt(longMatch[1], 10) };
    }
  }

  // Default: head with no args means 10 lines
  return { output_head: 10 };
}

function ensurePositive(
  result: Record<string, number>,
): Record<string, number> {
  for (const key of Object.keys(result)) {
    if (result[key] <= 0) result[key] = 1;
  }
  return result;
}

/**
 * Parse tail arguments: tail -5, tail -n 5, tail -n +5 (offset)
 */
function parseTailArgs(args: string[]): Record<string, number> {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    // tail -5 (shorthand)
    const shortMatch = arg.match(/^-(\d+)$/);
    if (shortMatch) {
      return { output_tail: parseInt(shortMatch[1], 10) };
    }

    // tail -n +5 (offset from start — maps to output_offset)
    if (arg === "-n" || arg === "--lines") {
      const next = args[i + 1];
      if (next) {
        const offsetMatch = next.match(/^\+(\d+)$/);
        if (offsetMatch) {
          return { output_offset: parseInt(offsetMatch[1], 10) };
        }
        if (/^\d+$/.test(next)) {
          return { output_tail: parseInt(next, 10) };
        }
      }
    }

    // tail -n5 or tail -n+5
    const nMatch = arg.match(/^-n(\d+)$/);
    if (nMatch) {
      return { output_tail: parseInt(nMatch[1], 10) };
    }
    const nOffsetMatch = arg.match(/^-n\+(\d+)$/);
    if (nOffsetMatch) {
      return { output_offset: parseInt(nOffsetMatch[1], 10) };
    }

    // tail --lines=5 or --lines=+5
    const longMatch = arg.match(/^--lines=\+?(\d+)$/);
    if (longMatch) {
      const hasPlus = arg.includes("+");
      const num = parseInt(longMatch[1], 10);
      return hasPlus ? { output_offset: num } : { output_tail: num };
    }
  }

  // Default: tail with no args means 10 lines
  return { output_tail: 10 };
}

/**
 * Parse grep arguments: grep pattern, grep -i pattern, grep -C 3 pattern,
 * grep -E "regex", etc.
 */
function parseGrepArgs(args: string[]): Record<string, string | number> {
  const suggestions: Record<string, string | number> = {};
  let pattern: string | null = null;

  // Flags that consume the next argument
  const valueFlagsSet = new Set([
    "-e",
    "--regexp",
    "-f",
    "--file",
    "-m",
    "--max-count",
    "--label",
    "-A",
    "--after-context",
    "-B",
    "--before-context",
    "-C",
    "--context",
    "--color",
    "--colour",
    "-D",
    "--devices",
    "-d",
    "--directories",
    "--exclude",
    "--include",
    "--exclude-dir",
    "--include-dir",
  ]);

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    // Context flags
    if ((arg === "-C" || arg === "--context") && args[i + 1]) {
      const num = parseInt(args[i + 1], 10);
      if (!isNaN(num)) suggestions.output_grep_context = num;
      i++;
      continue;
    }
    if ((arg === "-A" || arg === "--after-context") && args[i + 1]) {
      const num = parseInt(args[i + 1], 10);
      if (!isNaN(num)) suggestions.output_grep_context = num;
      i++;
      continue;
    }
    if ((arg === "-B" || arg === "--before-context") && args[i + 1]) {
      const num = parseInt(args[i + 1], 10);
      if (!isNaN(num)) suggestions.output_grep_context = num;
      i++;
      continue;
    }

    // Explicit pattern flag
    if ((arg === "-e" || arg === "--regexp") && args[i + 1]) {
      pattern = stripQuotes(args[i + 1]);
      i++;
      continue;
    }

    // Other value flags — skip the value
    if (valueFlagsSet.has(arg)) {
      i++;
      continue;
    }

    // Boolean flags (single char or long) — skip
    if (arg.startsWith("-")) {
      // Combined short flags like -inE
      continue;
    }

    // First positional argument is the pattern
    if (pattern === null) {
      pattern = stripQuotes(arg);
      continue;
    }
  }

  if (pattern) {
    suggestions.output_grep = pattern;
  }

  return suggestions;
}

/**
 * Detect unquoted shell expansion in a string: $(...), backticks, or $VAR.
 * Returns true if the string contains dynamic shell features that our tools
 * cannot resolve, meaning the command should be allowed through.
 */
function hasShellExpansion(text: string): boolean {
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    // Backslash escape (skip next char)
    if (ch === "\\" && i + 1 < text.length && !inSingle) {
      i++;
      continue;
    }

    // Quote tracking
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }

    // Inside single quotes, nothing is expanded
    if (inSingle) continue;

    // $( — command substitution
    if (ch === "$" && i + 1 < text.length && text[i + 1] === "(") {
      return true;
    }

    // $VAR or ${VAR} — environment variable ($ followed by letter or {)
    if (
      ch === "$" &&
      i + 1 < text.length &&
      (/[A-Za-z_]/.test(text[i + 1]) || text[i + 1] === "{")
    ) {
      return true;
    }

    // Backtick command substitution
    if (ch === "`") {
      return true;
    }
  }

  return false;
}

function stripQuotes(s: string): string {
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    return s.slice(1, -1);
  }
  return s;
}

/**
 * Split a command string on unquoted pipe (|) characters.
 * Respects single quotes, double quotes, and backslash escapes.
 * Does NOT split on || (logical OR).
 */
function splitOnUnquotedPipes(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let i = 0;

  while (i < command.length) {
    const ch = command[i];

    // Backslash escape
    if (ch === "\\" && i + 1 < command.length) {
      current += ch + command[i + 1];
      i += 2;
      continue;
    }

    // Quote tracking
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      current += ch;
      i++;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      current += ch;
      i++;
      continue;
    }

    // Pipe — only outside quotes
    if (ch === "|" && !inSingle && !inDouble) {
      // Skip || (logical OR)
      if (i + 1 < command.length && command[i + 1] === "|") {
        current += "||";
        i += 2;
        continue;
      }
      segments.push(current);
      current = "";
      i++;
      continue;
    }

    current += ch;
    i++;
  }

  segments.push(current);
  return segments;
}

/**
 * Simple tokenizer: split on whitespace, respecting quotes and escapes.
 */
function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (ch === "\\" && i + 1 < input.length && !inSingle) {
      current += ch + input[i + 1];
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
