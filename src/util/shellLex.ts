export type ShellLexQuote = "single" | "double";

export type ShellLexSeparator = "&&" | "||" | "|" | ";" | "\n";

export type ShellLexBoundary =
  | {
      kind: "separator";
      operator: ShellLexSeparator;
      start: number;
      end: number;
    }
  | {
      kind: "comment";
      start: number;
      end: number;
    };

export interface ShellLexFinalState {
  quote: ShellLexQuote | null;
  danglingEscape: boolean;
}

export interface ShellLexScanResult {
  boundaries: ShellLexBoundary[];
  finalState: ShellLexFinalState;
}

export interface ShellLexBoundaryOptions {
  separators?: readonly ShellLexSeparator[];
  comments?: boolean;
}

export interface ShellLexWord {
  start: number;
  end: number;
  raw: string;
}

export interface ShellLexWordScanResult {
  words: ShellLexWord[];
  finalState: ShellLexFinalState;
}

export interface ShellLexTokenOptions {
  operators?: readonly (">>" | ">" | "<")[];
  escapeInSingleQuotes?: boolean;
}

export interface ShellLexTokenScanResult {
  tokens: string[];
  finalState: ShellLexFinalState;
}

export interface ShellLexLiteralOccurrence {
  start: number;
  end: number;
  quote: ShellLexQuote | null;
  escaped: boolean;
  comment: boolean;
}

export type ShellLexUnsupportedSyntaxKind =
  | "ansi-c-quote"
  | "command-substitution"
  | "backtick-substitution"
  | "parameter-expansion"
  | "arithmetic-expansion"
  | "process-substitution"
  | "heredoc";

export interface ShellLexUnsupportedSyntax {
  kind: ShellLexUnsupportedSyntaxKind;
  start: number;
  end: number;
}

export interface ShellLexLiteralScanResult {
  occurrences: ShellLexLiteralOccurrence[];
  unsupportedSyntax: ShellLexUnsupportedSyntax[];
  finalState: ShellLexFinalState;
}

/**
 * Scans the legacy command-splitter dialect without interpreting shell syntax.
 *
 * This deliberately recognizes only quotes, escape-next-character, command
 * separators, newlines, and word-boundary comments. Substitutions, grouping,
 * heredocs, redirections, assignments, background jobs, and PowerShell syntax
 * remain opaque source text.
 */
export function scanShellLexBoundaries(
  input: string,
  options: ShellLexBoundaryOptions = {},
): ShellLexScanResult {
  const boundaries: ShellLexBoundary[] = [];
  const separators = new Set<ShellLexSeparator>(
    options.separators ?? ["&&", "||", "|", ";", "\n"],
  );
  const recognizeComments = options.comments ?? true;
  let quote: ShellLexQuote | null = null;
  let danglingEscape = false;
  let segmentStart = 0;
  let index = 0;

  while (index < input.length) {
    const ch = input[index];

    if (ch === "\\") {
      if (index + 1 < input.length) {
        index += 2;
        continue;
      }
      danglingEscape = true;
      index++;
      continue;
    }

    if (ch === "'" && quote !== "double") {
      quote = quote === "single" ? null : "single";
      index++;
      continue;
    }
    if (ch === '"' && quote !== "single") {
      quote = quote === "double" ? null : "double";
      index++;
      continue;
    }

    if (quote) {
      index++;
      continue;
    }

    if (
      recognizeComments &&
      ch === "#" &&
      (input.slice(segmentStart, index).trim() === "" ||
        /\s/.test(input[index - 1] ?? ""))
    ) {
      let end = index;
      while (end < input.length && input[end] !== "\n") end++;
      if (end < input.length) end++;
      boundaries.push({ kind: "comment", start: index, end });
      segmentStart = end;
      index = end;
      continue;
    }

    const boundary = readSeparator(input, index);
    if (!boundary) {
      index++;
      continue;
    }
    if (separators.has(boundary.operator)) {
      boundaries.push(boundary);
      segmentStart = boundary.end;
    }
    index = boundary.end;
  }

  return {
    boundaries,
    finalState: { quote, danglingEscape },
  };
}

