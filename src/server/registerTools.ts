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
    "execute_command",
    "Run a command in VS Code's integrated terminal. The terminal is visible to the user. Output is captured when shell integration is available. Use terminal_name to run commands in separate named terminals (e.g. 'Server', 'Tests'). Use background for long-running processes like dev servers.",
    {
      command: z.string().describe("Shell command to execute"),
      cwd: z.string().optional().describe("Working directory (absolute or relative to workspace root)"),
      terminal_id: z.string().optional().describe("Run in a specific terminal by ID (returned from previous commands)"),
      terminal_name: z.string().optional().describe("Run in a named terminal (e.g. 'Server', 'Build', 'Tests'). Creates if it doesn't exist. Enables parallel execution in separate terminals."),
      background: z.boolean().optional().describe("Run without waiting for completion. Use for long-running processes like dev servers. Returns immediately with terminal_id."),
      timeout: z.number().optional().describe("Timeout in seconds (default: 60). Command output is returned when the timeout is reached, but the command may still be running in the terminal."),
    },
    (params) => { touch(); return handleExecuteCommand(params, approvalManager, sid()); }
  );
}
