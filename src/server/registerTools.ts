import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { ApprovalManager } from "../approvals/ApprovalManager.js";
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

export function registerTools(
  server: McpServer,
  approvalManager: ApprovalManager,
  getSessionId: () => string | undefined
): void {
  const sid = () => getSessionId() ?? "unknown";
  const touch = () => approvalManager.touchSession(sid());

  // --- Read-only tools ---

  server.tool(
    "read_file",
    "Read the contents of a file with line numbers. Returns content in 'line_number | content' format. Includes file metadata (size, modified, language), git status, and diagnostics summary when available.",
    {
      path: z.string().describe("File path (absolute or relative to workspace root)"),
      offset: z.number().optional().describe("Starting line number (1-indexed, default: 1)"),
      limit: z.number().optional().describe("Maximum number of lines to read (default: 2000)"),
      include_symbols: z.boolean().optional().describe("Include top-level symbol outline (functions, classes, interfaces). Default: true. Set to false to suppress."),
    },
    (params) => { touch(); return handleReadFile(params, approvalManager, sid()); }
  );

  server.tool(
    "list_files",
    "List files and directories at a given path. Directories have a trailing '/' suffix.",
    {
      path: z.string().describe("Directory path (absolute or relative to workspace root)"),
      recursive: z.boolean().optional().describe("List recursively (default: false)"),
      depth: z.number().optional().describe("Maximum directory depth for recursive listing (e.g. 2 for two levels deep). Only used when recursive=true."),
    },
    (params) => { touch(); return handleListFiles(params, approvalManager, sid()); }
  );

  server.tool(
    "search_files",
    "Search file contents using regex, or perform semantic codebase search. Default: fast ripgrep regex search with context lines. When semantic=true, uses vector similarity search against the codebase index — 'regex' is interpreted as a natural language query in this mode.",
    {
      path: z.string().describe("Directory to search in (absolute or relative to workspace root)"),
      regex: z.string().describe("Regular expression pattern for regex search, or natural language query for semantic search"),
      file_pattern: z.string().optional().describe("Glob pattern to filter files (e.g. '*.ts'). Only used for regex search."),
      semantic: z.boolean().optional().describe("Use semantic/vector search instead of regex. Requires codebase index (Roo Code) and OpenAI API key. Default: false"),
    },
    (params) => { touch(); return handleSearchFiles(params, approvalManager, sid()); }
  );

  server.tool(
    "get_diagnostics",
    "Get VS Code diagnostics (errors, warnings) for a file or the entire workspace.",
    {
      path: z.string().optional().describe("File path to get diagnostics for (omit for all workspace diagnostics)"),
      severity: z.string().optional().describe("Comma-separated severity filter (e.g. 'error', 'error,warning'). Options: error, warning, info/information, hint. Default: all severities."),
    },
    (params) => { touch(); return handleGetDiagnostics(params); }
  );

  // --- Language intelligence tools ---

  server.tool(
    "go_to_definition",
    "Resolve the definition location of a symbol using VS Code's language server. Returns the file path and position where the symbol is defined. Works across files and languages.",
    {
      path: z.string().describe("File path (absolute or relative to workspace root)"),
      line: z.number().describe("Line number (1-indexed)"),
      column: z.number().describe("Column number (1-indexed)"),
    },
    (params) => { touch(); return handleGoToDefinition(params, approvalManager, sid()); }
  );

  server.tool(
    "get_references",
    "Find all references to a symbol using VS Code's language server. Returns locations across the workspace where the symbol is used.",
    {
      path: z.string().describe("File path (absolute or relative to workspace root)"),
      line: z.number().describe("Line number (1-indexed)"),
      column: z.number().describe("Column number (1-indexed)"),
      include_declaration: z.boolean().optional().describe("Include the declaration itself in results (default: true)"),
    },
    (params) => { touch(); return handleGetReferences(params, approvalManager, sid()); }
  );

  server.tool(
    "get_symbols",
    "Get symbols from a document or search workspace symbols. Provide 'path' for document symbols (full hierarchy with children) or 'query' for workspace-wide symbol search. Returns symbol names, kinds, and locations.",
    {
      path: z.string().optional().describe("File path for document symbols (absolute or relative to workspace root)"),
      query: z.string().optional().describe("Search query for workspace-wide symbol search. Used when path is omitted."),
    },
    (params) => { touch(); return handleGetSymbols(params, approvalManager, sid()); }
  );

  server.tool(
    "get_hover",
    "Get hover information (inferred types, documentation) for a symbol at a specific position. Uses VS Code's language server to provide the same information shown when hovering in the editor.",
    {
      path: z.string().describe("File path (absolute or relative to workspace root)"),
      line: z.number().describe("Line number (1-indexed)"),
      column: z.number().describe("Column number (1-indexed)"),
    },
    (params) => { touch(); return handleGetHover(params, approvalManager, sid()); }
  );

  server.tool(
    "get_completions",
    "Get autocomplete suggestions at a cursor position. Uses VS Code's language server to provide completion items — useful for discovering available methods, properties, and APIs.",
    {
      path: z.string().describe("File path (absolute or relative to workspace root)"),
      line: z.number().describe("Line number (1-indexed)"),
      column: z.number().describe("Column number (1-indexed)"),
      limit: z.number().optional().describe("Maximum number of completion items to return (default: 50)"),
    },
    (params) => { touch(); return handleGetCompletions(params, approvalManager, sid()); }
  );

  // --- Editor actions ---

  server.tool(
    "open_file",
    "Open a file in the VS Code editor, optionally scrolling to a specific line and column. The file becomes visible to the user in the editor.",
    {
      path: z.string().describe("File path (absolute or relative to workspace root)"),
      line: z.number().optional().describe("Line number to scroll to (1-indexed)"),
      column: z.number().optional().describe("Column number for cursor placement (1-indexed, requires line)"),
    },
    (params) => { touch(); return handleOpenFile(params, approvalManager, sid()); }
  );

  server.tool(
    "show_notification",
    "Show a notification message in VS Code. Use sparingly — best for important status updates or completion of long-running tasks.",
    {
      message: z.string().describe("The notification message to display"),
      type: z.enum(["info", "warning", "error"]).optional().describe("Notification type (default: 'info')"),
    },
    (params) => { touch(); return handleShowNotification(params); }
  );

  // --- Write tools (diff-view based) ---

  server.tool(
    "write_file",
    "Create a new file or overwrite an existing file. Opens a diff view in VS Code for the user to review, optionally edit, and accept or reject the changes. Benefits from VS Code's format-on-save. Returns any user edits and new diagnostics.",
    {
      path: z.string().describe("File path (absolute or relative to workspace root)"),
      content: z.string().describe("Complete file content to write"),
    },
    (params) => { touch(); return handleWriteFile(params, approvalManager, sid()); }
  );

  server.tool(
    "apply_diff",
    "Edit an existing file using search/replace blocks. Opens a diff view for user review. Each SEARCH block must match exactly one location. Supports multiple hunks in a single call — include multiple SEARCH/REPLACE blocks to make several edits at once. Format:\n<<<<<<< SEARCH\nexact content to find\n=======\nreplacement content\n>>>>>>> REPLACE",
    {
      path: z.string().describe("File path (absolute or relative to workspace root)"),
      diff: z.string().describe("Search/replace blocks in <<<<<<< SEARCH / ======= / >>>>>>> REPLACE format"),
    },
    (params) => { touch(); return handleApplyDiff(params, approvalManager, sid()); }
  );

  // --- Terminal ---

  server.tool(
    "rename_symbol",
    "Rename a symbol across the workspace using VS Code's language server. Performs a precise rename refactoring that updates all references, imports, and re-exports. Shows affected files for approval before applying.",
    {
      path: z.string().describe("File path containing the symbol (absolute or relative to workspace root)"),
      line: z.number().describe("Line number of the symbol (1-indexed)"),
      column: z.number().describe("Column number of the symbol (1-indexed)"),
      new_name: z.string().describe("The new name for the symbol"),
    },
    (params) => { touch(); return handleRenameSymbol(params, approvalManager, sid()); }
  );


  server.tool(
    "execute_command",
    "Run a command in VS Code's integrated terminal. The terminal is visible to the user. Output is captured when shell integration is available. Use terminal_name to run commands in separate named terminals (e.g. 'Server', 'Tests'). Use background for long-running processes like dev servers.\n\nOutput is capped to the last 200 lines by default. Full output is saved to a temp file (returned as output_file) for on-demand access via read_file. Use output_head, output_tail, or output_grep to customize filtering — do NOT pipe through grep/tail/head in the command itself, as that hides output from the user.",
    {
      command: z.string().describe("Shell command to execute"),
      cwd: z.string().optional().describe("Working directory (absolute or relative to workspace root)"),
      terminal_id: z.string().optional().describe("Run in a specific terminal by ID (returned from previous commands)"),
      terminal_name: z.string().optional().describe("Run in a named terminal (e.g. 'Server', 'Build', 'Tests'). Creates if it doesn't exist. Enables parallel execution in separate terminals."),
      background: z.boolean().optional().describe("Run without waiting for completion. Use for long-running processes like dev servers. Returns immediately with terminal_id."),
      timeout: z.number().optional().describe("Timeout in seconds. If set, command output is returned when the timeout is reached, but the command may still be running in the terminal. If omitted, waits indefinitely for the command to finish."),
      output_head: z.number().optional().describe("Return only the first N lines of output. Overrides the default 200-line tail cap."),
      output_tail: z.number().optional().describe("Return only the last N lines of output. Overrides the default 200-line tail cap."),
      output_offset: z.number().optional().describe("Skip first N lines/entries before applying head/tail, equivalent to \"| tail -n +N | head -N\". Works across all output modes. Defaults to 0."),
      output_grep: z.string().optional().describe("Filter output to lines matching this regex pattern (case-insensitive). Applied before head/tail. Use this instead of piping through grep."),
      output_grep_context: z.number().optional().describe("Number of context lines around each grep match (like grep -C). Only used with output_grep."),
    },
    (params) => { touch(); return handleExecuteCommand(params, approvalManager, sid()); }
  );
}
