import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { ApprovalManager } from "../approvals/ApprovalManager.js";
import type { ApprovalPanelProvider } from "../approvals/ApprovalPanelProvider.js";
import type { ToolCallTracker } from "./ToolCallTracker.js";
import { handleReadFile } from "../tools/readFile.js";
import { handleListFiles } from "../tools/listFiles.js";
import { handleSearchFiles } from "../tools/searchFiles.js";
import { handleGetDiagnostics } from "../tools/getDiagnostics.js";
import { handleWriteFile } from "../tools/writeFile.js";
import { handleApplyDiff } from "../tools/applyDiff.js";
import { handleExecuteCommand } from "../tools/executeCommand.js";
import { handleGoToDefinition } from "../tools/goToDefinition.js";
import { handleGetReferences } from "../tools/getReferences.js";
import { handleGetSymbols } from "../tools/getSymbols.js";
import { handleGetHover } from "../tools/getHover.js";
import { handleGetCompletions } from "../tools/getCompletions.js";
import { handleOpenFile } from "../tools/openFile.js";
import { handleShowNotification } from "../tools/showNotification.js";
import { handleRenameSymbol } from "../tools/renameSymbol.js";
import { handleCloseTerminals } from "../tools/closeTerminals.js";

export function registerTools(
  server: McpServer,
  approvalManager: ApprovalManager,
  approvalPanel: ApprovalPanelProvider,
  getSessionId: () => string | undefined,
  tracker: ToolCallTracker,
): void {
  const sid = () => getSessionId() ?? "unknown";
  const touch = () => approvalManager.touchSession(sid());

  // --- Read-only tools ---

  server.tool(
    "read_file",
    "Read the contents of a file with line numbers. Returns content in 'line_number | content' format. Includes file metadata (size, modified, language), git status, and diagnostics summary when available.",
    {
      path: z
        .string()
        .describe("File path (absolute or relative to workspace root)"),
      offset: z
        .number()
        .optional()
        .describe("Starting line number (1-indexed, default: 1)"),
      limit: z
        .number()
        .optional()
        .describe("Maximum number of lines to read (default: 2000)"),
      include_symbols: z
        .boolean()
        .optional()
        .describe(
          "Include top-level symbol outline (functions, classes, interfaces). Default: true. Set to false to suppress.",
        ),
    },
    { readOnlyHint: true, openWorldHint: false },
    tracker.wrapHandler(
      "read_file",
      (params) => {
        touch();
        return handleReadFile(params, approvalManager, approvalPanel, sid());
      },
      (p) => String(p.path ?? ""),
      sid,
    ),
  );

  server.tool(
    "list_files",
    "List files and directories at a given path. Directories have a trailing '/' suffix.",
    {
      path: z
        .string()
        .describe("Directory path (absolute or relative to workspace root)"),
      recursive: z
        .boolean()
        .optional()
        .describe("List recursively (default: false)"),
      depth: z
        .number()
        .optional()
        .describe(
          "Maximum directory depth for recursive listing (e.g. 2 for two levels deep). Only used when recursive=true.",
        ),
    },
    { readOnlyHint: true, openWorldHint: false },
    tracker.wrapHandler(
      "list_files",
      (params) => {
        touch();
        return handleListFiles(params, approvalManager, approvalPanel, sid());
      },
      (p) => String(p.path ?? ""),
      sid,
    ),
  );

  server.tool(
    "search_files",
    "Search file contents using regex, or perform semantic codebase search. Default: fast ripgrep regex search with context lines. When semantic=true, uses vector similarity search against the codebase index — 'regex' is interpreted as a natural language query in this mode.",
    {
      path: z
        .string()
        .describe(
          "Directory to search in (absolute or relative to workspace root)",
        ),
      regex: z
        .string()
        .describe(
          "Regular expression pattern for regex search, or natural language query for semantic search",
        ),
      file_pattern: z
        .string()
        .optional()
        .describe(
          "Glob pattern to filter files (e.g. '*.ts'). Only used for regex search.",
        ),
      semantic: z
        .boolean()
        .optional()
        .describe(
          "Use semantic/vector search instead of regex. Requires codebase index (Roo Code) and OpenAI API key. Default: false",
        ),
    },
    { readOnlyHint: true, openWorldHint: false },
    tracker.wrapHandler(
      "search_files",
      (params) => {
        touch();
        return handleSearchFiles(
          params,
          approvalManager,
          approvalPanel,
          sid(),
        );
      },
      (p) => String(p.regex ?? "").slice(0, 60),
      sid,
    ),
  );

  server.tool(
    "get_diagnostics",
    "Get VS Code diagnostics (errors, warnings) for a file or the entire workspace.",
    {
      path: z
        .string()
        .optional()
        .describe(
          "File path to get diagnostics for (omit for all workspace diagnostics)",
        ),
      severity: z
        .string()
        .optional()
        .describe(
          "Comma-separated severity filter (e.g. 'error', 'error,warning'). Options: error, warning, info/information, hint. Default: all severities.",
        ),
    },
    { readOnlyHint: true, openWorldHint: false },
    tracker.wrapHandler(
      "get_diagnostics",
      (params) => {
        touch();
        return handleGetDiagnostics(params);
      },
      (p) => String(p.path ?? "workspace"),
      sid,
    ),
  );

  // --- Language intelligence tools ---

  server.tool(
    "go_to_definition",
    "Resolve the definition location of a symbol using VS Code's language server. Returns the file path and position where the symbol is defined. Works across files and languages.",
    {
      path: z
        .string()
        .describe("File path (absolute or relative to workspace root)"),
      line: z.number().describe("Line number (1-indexed)"),
      column: z.number().describe("Column number (1-indexed)"),
    },
    { readOnlyHint: true, openWorldHint: false },
    tracker.wrapHandler(
      "go_to_definition",
      (params) => {
        touch();
        return handleGoToDefinition(
          params,
          approvalManager,
          approvalPanel,
          sid(),
        );
      },
      (p) => `${p.path}:${p.line}`,
      sid,
    ),
  );

  server.tool(
    "get_references",
    "Find all references to a symbol using VS Code's language server. Returns locations across the workspace where the symbol is used.",
    {
      path: z
        .string()
        .describe("File path (absolute or relative to workspace root)"),
      line: z.number().describe("Line number (1-indexed)"),
      column: z.number().describe("Column number (1-indexed)"),
      include_declaration: z
        .boolean()
        .optional()
        .describe("Include the declaration itself in results (default: true)"),
    },
    { readOnlyHint: true, openWorldHint: false },
    tracker.wrapHandler(
      "get_references",
      (params) => {
        touch();
        return handleGetReferences(
          params,
          approvalManager,
          approvalPanel,
          sid(),
        );
      },
      (p) => `${p.path}:${p.line}`,
      sid,
    ),
  );

  server.tool(
    "get_symbols",
    "Get symbols from a document or search workspace symbols. Provide 'path' for document symbols (full hierarchy with children) or 'query' for workspace-wide symbol search. Returns symbol names, kinds, and locations.",
    {
      path: z
        .string()
        .optional()
        .describe(
          "File path for document symbols (absolute or relative to workspace root)",
        ),
      query: z
        .string()
        .optional()
        .describe(
          "Search query for workspace-wide symbol search. Used when path is omitted.",
        ),
    },
    { readOnlyHint: true, openWorldHint: false },
    tracker.wrapHandler(
      "get_symbols",
      (params) => {
        touch();
        return handleGetSymbols(
          params,
          approvalManager,
          approvalPanel,
          sid(),
        );
      },
      (p) => String(p.path ?? p.query ?? ""),
      sid,
    ),
  );

  server.tool(
    "get_hover",
    "Get hover information (inferred types, documentation) for a symbol at a specific position. Uses VS Code's language server to provide the same information shown when hovering in the editor.",
    {
      path: z
        .string()
        .describe("File path (absolute or relative to workspace root)"),
      line: z.number().describe("Line number (1-indexed)"),
      column: z.number().describe("Column number (1-indexed)"),
    },
    { readOnlyHint: true, openWorldHint: false },
    tracker.wrapHandler(
      "get_hover",
      (params) => {
        touch();
        return handleGetHover(params, approvalManager, approvalPanel, sid());
      },
      (p) => `${p.path}:${p.line}`,
      sid,
    ),
  );

  server.tool(
    "get_completions",
    "Get autocomplete suggestions at a cursor position. Uses VS Code's language server to provide completion items — useful for discovering available methods, properties, and APIs.",
    {
      path: z
        .string()
        .describe("File path (absolute or relative to workspace root)"),
      line: z.number().describe("Line number (1-indexed)"),
      column: z.number().describe("Column number (1-indexed)"),
      limit: z
        .number()
        .optional()
        .describe("Maximum number of completion items to return (default: 50)"),
    },
    { readOnlyHint: true, openWorldHint: false },
    tracker.wrapHandler(
      "get_completions",
      (params) => {
        touch();
        return handleGetCompletions(
          params,
          approvalManager,
          approvalPanel,
          sid(),
        );
      },
      (p) => `${p.path}:${p.line}`,
      sid,
    ),
  );

  // --- Editor actions ---

  server.tool(
    "open_file",
    "Open a file in the VS Code editor, optionally scrolling to a specific line and column. The file becomes visible to the user in the editor.",
    {
      path: z
        .string()
        .describe("File path (absolute or relative to workspace root)"),
      line: z
        .number()
        .optional()
        .describe("Line number to scroll to (1-indexed)"),
      column: z
        .number()
        .optional()
        .describe(
          "Column number for cursor placement (1-indexed, requires line)",
        ),
    },
    { readOnlyHint: true, openWorldHint: false },
    tracker.wrapHandler(
      "open_file",
      (params) => {
        touch();
        return handleOpenFile(params, approvalManager, approvalPanel, sid());
      },
      (p) => String(p.path ?? ""),
      sid,
    ),
  );

  server.tool(
    "show_notification",
    "Show a notification message in VS Code. Use sparingly — best for important status updates or completion of long-running tasks.",
    {
      message: z.string().describe("The notification message to display"),
      type: z
        .enum(["info", "warning", "error"])
        .optional()
        .describe("Notification type (default: 'info')"),
    },
    { readOnlyHint: true, openWorldHint: false },
    tracker.wrapHandler(
      "show_notification",
      (params) => {
        touch();
        return handleShowNotification(params);
      },
      (p) => String(p.message ?? "").slice(0, 60),
      sid,
    ),
  );

  // --- Write tools (diff-view based) ---

  server.tool(
    "write_file",
    "Create a new file or overwrite an existing file. Opens a diff view in VS Code for the user to review, optionally edit, and accept or reject the changes. Benefits from VS Code's format-on-save. Returns any user edits and new diagnostics.",
    {
      path: z
        .string()
        .describe("File path (absolute or relative to workspace root)"),
      content: z.string().describe("Complete file content to write"),
    },
    {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    tracker.wrapHandler(
      "write_file",
      (params) => {
        touch();
        return handleWriteFile(params, approvalManager, approvalPanel, sid());
      },
      (p) => String(p.path ?? ""),
      sid,
    ),
  );

  server.tool(
    "apply_diff",
    "Edit an existing file using search/replace blocks. Opens a diff view for user review. Each SEARCH block must match exactly one location. Supports multiple hunks in a single call — include multiple SEARCH/REPLACE blocks to make several edits at once. Format:\n<<<<<<< SEARCH\nexact content to find\n======= DIVIDER =======\nreplacement content\n>>>>>>> REPLACE",
    {
      path: z
        .string()
        .describe("File path (absolute or relative to workspace root)"),
      diff: z
        .string()
        .describe(
          "Search/replace blocks in <<<<<<< SEARCH / ======= DIVIDER ======= / >>>>>>> REPLACE format",
        ),
    },
    { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    tracker.wrapHandler(
      "apply_diff",
      (params) => {
        touch();
        return handleApplyDiff(params, approvalManager, approvalPanel, sid());
      },
      (p) => String(p.path ?? ""),
      sid,
    ),
  );

  // --- Terminal ---

  server.tool(
    "rename_symbol",
    "Rename a symbol across the workspace using VS Code's language server. Performs a precise rename refactoring that updates all references, imports, and re-exports. Shows affected files for approval before applying.",
    {
      path: z
        .string()
        .describe(
          "File path containing the symbol (absolute or relative to workspace root)",
        ),
      line: z.number().describe("Line number of the symbol (1-indexed)"),
      column: z.number().describe("Column number of the symbol (1-indexed)"),
      new_name: z.string().describe("The new name for the symbol"),
    },
    { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    tracker.wrapHandler(
      "rename_symbol",
      (params) => {
        touch();
        return handleRenameSymbol(
          params,
          approvalManager,
          approvalPanel,
          sid(),
        );
      },
      (p) => String(p.new_name ?? ""),
      sid,
    ),
  );

  server.tool(
    "execute_command",
    "Run a command in VS Code's integrated terminal. The terminal is visible to the user. Output is captured when shell integration is available.\n\nTerminal reuse: By default, reuses an existing idle terminal — do NOT pass terminal_name or terminal_id for normal commands. Only use terminal_name when you need a genuinely separate terminal for parallel execution (e.g. a background dev server running alongside normal commands). Do not create named terminals for one-off commands.\n\nTerminal splitting: Use split_from with a terminal_id or terminal_name to create a new terminal split alongside an existing one, forming a visual group in VS Code's terminal panel. Only affects new terminal creation — if the target terminal_name already exists and is idle, it is reused without re-splitting.\n\nOutput is capped to the last 200 lines by default. Full output is saved to a temp file (returned as output_file) for on-demand access via read_file. Use output_head, output_tail, or output_grep to customize filtering. IMPORTANT: Commands that pipe through head, tail, or grep (e.g. `cmd | head -5`) will be automatically REJECTED. Use the output_head, output_tail, and output_grep parameters instead — they filter the output returned to you while keeping the full output visible to the user in the terminal.",
    {
      command: z.string().describe("Shell command to execute"),
      cwd: z
        .string()
        .optional()
        .describe("Working directory (absolute or relative to workspace root)"),
      terminal_id: z
        .string()
        .optional()
        .describe(
          "Run in a specific terminal by ID (returned from previous commands)",
        ),
      terminal_name: z
        .string()
        .optional()
        .describe(
          "Run in a named terminal (e.g. 'Server', 'Build', 'Tests'). Creates if it doesn't exist. Enables parallel execution in separate terminals.",
        ),
      split_from: z
        .string()
        .optional()
        .describe(
          "Split the new terminal alongside an existing terminal (by terminal_id or terminal_name), creating a visual group. Only takes effect when a new terminal is created — ignored if terminal_name matches an existing idle terminal. Example: start a backend server with terminal_name='Backend', then use split_from='Backend' with terminal_name='Frontend' to group them side-by-side.",
        ),
      background: z
        .boolean()
        .optional()
        .describe(
          "Run without waiting for completion. Use for long-running processes like dev servers. Returns immediately with terminal_id.",
        ),
      timeout: z
        .number()
        .optional()
        .describe(
          "Timeout in seconds. If set, command output is returned when the timeout is reached, but the command may still be running in the terminal. If omitted, waits indefinitely for the command to finish. IMPORTANT: Always set a timeout for commands you expect to complete quickly (e.g. git, ls, cat, grep, npm test — use 10-30s). This prevents the session from hanging if a command unexpectedly blocks. Only omit timeout for long-running processes where you explicitly want to wait indefinitely.",
        ),
      output_head: z
        .number()
        .optional()
        .describe(
          "Return only the first N lines of output. Overrides the default 200-line tail cap.",
        ),
      output_tail: z
        .number()
        .optional()
        .describe(
          "Return only the last N lines of output. Overrides the default 200-line tail cap.",
        ),
      output_offset: z
        .number()
        .optional()
        .describe(
          'Skip first N lines/entries before applying head/tail, equivalent to "| tail -n +N | head -N". Works across all output modes. Defaults to 0.',
        ),
      output_grep: z
        .string()
        .optional()
        .describe(
          "Filter output to lines matching this regex pattern (case-insensitive). Applied before head/tail. Use this instead of piping through grep.",
        ),
      output_grep_context: z
        .number()
        .optional()
        .describe(
          "Number of context lines around each grep match (like grep -C). Only used with output_grep.",
        ),
    },
    { readOnlyHint: false, openWorldHint: true },
    tracker.wrapHandler(
      "execute_command",
      (params, ctx) => {
        touch();
        return handleExecuteCommand(
          params,
          approvalManager,
          approvalPanel,
          sid(),
          ctx,
        );
      },
      (p) => String(p.command ?? "").slice(0, 80),
      sid,
    ),
  );

  server.tool(
    "codebase_search",
    'Search the codebase by meaning, not exact text. Uses the Qdrant vector index (built by Roo Code) to find code semantically similar to your natural language query. Best for exploratory questions like "how does authentication work" or "where are database connections configured". Falls back gracefully with a helpful error if the index is not available.',
    {
      query: z
        .string()
        .describe(
          "Natural language query describing what you're looking for (e.g. 'error handling in API routes', 'how files get uploaded')",
        ),
      path: z
        .string()
        .optional()
        .describe(
          "Directory to scope the search to (absolute or relative to workspace root). Omit to search the entire workspace.",
        ),
    },
    { readOnlyHint: true, openWorldHint: false },
    tracker.wrapHandler(
      "codebase_search",
      async (params) => {
        touch();
        const { semanticSearch } = await import(
          "../services/semanticSearch.js"
        );
        const { resolveAndValidatePath, getFirstWorkspaceRoot } = await import(
          "../util/paths.js"
        );
        const dirPath = params.path
          ? resolveAndValidatePath(String(params.path)).absolutePath
          : getFirstWorkspaceRoot();
        return semanticSearch(dirPath, String(params.query));
      },
      (p) => String(p.query ?? "").slice(0, 60),
      sid,
    ),
  );

  server.tool(
    "close_terminals",
    "Close managed terminals to clean up clutter. With no arguments, closes all terminals created by native-claude. Pass specific names to close only those (e.g. ['Server'] to close a background dev server terminal).",
    {
      names: z
        .array(z.string())
        .optional()
        .describe(
          "Terminal names to close (e.g. ['Server', 'Tests']). Omit to close all managed terminals.",
        ),
    },
    {
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: false,
    },
    tracker.wrapHandler(
      "close_terminals",
      (params) => {
        touch();
        return handleCloseTerminals(params);
      },
      (p) =>
        Array.isArray(p.names) ? (p.names as string[]).join(", ") : "all",
      sid,
    ),
  );
}