/**
 * Groups raw shell-like words on unquoted whitespace while preserving source.
 *
 * Backslash escapes the next character outside single quotes. Quotes and
 * backslashes remain in each raw word, and malformed final state is diagnostic
 * only. Operators, comments, substitutions, and redirections are not parsed.
 */
export function scanShellLexWords(input: string): ShellLexWordScanResult {
  const words: ShellLexWord[] = [];
  let quote: ShellLexQuote | null = null;
  let danglingEscape = false;
  let wordStart: number | null = null;
  let index = 0;

  const finishWord = (end: number) => {
    if (wordStart === null) return;
    words.push({ start: wordStart, end, raw: input.slice(wordStart, end) });
    wordStart = null;
  };

  while (index < input.length) {
    const ch = input[index];

    if (ch === "\\" && quote !== "single") {
      wordStart ??= index;
      if (index + 1 < input.length) {
        index += 2;
        continue;
      }
      danglingEscape = true;
      index++;
      continue;
    }

    if (ch === "'" && quote !== "double") {
      wordStart ??= index;
      quote = quote === "single" ? null : "single";
      index++;
      continue;
    }
    if (ch === '"' && quote !== "single") {
      wordStart ??= index;
      quote = quote === "double" ? null : "double";
      index++;
      continue;
    }

    if (/\s/.test(ch) && !quote) {
      finishWord(index);
      index++;
      continue;
    }

    wordStart ??= index;
    index++;
  }

  finishWord(input.length);
  return { words, finalState: { quote, danglingEscape } };
}

/**
 * Tokenizes shell-like source while removing quote delimiters and escape markers.
 *
 * Optional redirection operators are emitted as separate tokens. Empty quoted
 * arguments are omitted. Malformed final state is diagnostic only.
 */
export function scanShellLexTokens(
  input: string,
  options: ShellLexTokenOptions = {},
): ShellLexTokenScanResult {
  const tokens: string[] = [];
  const operators = new Set(options.operators ?? []);
  const escapeInSingleQuotes = options.escapeInSingleQuotes ?? false;
  let current = "";
  let quote: ShellLexQuote | null = null;
  let danglingEscape = false;
  let index = 0;

  const finishToken = () => {
    if (!current) return;
    tokens.push(current);
    current = "";
  };

  while (index < input.length) {
    const ch = input[index];

    if (ch === "\\" && (quote !== "single" || escapeInSingleQuotes)) {
      if (index + 1 < input.length) {
        current += input[index + 1];
        index += 2;
        continue;
      }
      danglingEscape = true;
      index++;
      continue;
    }

    if (ch === "'" && quote !== "double") {
      quote = quote === "single" ? null : "single";
      index++;
      continue;
    }
    if (ch === '"' && quote !== "single") {
      quote = quote === "double" ? null : "double";
      index++;
      continue;
    }

    if (!quote && /\s/.test(ch)) {
      finishToken();
      index++;
      continue;
    }

    if (!quote) {
      const operator = readTokenOperator(input, index);
      if (operator) {
        if (operators.has(operator.value)) {
          finishToken();
          tokens.push(operator.value);
        } else {
          current += operator.value;
        }
        index = operator.end;
        continue;
      }
    }

    current += ch;
    index++;
  }

  finishToken();
  return { tokens, finalState: { quote, danglingEscape } };
}

/**
 * Finds exact literal occurrences while sharing the bounded shell quote,
 * escape, and comment dialect used by command validation.
 *
 * Unsupported expansion constructs are reported rather than interpreted. This
 * lets source-rewriting consumers fail closed without growing a second shell
 * parser or guessing about nested shell evaluation.
 */
