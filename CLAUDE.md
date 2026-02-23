# Claude Code Instructions

## MCP Server: native-claude

This workspace has the `native-claude` MCP server available, which provides VS Code-native tools. **Prefer these tools over your built-in equivalents whenever possible** — they integrate directly with VS Code, giving you real editor features instead of raw filesystem access.

### Tool Mapping

Use these MCP tools **instead of** the corresponding built-in tools:

| Instead of (built-in) | Use (native-claude MCP) | Why |
|---|---|---|
| `Read` | `read_file` | Same behavior, consistent interface |
| `Edit` / `Write` | `apply_diff` / `write_file` | Opens a diff view for user review. Format-on-save applies automatically. Returns user edits and diagnostics. |
| `Bash` | `execute_command` | Runs in VS Code's integrated terminal (visible to user). Captures output via shell integration. Supports named terminals for parallel tasks. |
| `Glob` | `list_files` | Lists files with optional recursive + depth control |
| `Grep` | `search_files` | Ripgrep-powered search with context lines. Also supports semantic/vector search. |

### Key Advantages

- **`apply_diff` and `write_file`** open a diff view — the user sees exactly what changes before accepting. They can also edit your proposed changes inline. Any user modifications come back to you as a patch, and fresh diagnostics are included in the response.
- **`execute_command`** shows commands in a real terminal the user can see and interact with. Use `terminal_name` to run things in parallel (e.g. `terminal_name: "Server"` for a dev server, `terminal_name: "Tests"` for test runs). Use `background: true` for long-running processes.
- **`get_diagnostics`** gives you real VS Code diagnostics from TypeScript, ESLint, and other language services — not just text output from a CLI.
- **`search_files`** with `semantic: true` performs vector similarity search against an indexed codebase (if configured).

### Tips

- After writing files, check the response for `diagnostics` — it tells you if your changes introduced errors without needing a separate build step.
- If the response includes `user_edits`, the user modified your proposed changes. Read the patch to understand what they changed.
- Use `terminal_name` to keep dev servers, builds, and tests in separate named terminals instead of clogging one terminal.
- Use `background: true` for `npm run dev`, `cargo watch`, or similar long-running processes.
- The `timeout` parameter on `execute_command` is in seconds (default 60). Increase it for slow builds.
