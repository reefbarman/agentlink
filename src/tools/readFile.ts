import type { Dirent } from "fs";
import * as vscode from "vscode";
import * as fs from "fs/promises";
import * as path from "path";

import type {
  ReadFileEnrichmentProvider,
  ReadFileParams,
} from "../core/capabilities/readSearch.js";
import {
  canonicalizePath,
  resolveAndValidatePath,
  isBinaryFile,
  tryGetFirstWorkspaceRoot,
  getWorkspaceRoots,
} from "../util/paths.js";
import type { ApprovalManager } from "../approvals/ApprovalManager.js";
import type { ApprovalPanelProvider } from "../approvals/ApprovalPanelProvider.js";
import { isAgentInstructionReadPath } from "../approvals/protectedPaths.js";
import {
  approveOutsideWorkspaceAccess,
  type GuardianOutsideReadOptions,
} from "./pathAccessUI.js";
import { SYMBOL_KIND_NAMES } from "./languageFeatures.js";
import { Semaphore } from "../util/Semaphore.js";
import { isAgentlinkTmpArtifact } from "../util/agentlinkTmpArtifacts.js";

import type { ToolResult } from "@agentlink/protocol/tool-result";
import { errorResult } from "@agentlink/protocol/tool-result";
import { getSearchInputError } from "../core/tools/searchInputValidation.js";
import {
  convertBmpToPng,
  convertPpmToPng,
  extractPdfText as extractPdfTextFromBytes,
} from "@agentlink/node-host";
import {
  findReadFilePathSuggestions,
  READ_FILE_IMAGE_MIME_TYPES,
  READ_FILE_MAX_IMAGE_BYTES,
  READ_FILE_MAX_PDF_BYTES,
  planReadFileContentWindow,
  readFileImageTooLargeError,
  readFilePdfTooLargeError,
} from "@agentlink/core/read-file-content";
import {
  getStructuredSecretRedactionMetadata,
  isStructuredConfigPath,
  redactStructuredSecrets,
} from "../shared/structuredSecretRedaction.js";

// --- Image support ---

const IMAGE_EXTENSIONS = READ_FILE_IMAGE_MIME_TYPES;

const IMAGE_CONVERTERS: Record<string, (data: Buffer) => Buffer> = {
  ".bmp": convertBmpToPng,
  ".ppm": convertPpmToPng,
};

const MAX_IMAGE_SIZE = READ_FILE_MAX_IMAGE_BYTES;

// --- PDF support ---

const PDF_EXTENSION = ".pdf";
const MAX_PDF_SIZE = READ_FILE_MAX_PDF_BYTES;

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