export function scanShellLexLiteralOccurrences(
  input: string,
  literal: string,
): ShellLexLiteralScanResult {
  if (!literal)
    throw new Error("Shell literal scan requires a non-empty literal");

  const occurrences: ShellLexLiteralOccurrence[] = [];
  const unsupportedSyntax: ShellLexUnsupportedSyntax[] = [];
  let quote: ShellLexQuote | null = null;
  let danglingEscape = false;
  let inComment = false;
  let index = 0;

  const recordOccurrence = (
    start: number,
    escaped: boolean,
    comment: boolean,
  ) => {
    if (!input.startsWith(literal, start)) return false;
    occurrences.push({
      start,
      end: start + literal.length,
      quote,
      escaped,
      comment,
    });
    return true;
  };
  const recordUnsupported = (
    kind: ShellLexUnsupportedSyntaxKind,
    length: number,
  ) => {
    unsupportedSyntax.push({ kind, start: index, end: index + length });
  };

  while (index < input.length) {
    const ch = input[index];

    if (inComment) {
      if (recordOccurrence(index, false, true)) {
        index += literal.length;
        continue;
      }
      if (ch === "\n") inComment = false;
      index++;
      continue;
    }

    if (ch === "\\" && quote !== "single") {
      if (index + 1 < input.length) {
        if (recordOccurrence(index + 1, true, false)) {
          index += literal.length + 1;
        } else {
          index += 2;
        }
        continue;
      }
      danglingEscape = true;
      index++;
      continue;
    }

    if (recordOccurrence(index, false, false)) {
      index += literal.length;
      continue;
    }

    if (
      ch === "#" &&
      quote === null &&
      (index === 0 || /[\s;&|]/.test(input[index - 1] ?? ""))
    ) {
      inComment = true;
      index++;
      continue;
    }

    if (quote !== "single") {
      if (input.startsWith("$((", index) || input.startsWith("$[", index)) {
        recordUnsupported(
          "arithmetic-expansion",
          input[index + 1] === "[" ? 2 : 3,
        );
      } else if (input.startsWith("$(", index)) {
        recordUnsupported("command-substitution", 2);
      } else if (input.startsWith("${", index)) {
        recordUnsupported("parameter-expansion", 2);
      } else {
        const parameterExpansion = input
          .slice(index)
          .match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*|[0-9@*#?$!_-])/);
        if (parameterExpansion) {
          recordUnsupported(
            "parameter-expansion",
            parameterExpansion[0].length,
          );
        } else if (ch === "`") {
          recordUnsupported("backtick-substitution", 1);
        }
      }
    }
    if (quote === null) {
      if (input.startsWith("$'", index)) {
        recordUnsupported("ansi-c-quote", 2);
      } else if (
        input.startsWith("<(", index) ||
        input.startsWith(">(", index) ||
        input.startsWith("=(", index)
      ) {
        recordUnsupported("process-substitution", 2);
      } else if (input.startsWith("<<<", index)) {
        recordUnsupported("heredoc", 3);
      } else if (input.startsWith("<<-", index)) {
        recordUnsupported("heredoc", 3);
      } else if (input.startsWith("<<", index)) {
        recordUnsupported("heredoc", 2);
      }
    }

    if (ch === "'" && quote !== "double") {
      quote = quote === "single" ? null : "single";
    } else if (ch === '"' && quote !== "single") {
      quote = quote === "double" ? null : "double";
    }
    index++;
  }

  return {
    occurrences,
    unsupportedSyntax,
    finalState: { quote, danglingEscape },
  };
}

function readSeparator(
  input: string,
  index: number,
): Extract<ShellLexBoundary, { kind: "separator" }> | null {
  const ch = input[index];
  const next = input[index + 1];
  if (ch === "&" && next === "&") {
    return { kind: "separator", operator: "&&", start: index, end: index + 2 };
  }
  if (ch === "|" && next === "|") {
    return { kind: "separator", operator: "||", start: index, end: index + 2 };
  }
  if (ch === "|") {
    return { kind: "separator", operator: "|", start: index, end: index + 1 };
  }
  if (ch === ";") {
    return { kind: "separator", operator: ";", start: index, end: index + 1 };
  }
  if (ch === "\n") {
    return { kind: "separator", operator: "\n", start: index, end: index + 1 };
  }
  return null;
}

function readTokenOperator(
  input: string,
  index: number,
): { value: ">>" | ">" | "<"; end: number } | null {
  if (input[index] === ">" && input[index + 1] === ">") {
    return { value: ">>", end: index + 2 };
  }
  if (input[index] === ">") return { value: ">", end: index + 1 };
  if (input[index] === "<") return { value: "<", end: index + 1 };
  return null;
}
