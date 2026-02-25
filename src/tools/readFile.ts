import * as vscode from "vscode";
import * as fs from "fs/promises";
import * as path from "path";

import {
  resolveAndValidatePath,
  isBinaryFile,
  getFirstWorkspaceRoot,
} from "../util/paths.js";
import type { ApprovalManager } from "../approvals/ApprovalManager.js";
import type { ApprovalPanelProvider } from "../approvals/ApprovalPanelProvider.js";
import { approveOutsideWorkspaceAccess } from "./pathAccessUI.js";
import { SYMBOL_KIND_NAMES } from "./languageFeatures.js";
import { Semaphore } from "../util/Semaphore.js";

type ToolResult = { content: Array<{ type: "text"; text: string }> };

// --- Concurrency control ---
// Concurrent read_file calls can overwhelm VS Code's language server
// (symbol outline requests are single-threaded). Limit concurrency to
// prevent hangs when Claude reads many large files in parallel.
const READ_CONCURRENCY = 5;
const SYMBOL_TIMEOUT_MS = 5_000; // 5 seconds

const readSemaphore = new Semaphore(READ_CONCURRENCY);

// --- Language detection ---

const EXTENSION_LANGUAGE_MAP: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescriptreact",
  ".js": "javascript",
  ".jsx": "javascriptreact",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".json": "json",
  ".jsonc": "jsonc",
  ".py": "python",
  ".rs": "rust",
  ".go": "go",
  ".java": "java",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".cxx": "cpp",
  ".hpp": "cpp",
  ".cs": "csharp",
  ".rb": "ruby",
  ".php": "php",
  ".swift": "swift",
  ".r": "r",
  ".R": "r",
  ".lua": "lua",
  ".sh": "shellscript",
  ".bash": "shellscript",
  ".zsh": "shellscript",
  ".fish": "shellscript",
  ".ps1": "powershell",
  ".html": "html",
  ".htm": "html",
  ".css": "css",
  ".scss": "scss",
  ".sass": "sass",
  ".less": "less",
  ".vue": "vue",
  ".svelte": "svelte",
  ".md": "markdown",
  ".mdx": "mdx",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "toml",
  ".xml": "xml",
  ".sql": "sql",
  ".graphql": "graphql",
  ".gql": "graphql",
  ".dockerfile": "dockerfile",
  ".docker": "dockerfile",
  ".tf": "terraform",
  ".hcl": "terraform",
  ".proto": "proto3",
  ".zig": "zig",
  ".dart": "dart",
  ".elm": "elm",
  ".ex": "elixir",
  ".exs": "elixir",
  ".erl": "erlang",
  ".hs": "haskell",
  ".ml": "ocaml",
  ".mli": "ocaml",
  ".scala": "scala",
  ".clj": "clojure",
  ".cljs": "clojure",
  ".nim": "nim",
  ".v": "v",
  ".sol": "solidity",
  ".mod": "go.mod",
  ".sum": "go.sum",
  ".work": "go.work",
  ".lock": "plaintext",
  ".env": "dotenv",
  ".ini": "ini",
  ".cfg": "ini",
  ".conf": "properties",
  ".properties": "properties",
  ".makefile": "makefile",
  ".cmake": "cmake",
  ".bat": "bat",
  ".cmd": "bat",
};

function detectLanguage(filePath: string): string | undefined {
  // Check already-open documents first (zero cost, exact language ID)
  const openDoc = vscode.workspace.textDocuments.find(
    (doc) => doc.uri.scheme === "file" && doc.uri.fsPath === filePath,
  );
  if (openDoc) {
    return openDoc.languageId;
  }

  // Fall back to extension map
  const ext = path.extname(filePath).toLowerCase();
  // Handle Dockerfile (no extension)
  if (path.basename(filePath).toLowerCase() === "dockerfile") {
    return "dockerfile";
  }
  return EXTENSION_LANGUAGE_MAP[ext];
}

// --- Git status ---

