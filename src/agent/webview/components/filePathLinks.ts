export interface MatchedFilePath {
  fullMatch: string;
  filePath: string;
  line?: number;
  index: number;
}

// Matches file and directory path candidates like `src/foo.ts`, `/abs/path.ts`,
// `src/foo.ts:42`, `@src/foo.ts`, `src/agent/webview/`, and `@src/agent/webview`.
const FILE_PATH_RE =
  /(^|[^@.:/\w-])(@?((?:\/[\w.-]+(?:\/[\w.-]+)+\/?|(?:\.?[\w][\w.-]*)(?:\/[\w.-]+)+\/?))(?::(\d+)(?:-\d+)?)?)/g;

const TRAILING_PATH_PUNCTUATION_RE = /[),.;!?]+$/;
const FILE_EXTENSION_RE = /(?:^|\/)\.?[^/]+\.\w{1,8}$/;
const COMMON_REPO_PATH_ROOTS = new Set([
  ".agentlink",
  ".github",
  ".vscode",
  "app",
  "apps",
  "bin",
  "config",
  "docs",
  "examples",
  "fixtures",
  "lib",
  "media",
  "packages",
  "plans",
  "resources",
  "scripts",
  "src",
  "test",
  "tests",
  "tools",
  "webview",
]);

function slashCount(path: string): number {
  return path.match(/\//g)?.length ?? 0;
}

function isLikelyPath(path: string, fullMatch: string): boolean {
  if (FILE_EXTENSION_RE.test(path.replace(/\/$/, ""))) return true;
  if (path.endsWith("/")) return true;
  if (path.startsWith("/")) return true;
  if (fullMatch.startsWith("@")) return true;

  const [root] = path.split("/");
  return Boolean(
    root && COMMON_REPO_PATH_ROOTS.has(root) && slashCount(path) >= 1,
  );
}

export function matchFilePaths(text: string): MatchedFilePath[] {
  const matches: MatchedFilePath[] = [];
  FILE_PATH_RE.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = FILE_PATH_RE.exec(text)) !== null) {
    const prefix = match[1] ?? "";
    let fullMatch = match[2];
    let filePath = match[3];
    const line = match[4] ? parseInt(match[4], 10) : undefined;
    const trailingPunctuation = filePath.match(TRAILING_PATH_PUNCTUATION_RE);
    if (trailingPunctuation) {
      filePath = filePath.slice(0, -trailingPunctuation[0].length);
      fullMatch = fullMatch.slice(0, -trailingPunctuation[0].length);
    }
    if (!isLikelyPath(filePath, fullMatch)) continue;
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
