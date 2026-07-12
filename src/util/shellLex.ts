export type ShellLexQuote = "single" | "double";

export type ShellLexBoundary =
  | {
      kind: "separator";
      operator: "&&" | "||" | "|" | ";" | "\n";
      start: number;
      end: number;
    }
  | {
      kind: "comment";
      start: number;
      end: number;
    };

export interface ShellLexScanResult {
  boundaries: ShellLexBoundary[];
  finalState: {
    quote: ShellLexQuote | null;
    danglingEscape: boolean;
  };
}

/**
 * Scans the legacy command-splitter dialect without interpreting shell syntax.
 *
 * This deliberately recognizes only quotes, escape-next-character, command
 * separators, newlines, and word-boundary comments. Substitutions, grouping,
 * heredocs, redirections, assignments, background jobs, and PowerShell syntax
 * remain opaque source text.
 */
export function scanShellLexBoundaries(input: string): ShellLexScanResult {
  const boundaries: ShellLexBoundary[] = [];
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
    boundaries.push(boundary);
    segmentStart = boundary.end;
    index = boundary.end;
  }

  return {
    boundaries,
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