export function detectLanguage(filePath: string): string | undefined {
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
  status(): Promise<void>;
  state: {
    mergeChanges?: GitChange[];
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

export async function getGitStatus(
  filePath: string,
): Promise<string | undefined> {
  try {
    const gitExtension =
      vscode.extensions.getExtension<GitExtension>("vscode.git");
    if (!gitExtension?.isActive) return undefined;

    const normalizedFilePath = normalizeGitPath(filePath);
    const normalizedLexicalFilePath = normalizeGitPathLexically(filePath);
    const repo = gitExtension.exports
      .getAPI(1)
      .repositories.filter((candidate) =>
        isPathInGitRepository(
          normalizedLexicalFilePath,
          candidate.rootUri.fsPath,
        ),
      )
      .sort(
        (left, right) =>
          normalizeGitPath(right.rootUri.fsPath).length -
          normalizeGitPath(left.rootUri.fsPath).length,
      )[0];
    if (!repo) return undefined;
    await repo.status();

    const hasChange = (changes: GitChange[] | undefined): boolean =>
      changes?.some((change) => {
        const changePath = normalizeGitPathLexically(change.uri.fsPath);
        return (
          changePath === normalizedLexicalFilePath ||
          changePath === normalizedFilePath
        );
      }) ?? false;
    // A conflicted entry can also appear in staged or working-tree lists, so
    // surface it first instead of masking the state that requires resolution.
    if (hasChange(repo.state.mergeChanges)) return "unmerged";
    if (hasChange(repo.state.indexChanges)) return "staged";
    if (hasChange(repo.state.workingTreeChanges)) return "modified";
    if (hasChange(repo.state.untrackedChanges)) return "untracked";
    return "clean";
  } catch {
    return undefined;
  }
}

function normalizeGitPath(filePath: string): string {
  return normalizeGitPathLexically(canonicalizePath(filePath));
}

function normalizeGitPathLexically(filePath: string): string {
  const normalized = path.normalize(path.resolve(filePath));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isPathInGitRepository(filePath: string, repoRoot: string): boolean {
  const relative = path.relative(normalizeGitPathLexically(repoRoot), filePath);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

// --- Diagnostics summary ---

export function getDiagnosticsSummary(filePath: string):
  | {
      errors: number;
      warnings: number;
      sourceFreshness: "unverified";
      openDocumentDirty?: boolean;
    }
  | undefined {
  try {
    const uri = vscode.Uri.file(filePath);
    const diags = vscode.languages.getDiagnostics(uri);
    const openDocument = vscode.workspace.textDocuments.find(
      (document) =>
        document.uri.scheme === "file" && document.uri.fsPath === filePath,
    );
    if (diags.length === 0 && !openDocument?.isDirty) return undefined;

    let errors = 0;
    let warnings = 0;
    for (const d of diags) {
      if (d.severity === vscode.DiagnosticSeverity.Error) errors++;
      else if (d.severity === vscode.DiagnosticSeverity.Warning) warnings++;
    }
    return {
      errors,
      warnings,
      sourceFreshness: "unverified",
      ...(openDocument ? { openDocumentDirty: openDocument.isDirty } : {}),
    };
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

export type SymbolOutlineResult =
  | { symbols: Record<string, string[]> }
  | { timedOut: true }
  | undefined;

function createLegacyReadFileEnrichmentProvider(): ReadFileEnrichmentProvider {
  return {
    getGitStatus,
    detectLanguage,
    getSymbolOutline,
    getDiagnosticsSummary,
  };
}

export async function getSymbolOutline(
  filePath: string,
): Promise<SymbolOutlineResult> {
  try {
    const uri = vscode.Uri.file(filePath);
    const TIMED_OUT = Symbol("timeout");
    const symbols = await Promise.race([
      vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
        "vscode.executeDocumentSymbolProvider",
        uri,
      ),
      new Promise<typeof TIMED_OUT>((resolve) =>
        setTimeout(() => resolve(TIMED_OUT), SYMBOL_TIMEOUT_MS),
      ),
    ]);

    if (symbols === TIMED_OUT) return { timedOut: true };
    if (!symbols || symbols.length === 0) return undefined;

    // Group by kind for token efficiency — avoids repeating "method" 100+ times
    const grouped: Record<string, string[]> = Object.create(null) as Record<
      string,
      string[]
    >;
    for (const s of symbols) {
      const kind = SYMBOL_KIND_NAMES[s.kind] ?? "symbol";
      const line = s.range.start.line + 1;
      (grouped[kind] ??= []).push(`${s.name} (line ${line})`);

      // Recurse one level into container symbols (class → methods, etc.)
      if (CONTAINER_KINDS.has(s.kind) && s.children?.length) {
        for (const child of s.children) {
          const childKind = SYMBOL_KIND_NAMES[child.kind] ?? "symbol";
          const childLine = child.range.start.line + 1;
          (grouped[childKind] ??= []).push(
            `${s.name}.${child.name} (line ${childLine})`,
          );
        }
      }
    }
    return { symbols: grouped };
  } catch {
    return undefined;
  }
}

// --- Friendly errors ---

const DEFAULT_SUGGESTION_DIRECTORY_BUDGET = 200;

export interface PathSuggestionOptions {
  limit?: number;
  directoryBudget?: number;
  workspaceRoot?: string;
}

export async function findLikelyPathSuggestions(
  inputPath: string,
  optionsOrLimit: PathSuggestionOptions | number = {},
): Promise<string[]> {
  const options =
    typeof optionsOrLimit === "number"
      ? { limit: optionsOrLimit }
      : optionsOrLimit;
  const workspaceRoots = options.workspaceRoot
    ? [options.workspaceRoot]
    : getWorkspaceRoots();
  return findReadFilePathSuggestions(inputPath, {
    roots: workspaceRoots,
    readDirectory: async (directory) =>
      ((await fs.readdir(directory, { withFileTypes: true })) as Dirent[]).map(
        (entry) => ({
          name: entry.name,
          isDirectory: entry.isDirectory(),
        }),
      ),
    joinPath: (directory, name) => path.resolve(path.join(directory, name)),
    relativePath: (root, fullPath) =>
      path.relative(root, fullPath).replace(/\\/g, "/"),
    limit: options.limit ?? 5,
    directoryBudget:
      options.directoryBudget ?? DEFAULT_SUGGESTION_DIRECTORY_BUDGET,
  });
}

export async function buildReadFileError(
  err: unknown,
  inputPath: string,
): Promise<Record<string, unknown>> {
  if (!(err instanceof Error)) {
    return { error: String(err), path: inputPath };
  }

  const code = (err as NodeJS.ErrnoException).code;
  switch (code) {
    case "ENOENT": {
      const workspaceRoot = tryGetFirstWorkspaceRoot();
      const suggestions = await findLikelyPathSuggestions(inputPath);
      return {
        error: `File not found: ${inputPath}. Working directory: ${workspaceRoot ?? "(no workspace)"}`,
        path: inputPath,
        ...(suggestions.length > 0 && { suggestions }),
      };
    }
    case "EACCES":
      return { error: `Permission denied: ${inputPath}`, path: inputPath };
    case "EISDIR":
      return {
        error: `${inputPath} is a directory. Use list_files instead.`,
        path: inputPath,
      };
    default:
      return { error: err.message, path: inputPath };
  }
}

// --- Main handler ---

/**
 * Add canonical data/error fields only when read_file returned one JSON text
 * block. Media remains byte-for-byte and field-for-field unchanged.
 */
export function canonicalizeReadFileResult(result: ToolResult): ToolResult {
  if (result.content.length !== 1 || result.content[0]?.type !== "text") {
    return result;
  }
  const text = result.content[0].text;
  let data: unknown;
  try {
    data = JSON.parse(text) as unknown;
  } catch {
    return result;
  }
  const errorMessage =
    data &&
    typeof data === "object" &&
    typeof (data as Record<string, unknown>).error === "string"
      ? ((data as Record<string, unknown>).error as string)
      : undefined;
  return {
    ...result,
    data,
    isError: errorMessage !== undefined,
    ...(errorMessage
      ? { error: result.error ?? { kind: "tool_error", message: errorMessage } }
      : {}),
  };
}

async function extractPdfText(filePath: string): Promise<string> {
  return extractPdfTextFromBytes(await fs.readFile(filePath));
}

async function readPdfFile(
  filePath: string,
  params: {
    path: string;
    offset?: number;
    limit?: number;
  },
): Promise<ToolResult> {
  const stat = await fs.stat(filePath);
  if (stat.size > MAX_PDF_SIZE) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error: readFilePdfTooLargeError(stat.size),
            path: params.path,
          }),
        },
      ],
    };
  }

  const raw = await extractPdfText(filePath);
  const window = planReadFileContentWindow(raw, {
    ...(params.offset !== undefined ? { offset: params.offset } : {}),
    ...(params.limit !== undefined ? { limit: params.limit } : {}),
  });

  if (window.status === "empty") {
    const emptyResult: Record<string, unknown> = {
      total_lines: window.totalLines,
      showing: "0-0",
      content: "",
      path: params.path,
      size: stat.size,
      modified: stat.mtime.toISOString(),
      file_type: "pdf",
    };
    const gitStatus = await getGitStatus(filePath);
    if (gitStatus) emptyResult.git_status = gitStatus;
    return {
      content: [{ type: "text" as const, text: JSON.stringify(emptyResult) }],
    };
  }

  if (window.status === "error") {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ error: window.error, path: params.path }),
        },
      ],
    };
  }

  const result: Record<string, unknown> = {
    total_lines: window.totalLines,
    showing: window.showing,
  };
  if (window.truncated) result.truncated = true;

  result.size = stat.size;
  result.modified = stat.mtime.toISOString();
  const gitStatus = await getGitStatus(filePath);
  if (gitStatus) result.git_status = gitStatus;
  result.file_type = "pdf";
  result.content = window.numbered;

  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
  };
}

