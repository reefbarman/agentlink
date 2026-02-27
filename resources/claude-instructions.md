## MANDATORY: Use agentlink MCP tools

**STOP CHECK**: Before doing ANY work, verify that the `agentlink` MCP server is connected by confirming you have access to its tools (e.g. `read_file`, `execute_command`, `apply_diff`). If agentlink tools are NOT available in your tool list, **STOP IMMEDIATELY** and tell the user:

> "The agentlink MCP server is not connected. I cannot proceed without it. Please check that the agentlink VS Code extension is running and reload the MCP connection."

**Do NOT fall back to built-in tools.** Do NOT silently continue with `Read`, `Edit`, `Write`, `Bash`, `Glob`, or `Grep`. Wait for the user to fix the connection.

When the `agentlink` MCP server is available, NEVER use built-in `Read`, `Edit`, `Write`, `Bash`, `Glob`, or `Grep` tools. ALWAYS use the agentlink MCP equivalents instead:

- `Read` → `read_file`
- `Edit` / `Write` → `apply_diff` / `write_file`
- `Bash` → `execute_command`
- `Glob` → `list_files`
- `Grep` → `search_files`

These MCP tools open diff views for user review, run commands in visible terminals, and return VS Code diagnostics.

**Exception — non-text files:** The built-in `Read` tool may be used for file types that `read_file` cannot handle: **images** (PNG, JPG, GIF, etc. — Claude is multimodal), **PDFs** (with the `pages` parameter), and **Jupyter notebooks** (`.ipynb` — rendered with cells + outputs). A PreToolUse hook enforces this automatically.

### Common mistakes — DO NOT DO THESE

These are the most frequent violations. Check yourself before every tool call:

- **DO NOT use `Bash` to run builds, tests, git commands, or any shell command.** Use `execute_command`. If `execute_command` fails (e.g. parameter validation error), fix the parameters and retry — do NOT fall back to `Bash`.
- **DO NOT use `Grep` to search code.** Use `search_files`. If you need to search the workspace root, pass `path: "."`.
- **DO NOT use `Read` to read files.** Use `read_file`. **Exception:** built-in `Read` is allowed for images, PDFs, and Jupyter notebooks (file types `read_file` cannot handle).
- **DO NOT use `Edit` or `Write` to modify files.** Use `apply_diff`, `write_file`, or `find_and_replace`. The built-in `Edit` tool's `replace_all` feature is NOT a reason to use it — use `find_and_replace` instead.
- **DO NOT use `Glob` to find files.** Use `list_files`.
- **DO NOT fall back to built-in tools when a agentlink tool returns an error.** Fix the issue (wrong parameter type, missing required param, etc.) and retry with the agentlink tool.

### Tool details

| Instead of (built-in) | Use (agentlink MCP) | Why |
|---|---|---|
| `Read` | `read_file` | Returns line numbers, file metadata, git status, and diagnostics summary |
| `Edit` / `Write` | `apply_diff` / `write_file` | Opens a diff view for user review. Format-on-save applies automatically. Returns user edits and diagnostics. |
| `Bash` | `execute_command` | Runs in VS Code's integrated terminal (visible to user). Captures output via shell integration. Supports named terminals for parallel tasks. |
| `Glob` | `list_files` | Lists files with optional recursive + depth control |
| `Grep` | `search_files` | Ripgrep-powered search with context lines. Also supports semantic/vector search. |

### Terminal behavior — IMPORTANT

`execute_command` automatically reuses an existing idle terminal. You do NOT need to pass `terminal_name` or `terminal_id` for normal sequential commands — just omit both and the tool will reuse the default terminal.

- **DO NOT** pass `terminal_name` unless you specifically need a *separate* terminal (e.g. a long-running dev server alongside normal commands, or truly parallel tasks).
- **DO NOT** invent terminal names like "Build", "Git", "Lint" for one-off commands — this creates unnecessary terminals that clutter the user's workspace.
- `terminal_id` is only needed if a previous background command returned one and you need to interact with that specific terminal.
- Use `background: true` for long-running processes (dev servers, watch modes). Returns immediately with `terminal_id`. Use `get_terminal_output` with the `terminal_id` to check on progress, read accumulated output, and see if the command has finished. Background terminals are never auto-reused — always use `terminal_name` or `terminal_id` to target them.
- Use `split_from` with a `terminal_id` or `terminal_name` to create a new terminal split alongside an existing one, forming a visual group in VS Code's terminal panel. Only affects new terminal creation — if the target `terminal_name` already exists and is idle, it is reused without re-splitting. Example: start a backend server with `terminal_name='Backend'`, then use `split_from='Backend'` with `terminal_name='Frontend'` to group them side-by-side.
- After a session, use `close_terminals` to clean up any stale terminals.
- `execute_command` runs in a real PTY terminal. Known interactive commands (editors, TUI apps, bare REPLs, scaffolders without `--yes`, git `-i`/`-p` flags, etc.) are **automatically rejected** with a helpful suggestion. Still, always use non-interactive flags where available (e.g. `--yes`, `-y`, `--no-input`, `--non-interactive`, `CI=true`) for commands the validator may not catch.
- **Always set a `timeout`** for commands you expect to complete quickly (e.g. git, ls, npm test — use 10-30s). This prevents the session from hanging if a command unexpectedly blocks. Only omit timeout for long-running processes (dev servers, watch modes) where you want to wait indefinitely.

