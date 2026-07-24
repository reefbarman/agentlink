import * as path from "path";

// VS Code glob syntax (vs/base/common/glob) treats these as pattern
// operators. Each is wrapped in a single-character class so the query text
// matches literally. `]` is intentionally absent: unpaired `]` is already
// literal, and wrapping it (`[]]`) parses as an empty class in VS Code.
const GLOB_OPERATORS = new Set(["*", "?", "[", "{", "}"]);

/**
 * Converts a raw file-picker query into a glob fragment that matches
 * case-insensitively, since `workspace.findFiles` patterns are case-sensitive
 * even on case-insensitive filesystems.
 */
export function toCaseInsensitiveGlob(query: string): string {
  let pattern = "";
  for (const ch of query) {
    const lower = ch.toLowerCase();
    const upper = ch.toUpperCase();
    if (lower !== upper && lower.length === 1 && upper.length === 1) {
      pattern += `[${lower}${upper}]`;
    } else if (GLOB_OPERATORS.has(ch)) {
      pattern += `[${ch}]`;
    } else {
      pattern += ch;
    }
  }
  return pattern;
}

export interface FileSearchPattern {
  /** Glob passed to `workspace.findFiles`, relative to the project root. */
  pattern: string;
  /**
   * The query after relativizing pasted absolute paths, in `/`-separated
   * form. Use this (not the raw query) for result ranking.
   */
  effectiveQuery: string;
}

/**
 * Builds the `findFiles` include pattern for an `@`-mention file search.
 * Pasted absolute paths inside the project root are rewritten to
 * root-relative form so they can match; paths outside the root are left
 * as-is and simply match nothing.
 */
export function buildFileSearchPattern(
  query: string,
  rootPath: string,
): FileSearchPattern {
  if (query === "*") {
    return { pattern: "**/*", effectiveQuery: query };
  }
  let effectiveQuery = query;
  if (path.isAbsolute(query)) {
    const relative = path.relative(rootPath, query);
    if (
      relative &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative)
    ) {
      effectiveQuery = relative.split(path.sep).join("/");
    }
  }
  return {
    pattern: `**/*${toCaseInsensitiveGlob(effectiveQuery)}*`,
    effectiveQuery,
  };
}
