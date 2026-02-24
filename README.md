# Native Claude

A VS Code extension that acts as an [MCP](https://modelcontextprotocol.io/) server, giving Claude Code direct access to native VS Code capabilities — diff-based file editing, integrated terminal, real diagnostics, symbol outlines, git status, and more.

## Why?

Claude Code's built-in tools (`Read`, `Edit`, `Write`, `Bash`, `Grep`, `Glob`) operate at the filesystem level — they have no awareness of your editor. Native Claude replaces them with tools that work _through_ VS Code, unlocking capabilities that are impossible with raw filesystem access.

### What you get over built-in tools

| Capability                | Built-in tools              | Native Claude                                                                                                                                                                                    |
| ------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **File editing**          | Writes directly to disk     | Opens a **diff view** — you see exactly what's changing, can edit inline, and accept or reject. Format-on-save applies automatically.                                                            |
| **Terminal commands**     | Runs in a hidden subprocess | Runs in VS Code's **integrated terminal** — visible, interactive, with shell integration for output capture. Supports named terminals, parallel tasks, and **split terminal groups**.            |
| **Diagnostics**           | Not available               | Real **TypeScript errors, ESLint warnings**, etc. from VS Code's language services — returned after writes and available on-demand.                                                              |
| **File reading**          | Raw file content            | Content plus **file metadata** (size, modified date), **language detection**, **git status**, **diagnostics summary**, and **symbol outlines** (functions, classes, interfaces grouped by kind). |
| **Search**                | `grep`/`rg` via subprocess  | Same ripgrep engine, plus optional **semantic vector search** against an indexed codebase.                                                                                                       |
| **File listing**          | `find`/`ls` via subprocess  | Native listing with ripgrep's `--files` mode for fast recursive listing with automatic `.gitignore` support.                                                                                     |
| **Language intelligence** | Not available               | **Go to definition**, **find references**, **hover types**, **completions**, **symbols**, and **rename** — all powered by VS Code's language server.                                             |
| **Approval system**       | All-or-nothing permissions  | **Granular approval** — per-file write rules, per-command pattern matching, outside-workspace path trust with prefix/glob/exact patterns.                                                        |
| **Rejection reasons**     | Silent rejection            | When you reject a write or command, you can provide a **reason** that's returned to Claude so it can adjust its approach.                                                                        |

## Installation

### Install script (recommended)

Download and install the latest release from GitHub:

```sh
curl -sL https://raw.githubusercontent.com/reefbarman/native-claude/main/scripts/install.sh | bash
```

Or clone the repo first and run it locally:

```sh
./scripts/install.sh
```

### Manual download

1. Go to the [latest release](https://github.com/reefbarman/native-claude/releases/latest)
2. Download the `.vsix` file
3. Install it:
   ```sh
   code --install-extension native-claude-*.vsix --force
   ```

### Build from source

```sh
git clone https://github.com/reefbarman/native-claude.git
cd native-claude
npm install && npm run build
npx @vscode/vsce package --no-dependencies --allow-star-activation
code --install-extension native-claude-*.vsix --force
```

After installing, reload VS Code. The MCP server starts automatically and configures `~/.claude.json`.

## Quick Start

1. Install the extension (see [Installation](#installation))
2. The MCP server starts automatically and configures `~/.claude.json`
3. Start Claude Code — it will pick up the `native-claude` MCP server

The sidebar panel shows server status, active tool calls, and approval rules. If auto-configuration doesn't work, use the sidebar buttons to copy the config or run the CLI setup command.

### Configuring Claude Code

For best results, add instructions to your `~/.claude/CLAUDE.md` (global) or project-level `CLAUDE.md` telling Claude to prefer Native Claude tools over built-ins. A comprehensive example is included in the repo:

```sh
cp CLAUDE.md.example ~/.claude/CLAUDE.md
```

This covers tool mappings, usage notes, and descriptions of the additional language server tools. Review and edit it to fit your setup — for example, you may want to merge it with existing instructions in your `CLAUDE.md`.

## Tools

### read_file

Read file contents with line numbers. Returns rich metadata that built-in `Read` cannot provide.

| Parameter         | Type     | Description                                        |
| ----------------- | -------- | -------------------------------------------------- |
| `path`            | string   | File path (absolute or relative to workspace root) |
| `offset`          | number?  | Starting line number (1-indexed, default: 1)       |
| `limit`           | number?  | Maximum lines to read (default: 2000)              |
| `include_symbols` | boolean? | Include top-level symbol outline (default: true)   |

**Response includes:**

- `total_lines`, `showing`, `truncated` — pagination info
- `size` (bytes), `modified` (ISO timestamp) — file metadata
- `language` — detected from open document or file extension (~80 extensions mapped)
- `git_status` — `"staged"`, `"modified"`, `"untracked"`, or `"clean"` (via VS Code's git extension)
- `diagnostics` — `{ errors: N, warnings: N }` summary from language services
- `symbols` — top-level symbols grouped by kind (e.g. `{ "function": ["foo (line 1)"], "class": ["Bar (line 20)"] }`)
- `content` — numbered lines in `line_number | content` format

Fields like `git_status`, `diagnostics`, and `symbols` are omitted when not available rather than returned as null.

**Friendly errors:** `ENOENT` → `"File not found: {path}. Working directory: {root}"`, `EACCES` → `"Permission denied"`, `EISDIR` → `"Use list_files instead"`.

### list_files

List files and directories. Directories have a trailing `/` suffix.

| Parameter   | Type     | Description                               |
| ----------- | -------- | ----------------------------------------- |
| `path`      | string   | Directory path                            |
| `recursive` | boolean? | List recursively (default: false)         |
| `depth`     | number?  | Max directory depth for recursive listing |

Recursive listing uses ripgrep (`--files` mode) for speed and automatic `.gitignore` support.

### search_files

Search file contents using regex or semantic vector search.

| Parameter      | Type     | Description                                                   |
| -------------- | -------- | ------------------------------------------------------------- |
| `path`         | string   | Directory to search in                                        |
| `regex`        | string   | Regex pattern, or natural language query when `semantic=true` |
| `file_pattern` | string?  | Glob to filter files (e.g. `*.ts`)                            |
| `semantic`     | boolean? | Use vector similarity search instead of regex                 |

Regex search is powered by ripgrep with context lines and per-file match counts. Semantic search queries a Qdrant vector index (see [Semantic Search](#semantic-search)).

### get_diagnostics

Get VS Code diagnostics (errors, warnings, etc.) for a file or the entire workspace.

| Parameter  | Type    | Description                                                |
| ---------- | ------- | ---------------------------------------------------------- |
| `path`     | string? | File path (omit for all workspace diagnostics)             |
| `severity` | string? | Comma-separated filter: `error`, `warning`, `info`, `hint` |

### write_file

Create or overwrite a file. Opens a **diff view** in VS Code for the user to review, optionally edit, and accept or reject. Benefits from format-on-save. Returns any user edits as a patch and new diagnostics.

| Parameter | Type   | Description           |
| --------- | ------ | --------------------- |
| `path`    | string | File path             |
| `content` | string | Complete file content |

### apply_diff

Edit an existing file using search/replace blocks. Opens a diff view for review. Supports **multiple hunks** in a single call.

| Parameter | Type   | Description                              |
| --------- | ------ | ---------------------------------------- |
| `path`    | string | File path                                |
| `diff`    | string | Search/replace blocks (see format below) |

```text
replacement content
```

Include multiple SEARCH/REPLACE blocks for multiple edits in one call.

### go_to_definition

Resolve the definition location of a symbol using VS Code's language server. Works across files and languages.

| Parameter | Type   | Description                                        |
| --------- | ------ | -------------------------------------------------- |
| `path`    | string | File path (absolute or relative to workspace root) |
| `line`    | number | Line number (1-indexed)                            |
| `column`  | number | Column number (1-indexed)                          |

Returns an array of `definitions`, each with `path`, `line`, `column`, `endLine`, `endColumn`. Handles both `Location` and `LocationLink` results from the language server.

### get_references

Find all references to a symbol using VS Code's language server. Returns locations across the workspace where the symbol is used.

| Parameter             | Type     | Description                                               |
| --------------------- | -------- | --------------------------------------------------------- |
| `path`                | string   | File path (absolute or relative to workspace root)        |
| `line`                | number   | Line number (1-indexed)                                   |
| `column`              | number   | Column number (1-indexed)                                 |
| `include_declaration` | boolean? | Include the declaration itself in results (default: true) |

Returns `total_references`, `truncated` (capped at 200), and a `references` array with the same location format as `go_to_definition`.

### get_symbols

Get symbols from a document or search workspace symbols. Two modes:

| Parameter | Type    | Description                                                                 |
| --------- | ------- | --------------------------------------------------------------------------- |
| `path`    | string? | File path for document symbols (full hierarchy with children)               |
| `query`   | string? | Search query for workspace-wide symbol search (used when `path` is omitted) |

**Document mode** (`path` provided): Returns the full symbol tree with `name`, `kind`, `line`, `endLine`, and recursive `children[]`.

**Workspace mode** (`query` provided): Returns a flat list of matching symbols with `name`, `kind`, `path`, `line`, `containerName`. Capped at 100 results.

### get_hover

Get hover information (inferred types, documentation) for a symbol at a specific position. Provides the same information shown when hovering in the VS Code editor.

| Parameter | Type   | Description                                        |
| --------- | ------ | -------------------------------------------------- |
| `path`    | string | File path (absolute or relative to workspace root) |
| `line`    | number | Line number (1-indexed)                            |
| `column`  | number | Column number (1-indexed)                          |

Returns `hover` as a string (type info, documentation) or `null` if no hover info is available.

### get_completions

Get autocomplete suggestions at a cursor position. Useful for discovering available methods, properties, and APIs.

| Parameter | Type    | Description                                                |
| --------- | ------- | ---------------------------------------------------------- |
| `path`    | string  | File path (absolute or relative to workspace root)         |
| `line`    | number  | Line number (1-indexed)                                    |
| `column`  | number  | Column number (1-indexed)                                  |
| `limit`   | number? | Maximum number of completion items to return (default: 50) |

Returns `is_incomplete`, `total_items`, `showing`, and an `items` array with `label`, `kind`, `detail`, `documentation`, and `insertText` (when different from label).

### open_file

Open a file in the VS Code editor, optionally scrolling to a specific line and placing the cursor.

| Parameter | Type    | Description                                        |
| --------- | ------- | -------------------------------------------------- |
| `path`    | string  | File path (absolute or relative to workspace root) |
| `line`    | number? | Line number to scroll to (1-indexed)               |
| `column`  | number? | Column for cursor placement (1-indexed)            |

### show_notification

Show a notification message in VS Code. Best for important status updates or completion of long-running tasks.

| Parameter | Type    | Description                                     |
| --------- | ------- | ----------------------------------------------- |
| `message` | string  | The notification message to display             |
| `type`    | string? | `info`, `warning`, or `error` (default: `info`) |

### rename_symbol

Rename a symbol across the workspace using VS Code's language server. Performs a precise rename refactoring that updates all references, imports, and re-exports.

| Parameter  | Type   | Description                             |
| ---------- | ------ | --------------------------------------- |
| `path`     | string | File path containing the symbol         |
| `line`     | number | Line number of the symbol (1-indexed)   |
| `column`   | number | Column number of the symbol (1-indexed) |
| `new_name` | string | The new name for the symbol             |

Shows affected files for approval before applying. Uses the same write approval flow as `write_file` — the user can accept once, for the session, for the project, or always.

### codebase_search

Search the codebase by meaning using vector similarity. Pass a natural language query and get ranked code chunks. Best for exploratory questions like "how does authentication work" or "where are database connections configured".

| Parameter | Type    | Description                                                        |
| --------- | ------- | ------------------------------------------------------------------ |
| `query`   | string  | Natural language query describing what you're looking for          |
| `path`    | string? | Directory to scope the search to (omit to search entire workspace) |

Requires a Qdrant vector index (built by Roo Code) and an OpenAI API key. See [Semantic Search](#semantic-search).

### execute_command

Run a command in VS Code's integrated terminal. Output is captured when shell integration is available. Terminal environment is configured to prevent interactive pagers (`PAGER=cat`, `GIT_PAGER=cat`, etc.).

Output is capped to the **last 200 lines** by default to prevent context window bloat. Full output is saved to a temp file (returned as `output_file`) for on-demand access via `read_file`. Use `output_head`, `output_tail`, or `output_grep` to customize filtering — agents should use these instead of piping through `grep`/`tail`/`head` in the command itself, which hides output from the user.

| Parameter             | Type     | Description                                                                                                                                 |
| --------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `command`             | string   | Shell command to execute                                                                                                                    |
| `cwd`                 | string?  | Working directory                                                                                                                           |
| `terminal_id`         | string?  | Reuse a specific terminal by ID                                                                                                             |
| `terminal_name`       | string?  | Run in a named terminal (e.g. `Server`, `Tests`)                                                                                            |
| `split_from`          | string?  | Split alongside an existing terminal (by `terminal_id` or `terminal_name`), creating a visual group                                         |
| `background`          | boolean? | Fire-and-forget for long-running processes                                                                                                  |
| `timeout`             | number?  | Timeout in seconds (default: 60)                                                                                                            |
| `output_head`         | number?  | Return only the first N lines of output. Overrides the default 200-line tail cap.                                                           |
| `output_tail`         | number?  | Return only the last N lines of output. Overrides the default 200-line tail cap.                                                            |
| `output_offset`       | number?  | Skip first N lines before applying head/tail. Use with `output_head` for line ranges (e.g. `offset: 290, head: 21` → lines 290-310).        |
| `output_grep`         | string?  | Filter output to lines matching this regex pattern (case-insensitive). Applied before offset/head/tail.                                     |
| `output_grep_context` | number?  | Number of context lines around each grep match (like `grep -C`). Non-contiguous groups are separated by `--`. Only used with `output_grep`. |

**Response includes:**

- `output` — filtered/capped command output
- `exit_code` — process exit code (null if unavailable)
- `output_captured` — whether shell integration captured the output
- `terminal_id` — terminal ID for reuse in subsequent commands
- `total_lines` — total line count of the full output (before filtering)
- `lines_shown` — number of lines in the returned `output`
- `output_file` — path to temp file with full output (only present when output was truncated; omitted for outputs ≤ 10 MB threshold or when all lines fit)

### close_terminals

Close managed terminals to clean up clutter. With no arguments, closes all terminals created by native-claude. Pass specific names to close only those.

| Parameter | Type      | Description                                                                      |
| --------- | --------- | -------------------------------------------------------------------------------- |
| `names`   | string[]? | Terminal names to close (e.g. `["Server", "Tests"]`). Omit to close all managed. |

## Sidebar

The sidebar (click the Native Claude icon in the activity bar) provides a live overview of the extension and controls for managing active tool calls and approval rules.

### Sections

- **Tool Calls** — Shows all in-progress MCP tool calls with elapsed time. Each call has **Complete** and **Cancel** buttons. Complete captures partial output and interrupts the process; Cancel sends SIGINT (Ctrl+C) and force-resolves with a cancellation result. Completed calls remain visible in a dimmed state for a few seconds before fading out.
- **Server Status** — MCP server state (running/stopped, port, session count, auth, master bypass) with start/stop controls and links to settings, output log, and config files.
- **Claude Code Integration** — Shows whether `~/.claude.json` is configured, with buttons for CLI setup, copying the CLI command, or copying the JSON config.
- **Write Approval** — Current write approval mode (prompt/session/project/global) with reset button. Shows file-level write rules (settings, global, project, session scopes) with inline edit and delete.
- **Trusted Paths** — Outside-workspace path trust rules (global, project, session scopes) with inline edit and delete.
- **Trusted Commands** — Command pattern rules (global, project, session scopes) with inline edit and delete, plus an "Add Rule" button.
- **Available Tools** — Quick reference list of all registered MCP tools.

### Tool Call Tracking

Every MCP tool call is tracked from start to finish. The sidebar's Tool Calls section lets you intervene in long-running operations:

- **Complete** — For `execute_command`: captures current terminal output, sends Ctrl+C to stop the process, and returns partial results. For `write_file`/`apply_diff`: auto-accepts the pending diff view. For other tools: force-resolves immediately.
- **Cancel** — Sends Ctrl+C to any linked terminal, cancels any pending approval dialog, rejects any pending diff view, and returns a cancellation result to Claude.

The Output log (accessible from the sidebar) shows detailed lifecycle events for each tool call: `START`, `END`, `WAITING_APPROVAL`, `TERMINAL_ASSIGNED`, `CANCEL`, `COMPLETE`, etc.

## Approval System

Native Claude includes a granular approval system to keep you in control.

### Write Approval

When Claude proposes file changes (`write_file` or `apply_diff`), a diff view opens with **Accept** (checkmark), **Options** (...), and **Reject** (X) buttons in the editor title bar.

- **Accept** — saves the changes
- **Options** — accept for the current session or always, with optional file pattern rules
- **Reject** — discards the changes, with optional rejection reason returned to Claude

User edits made in the diff view before accepting are captured and returned to Claude as a patch, so it can see what you changed.

#### File-Level Write Rules

When accepting writes via Options, you can scope the approval:

- **All files** — blanket approval for all writes
- **This file** — only auto-approve this specific file
- **Custom pattern** — define a prefix, exact, or glob pattern to match files

Rules can be scoped to the current session or saved permanently. Manage them from the sidebar.

### Command Approval

When Claude runs a command via `execute_command`, a modal dialog shows the command with options:

- **Run Once** — execute without saving a rule
- **Accept for Session** — save a trusted pattern for this session
- **Accept Always** — save a trusted pattern permanently
- **Reject** — block the command, with optional rejection reason

When saving a pattern, a pattern editor opens pre-filled with the command. You can edit the text and choose a match mode:

- **Prefix Match** — trust commands starting with the pattern (e.g. `npm` matches `npm install`, `npm test`)
- **Exact Match** — trust only this exact command
- **Regex Match** — trust commands matching a regex

### Outside-Workspace Path Access

When a tool accesses a file outside the workspace, a **modal dialog** prompts for approval:

- **Allow Once** — permit this single access
- **Allow for Session** — save a path trust rule for the session
- **Always Allow** — save a path trust rule permanently

For session/always rules, a pattern editor opens pre-filled with the parent directory. You can choose prefix, exact, or glob matching.

### Managing Rules

The sidebar shows all global and session rules for writes, commands, and trusted paths. You can:

- **Click a rule** or the edit icon to modify its pattern and match mode
- **Click the X** to delete a rule
- **Add rules** manually via the sidebar button
- **Clear** session rules individually or all at once

### Master Bypass

Set `native-claude.masterBypass` to `true` in settings to skip all approval prompts. Both file writes and commands are auto-approved. Use with caution.

## Semantic Search

Native Claude can query a [Qdrant](https://qdrant.tech/) vector index for semantic code search. This is designed to share the index built by [Roo Code](https://github.com/RooVetGit/Roo-Code) — Native Claude doesn't build its own index, it queries the existing one.

### Setup

1. Have Roo Code index your codebase (Roo Code Settings > Codebase Indexing)
2. Enable in settings:

| Setting                               | Default                 | Description                                             |
| ------------------------------------- | ----------------------- | ------------------------------------------------------- |
| `native-claude.semanticSearchEnabled` | `false`                 | Enable semantic search                                  |
| `native-claude.qdrantUrl`             | `http://localhost:6333` | Qdrant server URL                                       |
| `native-claude.openaiApiKey`          | `""`                    | OpenAI API key (falls back to `OPENAI_API_KEY` env var) |

3. Use `search_files` with `semantic: true` — the `regex` parameter is interpreted as a natural language query

## Multi-Window Support

Each VS Code window runs its own independent MCP server on its own port. The extension writes a `.mcp.json` file to each workspace folder root so that Claude Code instances running in that directory connect to the correct window.

- **No port conflicts** — if the configured port is already in use, the extension falls back to an OS-assigned port automatically.
- **Correct window routing** — terminals, diffs, and approval dialogs appear in the window that owns the workspace, not a random window.
- **Automatic lifecycle** — `.mcp.json` is created on server start and cleaned up on server stop/window close. If the file already contains other MCP server entries, they are preserved.

The global `~/.claude.json` config is still updated as a fallback for running Claude Code outside of any workspace folder.

> **Tip:** Add `.mcp.json` to your `.gitignore` if you don't want the auto-generated config committed to version control.

## Settings

| Setting                          | Default | Description                                                                       |
| -------------------------------- | ------- | --------------------------------------------------------------------------------- |
| `native-claude.port`             | `0`     | HTTP port for the MCP server (`0` = OS-assigned, recommended for multi-window)    |
| `native-claude.autoStart`        | `true`  | Auto-start server on activation                                                   |
| `native-claude.requireAuth`      | `true`  | Require Bearer token auth                                                         |
| `native-claude.masterBypass`     | `false` | Skip all approval prompts                                                         |
| `native-claude.approvalPosition` | `panel` | Where to show approval dialogs: `beside` (split editor) or `panel` (bottom panel) |
| `native-claude.diagnosticDelay`  | `1500`  | Max ms to wait for diagnostics after save                                         |
| `native-claude.writeRules`       | `[]`    | Glob patterns for auto-approved file writes (settings-level)                      |

## Architecture

- **Transport**: Streamable HTTP on `127.0.0.1` (localhost only, no network exposure)
- **Per-session isolation**: Each MCP session gets its own `McpServer` + `StreamableHTTPServerTransport` pair
- **Session recovery**: Stale session IDs (e.g. after extension reload) are transparently reused instead of returning 404 errors
- **Auth**: Optional Bearer token stored in VS Code's `globalState`, auto-written to `~/.claude.json` with atomic write (temp file + rename)
- **Sidebar**: Preact-based webview with `postMessage` state bridge — no full HTML replacement, all updates are incremental via VDOM diffing
- **Bundled**: Dual esbuild targets — extension (CJS/Node) and sidebar webview (ESM/browser with JSX). No runtime dependencies beyond VS Code and Preact (~3KB)

## Development

```sh
npm install
npm run build     # one-shot build
npm run watch     # rebuild on change
```

Press F5 in VS Code to launch the Extension Development Host for testing.