// Minimal inline types for VS Code's built-in git extension API
interface GitChange {
  uri: vscode.Uri;
  status: number;
}
interface GitRepository {
  state: {
    indexChanges: GitChange[];
    workingTreeChanges: GitChange[];
    untrackedChanges?: GitChange[];
  };
  rootUri: vscode.Uri;
}
interface GitAPI {
  repositories: GitRepository[];
}
interface GitExtension {
  getAPI(version: 1): GitAPI;
}

function getGitStatus(filePath: string): string | undefined {
  try {
    const gitExtension =
      vscode.extensions.getExtension<GitExtension>("vscode.git");
    if (!gitExtension?.isActive) return undefined;

    const api = gitExtension.exports.getAPI(1);

    // Find the repo that contains this file
    for (const repo of api.repositories) {
      const repoRoot = repo.rootUri.fsPath;
      if (!filePath.startsWith(repoRoot)) continue;

      // Check staged (index) changes
      if (repo.state.indexChanges.some((c) => c.uri.fsPath === filePath)) {
        return "staged";
      }

      // Check working tree changes (modified)
      if (
        repo.state.workingTreeChanges.some((c) => c.uri.fsPath === filePath)
      ) {
        return "modified";
      }

      // Check untracked
      if (repo.state.untrackedChanges?.some((c) => c.uri.fsPath === filePath)) {
        return "untracked";
      }

      // File is in a repo but not changed
      return "clean";
    }

    return undefined; // Not in any git repo
  } catch {
    return undefined;
  }
}

// --- Diagnostics summary ---

function getDiagnosticsSummary(
  filePath: string,
): { errors: number; warnings: number } | undefined {
  try {
    const uri = vscode.Uri.file(filePath);
    const diags = vscode.languages.getDiagnostics(uri);
    if (diags.length === 0) return undefined;

    let errors = 0;
    let warnings = 0;
    for (const d of diags) {
      if (d.severity === vscode.DiagnosticSeverity.Error) errors++;
      else if (d.severity === vscode.DiagnosticSeverity.Warning) warnings++;
    }
    return { errors, warnings };
  } catch {
    return undefined;
  }
}

// --- Symbol outline ---

// Symbol kinds that are containers — recurse one level to show their children
const CONTAINER_KINDS = new Set([
  vscode.SymbolKind.Class,
  vscode.SymbolKind.Interface,
  vscode.SymbolKind.Enum,
  vscode.SymbolKind.Struct,
  vscode.SymbolKind.Namespace,
  vscode.SymbolKind.Module,
]);

async function getSymbolOutline(
  filePath: string,
): Promise<Record<string, string[]> | undefined> {
  try {
    const uri = vscode.Uri.file(filePath);
    const symbols = await Promise.race([
      vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
        "vscode.executeDocumentSymbolProvider",
        uri,
      ),
      new Promise<undefined>((resolve) =>
        setTimeout(() => resolve(undefined), SYMBOL_TIMEOUT_MS),
      ),
    ]);

    if (!symbols || symbols.length === 0) return undefined;

    // Group by kind for token efficiency — avoids repeating "method" 100+ times
    const grouped: Record<string, string[]> = {};
    for (const s of symbols) {
      const kind = SYMBOL_KIND_NAMES[s.kind] ?? "symbol";
      const line = s.range.start.line + 1;
      if (!grouped[kind]) grouped[kind] = [];
      grouped[kind].push(`${s.name} (line ${line})`);

      // Recurse one level into container symbols (class → methods, etc.)
      if (CONTAINER_KINDS.has(s.kind) && s.children?.length) {
        for (const child of s.children) {
          const childKind = SYMBOL_KIND_NAMES[child.kind] ?? "symbol";
          const childLine = child.range.start.line + 1;
          if (!grouped[childKind]) grouped[childKind] = [];
          grouped[childKind].push(`${s.name}.${child.name} (line ${childLine})`);
        }
      }
    }
    return grouped;
  } catch {
    return undefined;
  }
}