### File editing notes

- After writing files, check the response for `diagnostics` and `user_edits`.
- If `user_edits` is present, the user modified your proposed changes — read the patch to understand what they changed.
- Use `get_diagnostics` for real VS Code errors/warnings from language services.

### Additional tools (no built-in equivalent)

agentlink also provides tools that Claude Code doesn't have natively. Use these proactively — they give you real language server intelligence instead of guessing from source text.

- **`go_to_definition`** — Jump to where a symbol is defined. Takes a file, line, and column.
- **`go_to_implementation`** — Find concrete implementations of an interface, abstract class, or method. Unlike `go_to_definition` which shows the declaration, this shows where the code actually runs. Essential for interface-heavy codebases (TypeScript, Java, C#).
- **`go_to_type_definition`** — Navigate to the type definition of a symbol. For `const x = getFoo()`, `go_to_definition` goes to `getFoo`'s declaration, but `go_to_type_definition` goes to the return type. Useful for exploring API return types.
- **`get_references`** — Find all usages of a symbol across the workspace.
- **`get_symbols`** — Get document symbol outline (pass `path`) or search workspace symbols (pass `query`).
- **`get_hover`** — Get inferred types and documentation for a symbol at a position. Same info shown on editor hover.
- **`get_completions`** — Get autocomplete suggestions at a cursor position. Useful for discovering available methods, properties, and APIs.
- **`get_code_actions`** + **`apply_code_action`** — Get available quick fixes and refactorings at a position (add missing import, extract function, organize imports, fix lint errors, etc.), then apply one by index. **Use this instead of manually writing imports or refactoring code** — the language server knows the exact edits needed.
- **`get_call_hierarchy`** — Get incoming callers and/or outgoing callees for a function. Shows who calls this function (`incoming`), what it calls (`outgoing`), or `both`. Supports recursive depth (max 3) for exploring call chains.
- **`get_type_hierarchy`** — Get supertypes (parent classes/interfaces) and subtypes (child classes/implementations) of a type. Useful for understanding inheritance hierarchies.
- **`get_inlay_hints`** — Get inferred type annotations and parameter names for a range of lines. Shows the same inline hints VS Code displays in the editor. Pass `start_line`/`end_line` to scope the range.
- **`get_diagnostics`** — Get real VS Code diagnostics (errors, warnings) for a file or the whole workspace. Use after edits to check for problems without running a build. Filter by `severity` and/or `source` (e.g. `typescript`, `eslint`).
- **`rename_symbol`** — Rename a symbol across the entire workspace using the language server. Updates all references, imports, and re-exports.
- **`open_file`** — Open a file in the VS Code editor, optionally scrolling to a specific line. Supports range selection with `end_line`/`end_column` to highlight code.
- **`show_notification`** — Show a notification in VS Code. Use sparingly for important status updates.
- **`codebase_search`** — Semantic search over the codebase using vector similarity. Pass a natural language query (e.g. "how does auth work", "where are API routes defined") and get ranked code chunks. Use `limit` (default 10) to control how many results are returned. **Prefer this over regex search when you're exploring unfamiliar code, looking for conceptual matches, or don't know exact function/variable names.** Requires Roo Code codebase index + OpenAI API key.
- **`find_and_replace`** — Bulk find-and-replace across **multiple files** using a glob pattern (e.g. `src/**/*.ts`). Supports literal strings and regex with capture groups. Opens a rich preview panel showing each match in context with inline diffs — the user can toggle individual matches on/off before accepting. **For single-file edits, prefer `apply_diff`** — it provides better diff review and format-on-save. Only use `find_and_replace` on a single file when making many identical replacements (e.g. renaming a variable throughout a file).
- **`get_terminal_output`** — Check on a background command started with `execute_command` + `background: true`. Pass the `terminal_id` returned by `execute_command`. Returns accumulated output, whether the command is still running, and the exit code when finished. Use `wait_seconds` to poll for new output (avoids needing two calls when a command was just started). Supports the same output filtering params as `execute_command` (`output_head`, `output_tail`, `output_grep`, etc.).
