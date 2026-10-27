/**
 * Surface-neutral pieces of VS Code's `find_and_replace` tool: pattern
 * construction, regex replacement expansion, match collection with review
 * context, the `max_replacements` guardrail, and VS Code's no-match and
 * guardrail payloads. Hosts own file discovery, reads, review, and writes.
 */

/** Lines of context VS Code shows around each match in its preview. */
export const FIND_AND_REPLACE_CONTEXT_LINES = 5;
/** Maximum files VS Code's `glob` mode collects (`findFiles` limit). */
export const FIND_AND_REPLACE_MAX_GLOB_FILES = 500;

export interface FindAndReplaceParams {
  readonly find: string;
  readonly replace: string;
  readonly path?: string;
  readonly glob?: string;
  readonly regex?: boolean;
  readonly max_replacements?: number;
}

export interface FindAndReplaceLine {
  readonly lineNumber: number;
  readonly text: string;
}

/** One reviewable match, in VS Code's preview shape. */
export interface FindAndReplaceMatch {
  readonly id: string;
  readonly line: number;
  readonly columnStart: number;
  readonly columnEnd: number;
  readonly matchText: string;
  readonly replaceText: string;
  readonly contextBefore: FindAndReplaceLine[];
  readonly matchLine: FindAndReplaceLine;
  readonly contextAfter: FindAndReplaceLine[];
}

export interface FindAndReplaceReplacement {
  readonly startOffset: number;
  readonly endOffset: number;
  readonly newText: string;
  readonly matchId: string;
}

const REPLACEMENT_ESCAPES: Record<string, string> = {
  n: "\n",
  t: "\t",
  "\\": "\\",
};

/**
 * Expands a regex-mode replacement template in one pass. Like VS Code's regex
 * replace, `\n`, `\t` and `\\` are interpreted so replacement text can reproduce
 * the whitespace a pattern matched; other backslash sequences stay literal.
 */
export function expandReplacement(
  replacement: string,
  match: RegExpExecArray,
): string {
  return replacement.replace(
    /\\([nt\\])|\$(\$|\d{1,2})/g,
    (token, escape: string | undefined, dollar: string | undefined) =>
      escape !== undefined
        ? (REPLACEMENT_ESCAPES[escape] ?? token)
        : expandDollarReference(token, dollar ?? "", match),
  );
}

function expandDollarReference(
  token: string,
  reference: string,
  match: RegExpExecArray,
): string {
  if (reference === "$") return "$";
  const index = Number(reference);
  if (index > 0 && index < match.length) return match[index] ?? "";
  if (reference.length === 2) {
    const first = Number(reference[0]);
    if (first > 0 && first < match.length) {
      return (match[first] ?? "") + reference[1];
    }
  }
  return token;
}

/** VS Code's search pattern: multiline regex, or an escaped literal. */
export function buildFindAndReplacePattern(
  find: string,
  regex: boolean | undefined,
):
  | { readonly ok: true; readonly pattern: RegExp }
  | { readonly ok: false; readonly error: string } {
  if (regex) {
    try {
      return { ok: true, pattern: new RegExp(find, "gm") };
    } catch (e) {
      return {
        ok: false,
        error: `Invalid regex: ${e instanceof Error ? e.message : e}`,
      };
    }
  }
  const escaped = find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return { ok: true, pattern: new RegExp(escaped, "g") };
}

/** Line lookup equivalent to a VS Code `TextDocument`'s positions and lines. */
class LineIndex {
  private readonly starts: number[] = [0];
  private readonly ends: number[] = [];

  constructor(private readonly text: string) {
    const eol = /\r\n|\r|\n/g;
    let found: RegExpExecArray | null;
    while ((found = eol.exec(text)) !== null) {
      this.ends.push(found.index);
      this.starts.push(found.index + found[0].length);
    }
    this.ends.push(text.length);
  }

  get lineCount(): number {
    return this.starts.length;
  }

  positionAt(offset: number): { line: number; character: number } {
    let low = 0;
    let high = this.starts.length - 1;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (this.starts[mid]! <= offset) low = mid;
      else high = mid - 1;
    }
    const character = Math.min(offset, this.ends[low]!) - this.starts[low]!;
    return { line: low, character };
  }

  lineText(line: number): string {
    return this.text.slice(this.starts[line], this.ends[line]);
  }
}

/**
 * Collect every match in one file with VS Code's ids (`file:match`), offsets,
 * and five lines of review context. The pattern's `lastIndex` is reset.
 */
