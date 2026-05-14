export interface MatchedFilePath {
  fullMatch: string;
  filePath: string;
  line?: number;
  index: number;
}

// Matches file paths like `src/foo/bar.ts`, `/abs/path.ts`, `src/foo.ts:42`, `@src/foo.ts`
const FILE_PATH_RE =
  /(^|[^@.:/\w-])(@?((?:(?:\/[\w.-]+)+|[\w][\w-]*(?:\/[\w.-]+)+)\.\w{1,8})(?::(\d+)(?:-\d+)?)?)/g;

export function matchFilePaths(text: string): MatchedFilePath[] {
  const matches: MatchedFilePath[] = [];
  FILE_PATH_RE.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = FILE_PATH_RE.exec(text)) !== null) {
    const prefix = match[1] ?? "";
    const fullMatch = match[2];
    const filePath = match[3];
    const line = match[4] ? parseInt(match[4], 10) : undefined;
    const index = match.index + prefix.length;

    matches.push({
      fullMatch,
      filePath,
      line,
      index,
    });
  }

  return matches;
}