export function isEnoentWithSingleSuggestion(
  payload: Record<string, unknown>,
): payload is Record<string, unknown> & {
  suggestions: [string];
  path: string;
  error: string;
} {
  if (!payload || typeof payload !== "object") return false;
  const suggestions = payload.suggestions;
  return (
    Array.isArray(suggestions) &&
    suggestions.length === 1 &&
    typeof suggestions[0] === "string" &&
    typeof payload.path === "string" &&
    typeof payload.error === "string"
  );
}

export interface AdvertisedSkillFileAccess {
  name: string;
  skillPath: string;
}

function normalizePathForContainment(filePath: string): string {
  return path.resolve(filePath);
}

function isPathInDirectory(filePath: string, directory: string): boolean {
  const normalizedFilePath = normalizePathForContainment(filePath);
  const normalizedDirectory = normalizePathForContainment(directory);
  const relative = path.relative(normalizedDirectory, normalizedFilePath);
  return (
    relative === "" ||
    (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function isAdvertisedSkillAssociatedFile(
  filePath: string,
  advertisedSkills: AdvertisedSkillFileAccess[] = [],
): boolean {
  return advertisedSkills.some((skill) => {
    if (!skill.skillPath) return false;
    const skillDirectory = path.dirname(skill.skillPath);
    return isPathInDirectory(filePath, skillDirectory);
  });
}

async function handleReadFileImpl(
  params: ReadFileParams,
  approvalManager: ApprovalManager,
  approvalPanel: ApprovalPanelProvider,
  sessionId: string,
  advertisedSkills: AdvertisedSkillFileAccess[] = [],
  enrichmentProvider = createLegacyReadFileEnrichmentProvider(),
  signal?: AbortSignal,
  guardian?: GuardianOutsideReadOptions,
): Promise<ToolResult> {
  const inputError = getSearchInputError("read_file", params);
  if (inputError) return errorResult(inputError);
  const release = await readSemaphore.acquire();
  let released = false;
  try {
    const { absolutePath: filePath, inWorkspace } = resolveAndValidatePath(
      params.path,
    );

    // Outside-workspace gate — AgentLink tmp artifacts (truncated tool results),
    // exact agent instruction artifacts, and files bundled next to advertised
    // skills are readable without approval. The instruction exemption is exact
    // so it does not grant access to sibling memory, credentials, or config.
    if (
      !inWorkspace &&
      !isAgentlinkTmpArtifact(filePath) &&
      !isAgentInstructionReadPath(filePath) &&
      !isAdvertisedSkillAssociatedFile(filePath, advertisedSkills) &&
      !approvalManager.isPathTrusted(sessionId, filePath)
    ) {
      const { approved, reason } = await approveOutsideWorkspaceAccess(
        filePath,
        approvalManager,
        approvalPanel,
        sessionId,
        signal,
        ...(guardian ? [guardian] : []),
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

    const ext = path.extname(filePath).toLowerCase();
    if (ext === PDF_EXTENSION) {
      return await readPdfFile(filePath, params);
    }

    const imageConverter = IMAGE_CONVERTERS[ext];
    if (imageConverter) {
      const stat = await fs.stat(filePath);
      if (stat.size > MAX_IMAGE_SIZE) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: readFileImageTooLargeError(stat.size),
                path: params.path,
              }),
            },
          ],
        };
      }

      const data = await fs.readFile(filePath);
      const png = imageConverter(data);
      return {
        content: [
          {
            type: "image",
            data: png.toString("base64"),
            mimeType: "image/png",
          },
        ],
      };
    }

    if (isBinaryFile(filePath)) {
      // Check if it's a supported binary format we can return.
      const mimeType = IMAGE_EXTENSIONS[ext];

      if (mimeType) {
        const stat = await fs.stat(filePath);
        if (stat.size > MAX_IMAGE_SIZE) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  error: readFileImageTooLargeError(stat.size),
                  path: params.path,
                }),
              },
            ],
          };
        }
        const data = await fs.readFile(filePath);
        return {
          content: [
            {
              type: "image",
              data: data.toString("base64"),
              mimeType,
            },
          ],
        };
      }

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

    const structuredRedaction = isStructuredConfigPath(filePath)
      ? redactStructuredSecrets(filePath, raw)
      : undefined;
    const visibleRaw = structuredRedaction?.content ?? raw;
    const window = planReadFileContentWindow(visibleRaw, params);

    if (window.status === "error") {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: window.error,
              path: params.path,
            }),
          },
        ],
      };
    }

    if (window.status === "empty") {
      const emptyResult: Record<string, unknown> = {
        total_lines: window.totalLines,
        showing: "0-0",
        content: "",
        path: params.path,
      };
      emptyResult.size = stat.size;
      emptyResult.modified = stat.mtime.toISOString();
      const gitStatus = await enrichmentProvider.getGitStatus(filePath);
      if (gitStatus) emptyResult.git_status = gitStatus;
      emptyResult.language = enrichmentProvider.detectLanguage(filePath);

      const redactionMetadata =
        getStructuredSecretRedactionMetadata(structuredRedaction);
      if (redactionMetadata) emptyResult.redaction = redactionMetadata;
      return {
        content: [{ type: "text" as const, text: JSON.stringify(emptyResult) }],
      };
    }

    // Build response with metadata first, content last
    const result: Record<string, unknown> = {
      total_lines: window.totalLines,
      showing: window.showing,
    };

    // Truncation info — always set when not all lines are shown
    if (window.truncated) {
      result.truncated = true;
    }

    if (window.anchorMatch) {
      result.anchor_match = window.anchorMatch;
    }

    // File metadata
    result.size = stat.size;
    result.modified = stat.mtime.toISOString();
    const redactionMetadata =
      getStructuredSecretRedactionMetadata(structuredRedaction);
    if (redactionMetadata) result.redaction = redactionMetadata;

    // Git status
    const gitStatus = await enrichmentProvider.getGitStatus(filePath);
    if (gitStatus) result.git_status = gitStatus;

    // Detect language early so we can use it for symbol filtering
    const language = enrichmentProvider.detectLanguage(filePath);

    // Symbol outline runs first — it opens the document, which triggers the
    // language server. This makes accurate language detection and diagnostics
    // available as a side effect.
    // Skip symbols for JSON/JSONC — every key becomes a "symbol" which is noisy
    const isDataFile = language === "json" || language === "jsonc";
    if (params.include_symbols !== false && !isDataFile) {
      const symbolResult = await enrichmentProvider.getSymbolOutline(filePath);
      if (symbolResult && "symbols" in symbolResult) {
        result.symbols = symbolResult.symbols;
      } else if (symbolResult && "timedOut" in symbolResult) {
        result.symbols_note =
          "Symbol outline timed out — language server may be busy";
      }
    }

    if (language) result.language = language;

    // Diagnostics — check after symbols so the language server has analyzed the file
    const diagSummary = enrichmentProvider.getDiagnosticsSummary(filePath);
    if (diagSummary) {
      result.diagnostics = {
        errors: diagSummary.errors,
        warnings: diagSummary.warnings,
        note: "Cached language-service counts; source freshness is unverified and counts are not tied to a specific document version.",
        ...(diagSummary.openDocumentDirty !== undefined
          ? {
              open_document_dirty: diagSummary.openDocumentDirty,
              ...(diagSummary.openDocumentDirty
                ? {
                    buffer_note:
                      "The matching file-backed editor is dirty, so its buffer may differ from the disk text returned here.",
                  }
                : {}),
            }
          : {}),
      };
    }

    // Content last so metadata is visible at the top
    result.content = window.numbered;

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    const errorPayload = await buildReadFileError(err, params.path);

    if (
      params.auto_follow_suggestion &&
      isEnoentWithSingleSuggestion(errorPayload)
    ) {
      const [suggestedPath] = errorPayload.suggestions;
      // Release this call's permit before recursively following the suggestion;
      // otherwise concurrent follow-ups can deadlock by double-acquiring.
      release();
      released = true;
      return handleReadFile(
        {
          ...params,
          path: suggestedPath,
          auto_follow_suggestion: false,
        },
        approvalManager,
        approvalPanel,
        sessionId,
        advertisedSkills,
        enrichmentProvider,
      ).then((followed) => {
        const item = followed.content[0];
        if (item?.type !== "text") {
          return followed;
        }
        try {
          const parsed = JSON.parse(item.text) as Record<string, unknown>;
          parsed.resolution = "auto_followed_suggestion";
          parsed.auto_followed_from = errorPayload.path;
          parsed.resolved_path = suggestedPath;
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(parsed, null, 2),
              },
            ],
          };
        } catch {
          return followed;
        }
      });
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(errorPayload),
        },
      ],
    };
  } finally {
    if (!released) {
      release();
    }
  }
}

export async function handleReadFile(
  params: ReadFileParams,
  approvalManager: ApprovalManager,
  approvalPanel: ApprovalPanelProvider,
  sessionId: string,
  advertisedSkills: AdvertisedSkillFileAccess[] = [],
  enrichmentProvider = createLegacyReadFileEnrichmentProvider(),
  signal?: AbortSignal,
  guardian?: GuardianOutsideReadOptions,
): Promise<ToolResult> {
  return canonicalizeReadFileResult(
    await handleReadFileImpl(
      params,
      approvalManager,
      approvalPanel,
      sessionId,
      advertisedSkills,
      enrichmentProvider,
      signal,
      guardian,
    ),
  );
}
