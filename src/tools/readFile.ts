import * as vscode from "vscode";
import * as fs from "fs/promises";
import * as path from "path";

import {
  resolveAndValidatePath,
  isBinaryFile,
  getFirstWorkspaceRoot,
} from "../util/paths.js";
import type { ApprovalManager } from "../approvals/ApprovalManager.js";
import { approveOutsideWorkspaceAccess } from "./pathAccessUI.js";

type ToolResult = { content: Array<{ type: "text"; text: string }> };

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
      if (
        repo.state.indexChanges.some((c) => c.uri.fsPath === filePath)
      ) {
        return "staged";
      }

      // Check working tree changes (modified)
      if (
        repo.state.workingTreeChanges.some((c) => c.uri.fsPath === filePath)
      ) {
        return "modified";
      }

      // Check untracked
      if (
        repo.state.untrackedChanges?.some((c) => c.uri.fsPath === filePath)
      ) {
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

const SYMBOL_KIND_NAMES: Record<number, string> = {
  [vscode.SymbolKind.File]: "file",
  [vscode.SymbolKind.Module]: "module",
  [vscode.SymbolKind.Namespace]: "namespace",
  [vscode.SymbolKind.Package]: "package",
  [vscode.SymbolKind.Class]: "class",
  [vscode.SymbolKind.Method]: "method",
  [vscode.SymbolKind.Property]: "property",
  [vscode.SymbolKind.Field]: "field",
  [vscode.SymbolKind.Constructor]: "constructor",
  [vscode.SymbolKind.Enum]: "enum",
  [vscode.SymbolKind.Interface]: "interface",
  [vscode.SymbolKind.Function]: "function",
  [vscode.SymbolKind.Variable]: "variable",
  [vscode.SymbolKind.Constant]: "constant",
  [vscode.SymbolKind.String]: "string",
  [vscode.SymbolKind.Number]: "number",
  [vscode.SymbolKind.Boolean]: "boolean",
  [vscode.SymbolKind.Array]: "array",
  [vscode.SymbolKind.Object]: "object",
  [vscode.SymbolKind.Key]: "key",
  [vscode.SymbolKind.Null]: "null",
  [vscode.SymbolKind.EnumMember]: "enum member",
  [vscode.SymbolKind.Struct]: "struct",
  [vscode.SymbolKind.Event]: "event",
  [vscode.SymbolKind.Operator]: "operator",
  [vscode.SymbolKind.TypeParameter]: "type parameter",
};

async function getSymbolOutline(
  filePath: string,
): Promise<Record<string, string[]> | undefined> {
  try {
    const uri = vscode.Uri.file(filePath);
    const symbols = await vscode.commands.executeCommand<
      vscode.DocumentSymbol[]
    >("vscode.executeDocumentSymbolProvider", uri);

    if (!symbols || symbols.length === 0) return undefined;

    // Group by kind for token efficiency — avoids repeating "method" 100+ times
    const grouped: Record<string, string[]> = {};
    for (const s of symbols) {
      const kind = SYMBOL_KIND_NAMES[s.kind] ?? "symbol";
      const line = s.range.start.line + 1;
      if (!grouped[kind]) grouped[kind] = [];
      grouped[kind].push(`${s.name} (line ${line})`);
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
  sessionId: string,
): Promise<ToolResult> {
  try {
    const { absolutePath: filePath, inWorkspace } = resolveAndValidatePath(
      params.path,
    );

    // Outside-workspace gate
    if (!inWorkspace && !approvalManager.isPathTrusted(sessionId, filePath)) {
      const { approved, reason } = await approveOutsideWorkspaceAccess(
        filePath,
        approvalManager,
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

    // Symbol outline runs first — it opens the document, which triggers the
    // language server. This makes accurate language detection and diagnostics
    // available as a side effect.
    if (params.include_symbols !== false) {
      const symbols = await getSymbolOutline(filePath);
      if (symbols) result.symbols = symbols;
    }

    // Language — check after symbols so the document is likely open
    const language = detectLanguage(filePath);
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
  }
}