// --- Friendly errors ---

function friendlyError(err: unknown, inputPath: string): string {
  if (!(err instanceof Error)) return String(err);

  const code = (err as NodeJS.ErrnoException).code;
  switch (code) {
    case "ENOENT":
      return `File not found: ${inputPath}. Working directory: ${getFirstWorkspaceRoot()}`;
    case "EACCES":
      return `Permission denied: ${inputPath}`;
    case "EISDIR":
      return `${inputPath} is a directory. Use list_files instead.`;
    default:
      return err.message;
  }
}

// --- Main handler ---

export async function handleReadFile(
  params: {
    path: string;
    offset?: number;
    limit?: number;
    include_symbols?: boolean;
  },
  approvalManager: ApprovalManager,
  approvalPanel: ApprovalPanelProvider,
  sessionId: string,
): Promise<ToolResult> {
  const release = await readSemaphore.acquire();
  try {
    const { absolutePath: filePath, inWorkspace } = resolveAndValidatePath(
      params.path,
    );

    // Outside-workspace gate
    if (!inWorkspace && !approvalManager.isPathTrusted(sessionId, filePath)) {
      const { approved, reason } = await approveOutsideWorkspaceAccess(
        filePath,
        approvalManager,
        approvalPanel,
        sessionId,
      );
      if (!approved) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status: "rejected",
                path: params.path,
                ...(reason && { reason }),
              }),
            },
          ],
        };
      }
    }

    if (isBinaryFile(filePath)) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: "Binary file detected",
              path: params.path,
            }),
          },
        ],
      };
    }

    // Read file and stat in parallel
    const [raw, stat] = await Promise.all([
      fs.readFile(filePath, "utf-8"),
      fs.stat(filePath),
    ]);

    const allLines = raw.split("\n");
    const totalLines = allLines.length;

    const offset = Math.max(1, params.offset ?? 1);
    if (offset > totalLines) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              total_lines: totalLines,
              error: `Offset ${offset} exceeds total lines (${totalLines})`,
              path: params.path,
            }),
          },
        ],
      };
    }

    const defaultLimit = 2000;
    const limit = Math.min(
      params.limit ?? defaultLimit,
      totalLines - offset + 1,
    );

    const lines = allLines.slice(offset - 1, offset - 1 + limit);

    const numbered = lines
      .map((line, i) => {
        const lineNum = offset + i;
        return `${lineNum} | ${line}`;
      })
      .join("\n");

    // Build response with metadata first, content last
    const result: Record<string, unknown> = {
      total_lines: totalLines,
      showing: `${offset}-${offset + lines.length - 1}`,
    };

    // Truncation info — always set when not all lines are shown
    const showingAll = offset === 1 && lines.length === totalLines;
    if (!showingAll) {
      result.truncated = true;
    }

    // File metadata
    result.size = stat.size;
    result.modified = stat.mtime.toISOString();

    // Git status
    const gitStatus = getGitStatus(filePath);
    if (gitStatus) result.git_status = gitStatus;

    // Detect language early so we can use it for symbol filtering
    const language = detectLanguage(filePath);

    // Symbol outline runs first — it opens the document, which triggers the
    // language server. This makes accurate language detection and diagnostics
    // available as a side effect.
    // Skip symbols for JSON/JSONC — every key becomes a "symbol" which is noisy
    const isDataFile = language === "json" || language === "jsonc";
    if (params.include_symbols !== false && !isDataFile) {
      const symbols = await getSymbolOutline(filePath);
      if (symbols) result.symbols = symbols;
    }

    if (language) result.language = language;

    // Diagnostics — check after symbols so the language server has analyzed the file
    const diagSummary = getDiagnosticsSummary(filePath);
    if (diagSummary) result.diagnostics = diagSummary;

    // Content last so metadata is visible at the top
    result.content = numbered;

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error: friendlyError(err, params.path),
            path: params.path,
          }),
        },
      ],
    };
  } finally {
    release();
  }
}