export function collectFindAndReplaceMatches(
  text: string,
  pattern: RegExp,
  options: {
    readonly replace: string;
    readonly regex?: boolean;
    readonly fileIndex: number;
  },
): {
  replacements: FindAndReplaceReplacement[];
  matches: FindAndReplaceMatch[];
} {
  const lines = new LineIndex(text);
  const replacements: FindAndReplaceReplacement[] = [];
  const matches: FindAndReplaceMatch[] = [];
  pattern.lastIndex = 0;
  let regexMatch: RegExpExecArray | null;
  let matchIdx = 0;

  while ((regexMatch = pattern.exec(text)) !== null) {
    const startPos = lines.positionAt(regexMatch.index);
    const endPos = lines.positionAt(regexMatch.index + regexMatch[0].length);

    // Expand once from the original match so anchors/lookarounds and dollar
    // tokens inside captured content are not reinterpreted.
    const newText = options.regex
      ? expandReplacement(options.replace, regexMatch)
      : options.replace;

    const matchId = `${options.fileIndex}:${matchIdx}`;
    const matchLine = startPos.line;
    const startCtx = Math.max(0, matchLine - FIND_AND_REPLACE_CONTEXT_LINES);
    const endCtx = Math.min(
      lines.lineCount - 1,
      matchLine + FIND_AND_REPLACE_CONTEXT_LINES,
    );

    const contextBefore: FindAndReplaceLine[] = [];
    for (let ln = startCtx; ln < matchLine; ln++) {
      contextBefore.push({ lineNumber: ln + 1, text: lines.lineText(ln) });
    }
    const contextAfter: FindAndReplaceLine[] = [];
    for (let ln = matchLine + 1; ln <= endCtx; ln++) {
      contextAfter.push({ lineNumber: ln + 1, text: lines.lineText(ln) });
    }

    replacements.push({
      startOffset: regexMatch.index,
      endOffset: regexMatch.index + regexMatch[0].length,
      newText,
      matchId,
    });
    matches.push({
      id: matchId,
      line: matchLine + 1,
      columnStart: startPos.character,
      columnEnd: endPos.character,
      matchText: regexMatch[0],
      replaceText: newText,
      contextBefore,
      matchLine: { lineNumber: matchLine + 1, text: lines.lineText(matchLine) },
      contextAfter,
    });

    matchIdx++;

    // RegExp.prototype.exec does not advance lastIndex after an empty global
    // match. Advance explicitly so anchor/lookaround patterns cannot loop.
    if (regexMatch[0].length === 0) pattern.lastIndex++;
  }

  return { replacements, matches };
}

/** Apply non-overlapping replacements collected from `text`. */
export function applyFindAndReplaceReplacements(
  text: string,
  replacements: readonly FindAndReplaceReplacement[],
): string {
  let result = text;
  for (const replacement of [...replacements].sort(
    (left, right) => right.startOffset - left.startOffset,
  )) {
    result =
      result.slice(0, replacement.startOffset) +
      replacement.newText +
      result.slice(replacement.endOffset);
  }
  return result;
}

/** VS Code's result when no file contains a match. */
export function findAndReplaceNoMatchesResult(
  find: string,
  filesSearched: number,
): Record<string, unknown> {
  return { status: "no_matches", find, files_searched: filesSearched };
}

/**
 * VS Code's `max_replacements` guardrail: an error message for an invalid
 * limit, a `too_many_matches` payload when exceeded, or undefined.
 */
export function checkFindAndReplaceGuardrail(
  params: Pick<FindAndReplaceParams, "find" | "max_replacements">,
  totalMatches: number,
  filesMatched: number,
):
  | { readonly kind: "invalid"; readonly error: string }
  | { readonly kind: "exceeded"; readonly payload: Record<string, unknown> }
  | undefined {
  if (params.max_replacements == null) return undefined;
  const maxReplacements = Number(params.max_replacements);
  if (
    !Number.isFinite(maxReplacements) ||
    !Number.isInteger(maxReplacements) ||
    maxReplacements <= 0
  ) {
    return {
      kind: "invalid",
      error: `'max_replacements' must be a positive integer. Received: ${params.max_replacements}`,
    };
  }
  if (totalMatches <= maxReplacements) return undefined;
  return {
    kind: "exceeded",
    payload: {
      status: "too_many_matches",
      find: params.find,
      max_replacements: maxReplacements,
      total_matches: totalMatches,
      files_matched: filesMatched,
      message:
        "Match count exceeds max_replacements guardrail; no edits were applied.",
    },
  };
}

export interface FindAndReplaceFileInput {
  /** Host display path (VS Code uses the workspace-relative path). */
  readonly path: string;
  readonly content: string;
}

export interface FindAndReplaceFilePlan {
  readonly path: string;
  readonly content: string;
  readonly proposedContent: string;
  readonly replacements: FindAndReplaceReplacement[];
  readonly matches: FindAndReplaceMatch[];
}

/**
 * The full VS Code decision for already-read files: an error, a final
 * payload that writes nothing (no matches, guardrail), or the per-file
 * proposals a host reviews and writes.
 */
export type FindAndReplacePlan =
  | { readonly status: "error"; readonly error: string }
  | { readonly status: "final"; readonly payload: Record<string, unknown> }
  | {
      readonly status: "ready";
      readonly files: readonly FindAndReplaceFilePlan[];
      readonly totalMatches: number;
    };

export function planFindAndReplace(
  params: Pick<
    FindAndReplaceParams,
    "find" | "replace" | "regex" | "max_replacements"
  >,
  files: readonly FindAndReplaceFileInput[],
): FindAndReplacePlan {
  if (!params.find) {
    return { status: "error", error: "'find' parameter is required" };
  }
  const built = buildFindAndReplacePattern(params.find, params.regex);
  if (!built.ok) return { status: "error", error: built.error };
  const planned: FindAndReplaceFilePlan[] = [];
  let totalMatches = 0;
  files.forEach((file, fileIndex) => {
    const { replacements, matches } = collectFindAndReplaceMatches(
      file.content,
      built.pattern,
      { replace: params.replace, regex: params.regex, fileIndex },
    );
    if (replacements.length === 0) return;
    totalMatches += replacements.length;
    planned.push({
      path: file.path,
      content: file.content,
      proposedContent: applyFindAndReplaceReplacements(
        file.content,
        replacements,
      ),
      replacements,
      matches,
    });
  });
  if (totalMatches === 0) {
    return {
      status: "final",
      payload: findAndReplaceNoMatchesResult(params.find, files.length),
    };
  }
  const guardrail = checkFindAndReplaceGuardrail(
    params,
    totalMatches,
    planned.length,
  );
  if (guardrail?.kind === "invalid") {
    return { status: "error", error: guardrail.error };
  }
  if (guardrail?.kind === "exceeded") {
    return { status: "final", payload: guardrail.payload };
  }
  return { status: "ready", files: planned, totalMatches };
}
