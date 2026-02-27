# Native Claude

A VS Code extension that acts as an [MCP](https://modelcontextprotocol.io/) server, giving Claude Code direct access to native VS Code capabilities — diff-based file editing, integrated terminal, real diagnostics, symbol outlines, git status, and more.

## Why?

Claude Code's built-in tools (`Read`, `Edit`, `Write`, `Bash`, `Grep`, `Glob`) operate at the filesystem level — they have no awareness of your editor. Native Claude replaces them with tools that work _through_ VS Code, unlocking capabilities that are impossible with raw filesystem access.

### What you get over built-in tools

| Capability                | Built-in tools              | Native Claude                                                                                                                                                                                                                        |
| ------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **File editing**          | Writes directly to disk     | Opens a **diff view** — you see exactly what's changing, can edit inline, and accept or reject. Format-on-save applies automatically.                                                                                                |
| **Terminal commands**     | Runs in a hidden subprocess | Runs in VS Code's **integrated terminal** — visible, interactive, with shell integration for output capture. Supports named terminals, parallel tasks, and **split terminal groups**.                                                |
| **Diagnostics**           | Not available               | Real **TypeScript errors, ESLint warnings**, etc. from VS Code's language services — returned after writes and available on-demand.                                                                                                  |
| **File reading**          | Raw file content            | Content plus **file metadata** (size, modified date), **language detection**, **git status**, **diagnostics summary**, and **symbol outlines** (functions, classes, interfaces grouped by kind).                                     |
| **Search**                | `grep`/`rg` via subprocess  | Same ripgrep engine, plus optional **semantic vector search** against an indexed codebase.                                                                                                                                           |
| **File listing**          | `find`/`ls` via subprocess  | Native listing with ripgrep's `--files` mode for fast recursive listing with automatic `.gitignore` support.                                                                                                                         |
| **Language intelligence** | Not available               | **Go to definition/implementation/type**, **find references**, **hover types**, **completions**, **symbols**, **rename**, **code actions**, **call/type hierarchy**, and **inlay hints** — all powered by VS Code's language server. |
| **Approval system**       | All-or-nothing permissions  | **Granular approval** — per-file write rules, per-sub-command pattern matching, outside-workspace path trust with prefix/glob/exact patterns, all in a dedicated approval panel.                                                     |
| **Follow-up messages**    | Silent rejection            | Every approval dialog includes a **follow-up message** field — returned to Claude as context on accept or as a rejection reason on reject.                                                                                           |

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

The sidebar shows server status, active tool calls, and approval rules. The approval panel (bottom panel by default, configurable with `native-claude.approvalPosition`) handles interactive approval dialogs for commands, file writes, path access, and renames. If auto-configuration doesn't work, use the sidebar buttons to copy the config or run the CLI setup command.

### Configuring Claude Code

For best results, add instructions to your `~/.claude/CLAUDE.md` (global) or project-level `CLAUDE.md` telling Claude to prefer Native Claude tools over built-ins. A comprehensive example is included in the repo:

```sh
cp CLAUDE.md.example ~/.claude/CLAUDE.md
```

This covers tool mappings, usage notes, and descriptions of the additional language server tools. Review and edit it to fit your setup — for example, you may want to merge it with existing instructions in your `CLAUDE.md`.

### Enforcing native-claude usage with hooks

Even with `CLAUDE.md` instructions, Claude may occasionally fall back to built-in tools (`Read`, `Edit`, `Write`, `Bash`, `Glob`, `Grep`). You can use a Claude Code [PreToolUse hook](https://docs.anthropic.com/en/docs/claude-code/hooks) to **block** built-in tools and force Claude to use native-claude equivalents.

The repo includes a ready-made hook script at [`scripts/enforce-native-claude.sh`](scripts/enforce-native-claude.sh). It:

- Blocks `Read`, `Edit`, `Write`, `Bash`, `Glob`, and `Grep` with a message telling Claude which native-claude tool to use instead
- Logs every violation to `~/.claude/native-claude-violations.jsonl` with a timestamp, the blocked tool name, and the arguments Claude tried to pass

**Setup:**

1. Copy the script to your hooks directory:

   ```sh
   mkdir -p ~/.claude/hooks
   cp scripts/enforce-native-claude.sh ~/.claude/hooks/
   chmod +x ~/.claude/hooks/enforce-native-claude.sh
   ```

2. Add the hook to `~/.claude/settings.json`:

   ```jsonc
   {
     "hooks": {
       "PreToolUse": [
         {
           "matcher": "^(Read|Edit|Write|Bash|Glob|Grep)$",
           "hooks": [
             {
               "type": "command",
               "command": "$HOME/.claude/hooks/enforce-native-claude.sh"
             }
           ]
         }
       ]
     }
   }
   ```

The `matcher` regex ensures the hook only fires for the six built-in tools that have native-claude equivalents — all other tools (including native-claude MCP tools, `Task`, `TodoWrite`, etc.) pass through unaffected.

> **Requires `jq`** — install with `brew install jq`, `apt install jq`, etc.

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
- `symbols` — top-level symbols grouped by kind (e.g. `{ "function": ["foo (line 1)"], "class": ["Bar (line 20)"] }`). Automatically skipped for JSON/JSONC files (where symbol outlines are unhelpful noise).
- `content` — numbered lines in `line_number | content` format

Fields like `git_status`, `diagnostics`, and `symbols` are omitted when not available rather than returned as null.

**Image support:** Image files (PNG, JPEG, GIF, WebP, BMP, ICO, AVIF) are returned as base64-encoded `image` content that Claude can view directly. Max image size: 10 MB.

**Friendly errors:** `ENOENT` → `"File not found: {path}. Working directory: {root}"`, `EACCES` → `"Permission denied"`, `EISDIR` → `"Use list_files instead"`.

### list_files

List files and directories. Directories have a trailing `/` suffix.

| Parameter   | Type     | Description                                                                       |
| ----------- | -------- | --------------------------------------------------------------------------------- |
| `path`      | string   | Directory path                                                                    |
| `recursive` | boolean? | List recursively (default: false)                                                 |
| `depth`     | number?  | Max directory depth for recursive listing                                         |
| `pattern`   | string?  | Glob pattern to filter files (e.g. `*.ts`, `*.test.*`). Implies recursive search. |

Recursive listing uses ripgrep (`--files` mode) for speed and automatic `.gitignore` support.

### search_files

Search file contents using regex or semantic vector search.

| Parameter          | Type     | Description                                                                                                                  |
| ------------------ | -------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `path`             | string   | Directory to search in                                                                                                       |
| `regex`            | string   | Regex pattern, or natural language query when `semantic=true`                                                                |
| `file_pattern`     | string?  | Glob to filter files (e.g. `*.ts`)                                                                                           |
| `semantic`         | boolean? | Use vector similarity search instead of regex                                                                                |
| `context`          | number?  | Number of context lines around each match (default: 1). Overridden by `context_before`/`context_after` if specified.         |
| `context_before`   | number?  | Context lines BEFORE each match (like `grep -B`). Overrides `context` for before-match lines.                                |
| `context_after`    | number?  | Context lines AFTER each match (like `grep -A`). Overrides `context` for after-match lines.                                  |
| `case_insensitive` | boolean? | Case-insensitive search (default: false)                                                                                     |
| `multiline`        | boolean? | Enable multiline matching where `.` matches newlines (default: false)                                                        |
| `max_results`      | number?  | Maximum number of matches to return (default: 300)                                                                           |
| `offset`           | number?  | Skip first N matches before returning results. Use with `max_results` for pagination.                                        |
| `output_mode`      | string?  | `content` (default, matching lines with context), `files_with_matches` (file paths only), or `count` (match counts per file) |

Regex search is powered by ripgrep with context lines and per-file match counts. Semantic search queries a Qdrant vector index (see [Semantic Search](#semantic-search)).

### get_diagnostics

Get VS Code diagnostics (errors, warnings, etc.) for a file or the entire workspace.

| Parameter  | Type    | Description                                                                        |
| ---------- | ------- | ---------------------------------------------------------------------------------- |
| `path`     | string? | File path (omit for all workspace diagnostics)                                     |
| `severity` | string? | Comma-separated filter: `error`, `warning`, `info`, `hint`                         |
| `source`   | string? | Comma-separated source filter (e.g. `typescript`, `eslint`). Default: all sources. |

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

### go_to_implementation

Find concrete implementations of an interface, abstract class, or method. Unlike `go_to_definition` which shows the declaration, this shows where the code actually runs.

| Parameter | Type   | Description                                        |
| --------- | ------ | -------------------------------------------------- |
| `path`    | string | File path (absolute or relative to workspace root) |
| `line`    | number | Line number (1-indexed)                            |
| `column`  | number | Column number (1-indexed)                          |

Returns an array of `implementations` with the same location format as `go_to_definition`.

### go_to_type_definition

Navigate to the type definition of a symbol. For `const x = getFoo()`, `go_to_definition` goes to `getFoo`'s declaration, but `go_to_type_definition` goes to the return type.

| Parameter | Type   | Description                                        |
| --------- | ------ | -------------------------------------------------- |
| `path`    | string | File path (absolute or relative to workspace root) |
| `line`    | number | Line number (1-indexed)                            |
| `column`  | number | Column number (1-indexed)                          |

Returns an array of `type_definitions` with the same location format as `go_to_definition`.

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

### get_code_actions

Get available code actions (quick fixes, refactorings) at a position or range. Returns actions like "Add missing import", "Extract function", "Organize imports", "Fix ESLint error", etc.

| Parameter        | Type     | Description                                                                                                  |
| ---------------- | -------- | ------------------------------------------------------------------------------------------------------------ |
| `path`           | string   | File path (absolute or relative to workspace root)                                                           |
| `line`           | number   | Line number (1-indexed)                                                                                      |
| `column`         | number   | Column number (1-indexed)                                                                                    |
| `end_line`       | number?  | End line for range selection (1-indexed)                                                                     |
| `end_column`     | number?  | End column for range selection (1-indexed)                                                                   |
| `kind`           | string?  | Filter by action kind: `quickfix`, `refactor`, `refactor.extract`, `source.organizeImports`, `source.fixAll` |
| `only_preferred` | boolean? | Only return preferred/recommended actions (default: false)                                                   |

Returns an `actions` array with `index`, `title`, `kind`, `preferred`, `fixes_diagnostics`, `changes` (file/edit counts), and `has_command`. Use the `index` with `apply_code_action` to apply.

### apply_code_action

Apply a code action returned by `get_code_actions`. Modifies files directly (workspace edits are applied and saved).

| Parameter | Type   | Description                                                    |
| --------- | ------ | -------------------------------------------------------------- |
| `index`   | number | 0-based index of the action to apply (from `get_code_actions`) |

Returns `status`, `action` (title), `kind`, and `changed_files` (list of modified file paths).

### get_call_hierarchy

Get incoming callers and/or outgoing callees for a function or method. Shows who calls this function and what it calls.

| Parameter   | Type    | Description                                                          |
| ----------- | ------- | -------------------------------------------------------------------- |
| `path`      | string  | File path (absolute or relative to workspace root)                   |
| `line`      | number  | Line number (1-indexed)                                              |
| `column`    | number  | Column number (1-indexed)                                            |
| `direction` | string  | `incoming` (who calls this), `outgoing` (what this calls), or `both` |
| `max_depth` | number? | Maximum recursion depth for call chain (default: 1, max: 3)          |

Returns `symbol` (the target function) and `incoming`/`outgoing` arrays with caller/callee info, call site locations, and nested calls when depth > 1.

### get_type_hierarchy

Get supertypes (parent classes/interfaces) and/or subtypes (child classes/implementations) of a type.

| Parameter   | Type    | Description                                              |
| ----------- | ------- | -------------------------------------------------------- |
| `path`      | string  | File path (absolute or relative to workspace root)       |
| `line`      | number  | Line number (1-indexed)                                  |
| `column`    | number  | Column number (1-indexed)                                |
| `direction` | string  | `supertypes` (parents), `subtypes` (children), or `both` |
| `max_depth` | number? | Maximum recursion depth (default: 2, max: 5)             |

Returns `symbol` (the target type) and `supertypes`/`subtypes` arrays with type info and nested hierarchy.

### get_inlay_hints

Get inlay hints (inferred types, parameter names) for a range of lines. Shows the same inline annotations that VS Code displays in the editor.

| Parameter    | Type    | Description                                        |
| ------------ | ------- | -------------------------------------------------- |
| `path`       | string  | File path (absolute or relative to workspace root) |
| `start_line` | number? | Start of range (1-indexed, default: 1)             |
| `end_line`   | number? | End of range (1-indexed, default: end of file)     |

Returns a `hints` array with `line`, `column`, `label`, `kind` (`type` or `parameter`), and padding info.

### open_file

Open a file in the VS Code editor, optionally scrolling to a specific line and placing the cursor. Supports range selection to highlight code.

| Parameter    | Type    | Description                                                                      |
| ------------ | ------- | -------------------------------------------------------------------------------- |
| `path`       | string  | File path (absolute or relative to workspace root)                               |
| `line`       | number? | Line number to scroll to (1-indexed)                                             |
| `column`     | number? | Column for cursor placement (1-indexed)                                          |
| `end_line`   | number? | End line for range selection (1-indexed, requires `line`). Highlights the range. |
| `end_column` | number? | End column for range selection (1-indexed, requires `end_line`).                 |

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

### find_and_replace

Bulk find-and-replace across **multiple files**. Opens a rich preview panel showing each match in context with inline diffs — users can toggle individual matches on/off before accepting. For single-file edits, prefer `apply_diff` — it provides better diff review and format-on-save. Only use `find_and_replace` on a single file when making many identical replacements (e.g. renaming a variable throughout a file). Use `glob` for multi-file patterns.

| Parameter | Type     | Description                                                                                              |
| --------- | -------- | -------------------------------------------------------------------------------------------------------- |
| `find`    | string   | Text to find. Treated as a literal string unless `regex=true`.                                           |
| `replace` | string   | Replacement text                                                                                         |
| `path`    | string?  | Single file path to search in. Mutually exclusive with `glob`.                                           |
| `glob`    | string?  | Glob pattern to match files (e.g. `src/**/*.ts`). Mutually exclusive with `path`.                        |
| `regex`   | boolean? | Treat `find` as a regular expression. Supports capture groups (`$1`, `$2`) in `replace`. Default: false. |

**Response includes:**

- `status` — `applied`, `no_matches`, or `rejected`
- `files_changed` — number of files modified
- `total_replacements` — total number of replacements made
- `files` — per-file breakdown with `path` and `changes` count

Uses the same write approval flow as `rename_symbol` — shows affected files for review before applying.

### codebase_search

Search the codebase by meaning using vector similarity. Pass a natural language query and get ranked code chunks. Best for exploratory questions like "how does authentication work" or "where are database connections configured".

| Parameter | Type    | Description                                                        |
| --------- | ------- | ------------------------------------------------------------------ |
| `query`   | string  | Natural language query describing what you're looking for          |
| `path`    | string? | Directory to scope the search to (omit to search entire workspace) |
| `limit`   | number? | Maximum number of results to return (default: 10)                  |

Requires a Qdrant vector index (built by Roo Code) and an OpenAI API key. See [Semantic Search](#semantic-search).

### execute_command

Run a command in VS Code's integrated terminal. Output is captured when shell integration is available. Terminal environment is configured to prevent interactive pagers (`PAGER=cat`, `GIT_PAGER=cat`, etc.) and to suppress interactive prompts (`npm_config_yes=true`, `DEBIAN_FRONTEND=noninteractive`).

**Interactive command validation:** Commands that require interactive input are automatically rejected with a helpful suggestion. This includes editors (vim, nano, emacs), TUI apps (top, htop, ncdu), bare database CLIs without inline queries (mysql, psql, mongosh), bare REPLs without scripts (python, node, ruby), git interactive flags (-i, -p, --patch), scaffolding commands without --yes (npx create-*, npm init), and more. The rejection message includes the reason and a non-interactive alternative.

Output is capped to the **last 200 lines** by default to prevent context window bloat. Full output is saved to a temp file (returned as `output_file`) for on-demand access via `read_file`. Use `output_head`, `output_tail`, or `output_grep` to customize filtering — agents should use these instead of piping through `grep`/`tail`/`head` in the command itself, which hides output from the user.

| Parameter             | Type     | Description                                                                                                                                        |
| --------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `command`             | string   | Shell command to execute                                                                                                                           |
| `cwd`                 | string?  | Working directory                                                                                                                                  |
| `terminal_id`         | string?  | Reuse a specific terminal by ID                                                                                                                    |
| `terminal_name`       | string?  | Run in a named terminal (e.g. `Server`, `Tests`)                                                                                                   |
| `split_from`          | string?  | Split alongside an existing terminal (by `terminal_id` or `terminal_name`), creating a visual group                                                |
| `background`          | boolean? | Run without waiting for completion. Returns immediately with `terminal_id`. Use `get_terminal_output` to check progress.                           |
| `timeout`             | number?  | Timeout in seconds. Starts counting from when the shell begins executing (not from tool call start), so terminal startup time doesn't eat into it. |
| `output_head`         | number?  | Return only the first N lines of output. Overrides the default 200-line tail cap.                                                                  |
| `output_tail`         | number?  | Return only the last N lines of output. Overrides the default 200-line tail cap.                                                                   |
| `output_offset`       | number?  | Skip first N lines before applying head/tail. Use with `output_head` for line ranges (e.g. `offset: 290, head: 21` → lines 290-310).               |
| `output_grep`         | string?  | Filter output to lines matching this regex pattern (case-insensitive). Applied before offset/head/tail.                                            |
| `output_grep_context` | number?  | Number of context lines around each grep match (like `grep -C`). Non-contiguous groups are separated by `--`. Only used with `output_grep`.        |

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

**Response includes:**

- `closed` — number of terminals closed
- `not_found` — array of requested terminal names that weren't found (only present when `names` is provided and some didn't match)

### get_terminal_output

Get the output and status of a background command. Use after `execute_command` with `background: true` to check on progress, read accumulated output, and see if the command has finished. Background terminals are never auto-reused — they must be referenced explicitly by `terminal_id`.

| Parameter             | Type    | Description                                                                                                                                                                                                 |
| --------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `terminal_id`         | string  | Terminal ID returned by `execute_command` (e.g. `term_3`)                                                                                                                                                   |
| `wait_seconds`        | number? | Wait up to N seconds for new output to appear before returning. Polls every 250ms, returns early when new output arrives or command finishes. Useful to avoid double-calls when a command was just started. |
| `output_head`         | number? | Return only the first N lines of output                                                                                                                                                                     |
| `output_tail`         | number? | Return only the last N lines of output                                                                                                                                                                      |
| `output_offset`       | number? | Skip first N lines before applying head/tail                                                                                                                                                                |
| `output_grep`         | string? | Filter output to lines matching this regex pattern (case-insensitive)                                                                                                                                       |
| `output_grep_context` | number? | Number of context lines around each grep match                                                                                                                                                              |

**Response includes:**

- `terminal_id` — echoed back
- `is_running` — whether the background command is still running
- `exit_code` — null while running, number when finished
- `output` — accumulated output so far (cleaned of ANSI codes)
- `output_captured` — whether shell integration was available for output capture
- `total_lines`, `lines_shown`, `output_file` — same filtering/temp-file behavior as `execute_command`

## Sidebar & Approval Panel

The extension provides two Preact-based webview panels:

- **Sidebar** (Native Claude icon in the activity bar) — live status overview, rule management, and tool call tracking
- **Approval Panel** (bottom panel by default, or split editor — configurable via `native-claude.approvalPosition`) — interactive approval dialogs for commands, file writes, path access, and renames. Each dialog includes a follow-up message field that's returned to Claude (as context on accept, or as a rejection reason on reject).

### Sidebar Sections

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

When Claude proposes file changes (`write_file` or `apply_diff`), a diff view opens showing the proposed changes and the approval panel presents a write approval card. The editor title bar also has quick-access buttons: **Accept** (checkmark), **Options** (...), and **Reject** (X).

- **Accept** — saves the changes
- **Save Rule & Accept** — saves an auto-approval rule and accepts (expand the "Auto Approval Rules" section to configure)
- **Reject** — discards the changes, with optional follow-up message returned to Claude

User edits made in the diff view before accepting are captured and returned to Claude as a patch, so it can see what you changed.

#### File-Level Write Rules

The approval panel's collapsible "Auto Approval Rules" section lets you scope the approval:

- **All files** — blanket approval for all writes
- **This file** — only auto-approve this specific file
- **Custom pattern** — define a prefix, exact, or glob pattern to match files

Rules can be scoped to session, project, or global. Manage them from the sidebar.

### Command Approval

When Claude runs a command via `execute_command`, the approval panel shows the command in a terminal-style display. The command text is editable inline — you can modify it before running.

- **Run** — execute the command (without saving a rule)
- **Save Rule & Run** — save auto-approval rules and execute (expand the "Auto Approval Rules" section to configure)
- **Reject** — block the command, with optional follow-up message returned to Claude

#### Per-Sub-Command Rules

For compound commands (e.g. `npm install && npm test`), the approval panel splits the command into individual sub-commands, each with its own rule row. You can configure each sub-command independently:

- **Pattern** — pre-filled with the sub-command, editable
- **Mode** — prefix, exact, regex, or skip (don't save a rule for this sub-command)
- **Scope** — session, project, or global

### Outside-Workspace Path Access

When a tool accesses a file outside the workspace, the approval panel prompts for approval:

- **Allow Once** — permit this single access
- **Save Rule & Allow** — save a path trust rule and allow (expand the "Auto Approval Rules" section to configure)
- **Reject** — block the access, with optional follow-up message returned to Claude

The rule editor is pre-filled with the parent directory path. You can choose prefix, exact, or glob matching, and scope to session, project, or global.

### Rename Approval

When Claude renames a symbol via `rename_symbol`, the approval panel shows the old and new names along with the list of affected files. The same accept/reject flow applies — you can save auto-approval rules or reject with a follow-up message.

### Managing Rules

The sidebar shows all global and session rules for writes, commands, and trusted paths. You can:

- **Click a rule** or the edit icon to modify its pattern and match mode
- **Click the X** to delete a rule
- **Add rules** manually via the sidebar button
- **Clear** session rules individually or all at once

### Master Bypass

Set `native-claude.masterBypass` to `true` in settings to skip all approval prompts. Both file writes and commands are auto-approved. Use with caution.

### Recent Approval Auto-Approve

When you approve a command with **Run Once** or accept a file write, the approval is remembered for a short window (default: 60 seconds). If Claude fires the same command or writes to the same file again within that window, it is auto-approved without prompting — no diff view, no dialog.

This is especially useful when Claude edits the same file multiple times in quick succession or re-runs a build command. You approve once and the rest flow through automatically.

- **Commands** — keyed on the full command string. `npm run build` approved once → auto-approved on repeat. A different command (e.g. `npm test`) still requires approval.
- **Writes** — keyed on the file path. Accepting a write to `src/foo.ts` auto-approves subsequent writes to the same file within the window.
- **Edited commands** — if you edit a command before running, it is _not_ cached (you clearly wanted to review it).
- **Persistent rules take precedence** — if you choose "For Session" or "Always", those rules handle future approvals regardless of the TTL.

Configure the window with `native-claude.recentApprovalTtl` (seconds). Set to `0` to disable.

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

| Setting                           | Default | Description                                                                                                           |
| --------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------- |
| `native-claude.port`              | `0`     | HTTP port for the MCP server (`0` = OS-assigned, recommended for multi-window)                                        |
| `native-claude.autoStart`         | `true`  | Auto-start server on activation                                                                                       |
| `native-claude.requireAuth`       | `true`  | Require Bearer token auth                                                                                             |
| `native-claude.masterBypass`      | `false` | Skip all approval prompts                                                                                             |
| `native-claude.approvalPosition`  | `panel` | Where to show approval dialogs: `beside` (split editor) or `panel` (bottom panel)                                     |
| `native-claude.diagnosticDelay`   | `1500`  | Max ms to wait for diagnostics after save                                                                             |
| `native-claude.recentApprovalTtl` | `60`    | Seconds to remember single-use approvals. Repeat identical commands/writes auto-approve within this window. `0` = off |
| `native-claude.writeRules`        | `[]`    | Glob patterns for auto-approved file writes (settings-level)                                                          |

## Troubleshooting

### Tool calls hanging / timing out

Claude Code's MCP client has HTTP connection timeouts (~2–3 minutes by default). For tools that require user interaction — like `apply_diff` waiting for you to review a diff, or `execute_command` running a long build — the SSE stream can time out before you respond, causing Claude to hang waiting for a result that was lost.

**What Native Claude does automatically:**

- **SSE heartbeat notifications** — sends periodic keep-alive messages on the SSE stream to prevent idle timeout disconnects
- **Event store resumability** — tool responses are persisted in an in-memory store so they can be replayed if the client reconnects with `Last-Event-ID`
- **Tool call sidebar** — if a tool call does get stuck, you can **Complete** or **Cancel** it from the sidebar's Tool Calls section

### Server not starting

Check the Output panel (View → Output → "Native Claude") for error logs. Common causes:

- **Port conflict** — set `native-claude.port` to `0` (default) for OS-assigned ports
- **Auth mismatch** — the token in `~/.claude.json` may be stale; restart the extension to regenerate it

## Architecture

- **Transport**: Streamable HTTP on `127.0.0.1` (localhost only, no network exposure)
- **Per-session isolation**: Each MCP session gets its own `McpServer` + `StreamableHTTPServerTransport` pair
- **Session recovery**: Stale session IDs (e.g. after extension reload) are transparently reused instead of returning 404 errors
- **SSE resumability**: Each transport is configured with an in-memory event store, enabling clients to reconnect and replay missed tool responses
- **Auth**: Optional Bearer token stored in VS Code's `globalState`, auto-written to `~/.claude.json` with atomic write (temp file + rename)
- **Webviews**: Two Preact-based webviews (sidebar + approval panel) with `postMessage` state bridge — no full HTML replacement, all updates are incremental via VDOM diffing
- **Bundled**: Triple esbuild targets — extension (CJS/Node), sidebar webview (ESM/browser), and approval panel webview (ESM/browser). No runtime dependencies beyond VS Code and Preact (~3KB)

## Development

```sh
npm install
npm run build     # one-shot build
npm run watch     # rebuild on change
```

Press F5 in VS Code to launch the Extension Development Host for testing.
