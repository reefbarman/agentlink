# AgentLink Tools Reference

This guide explains the built-in agent's tool families and points to the complete parameter reference. Tools are available only when the current mode, active skill, session type, and approval policy allow them.

## Read and understand a workspace

Use the lightweight orientation tools before broad changes:

- `get_context` — read an oriented file slice with metadata, diagnostics, and symbols.
- `read_file` — read exact content or a bounded range.
- `list_files`, `search_files`, and `codebase_search` — find files and code.
- `get_repo_map` and `get_module_neighbors` — understand structure and dependency impact.
- Language tools — definitions, references, symbols, hovers, code actions, and rename support through VS Code.

Exact parameters: [read and language tools](complete-reference.md#tools).

## Make reviewed changes

- `write_file` creates or replaces a file through the reviewed editor save boundary.
- `apply_diff` applies reviewed search/replace blocks or unified diff hunks.
- `find_and_replace` makes a bounded multi-file replacement proposal.
- `rename_symbol` uses VS Code language intelligence where available.

Accepted writes include durability evidence. If format-on-save changes approved content, re-read when the result requests it. Protected targets, outside-workspace paths, and other policy boundaries remain reviewable.

Exact write-tool parameters and marker grammar: [write tools](complete-reference.md#write_file).

## Run and inspect commands

- `execute_command` runs a command in a managed terminal.
- `get_terminal_output` reads retained output or controls an observed command.
- `close_terminals` closes managed terminals when appropriate.

Command route, network access, shell persistence, and approval behavior depend on policy. Native Agent commands are dispatched through verified private command artifacts so complex approved shell text is not retyped through the interactive line editor. Bare SSH sessions remain blocked, while a command supplied after the SSH host is treated as one-shot/non-interactive. Safe `git init` chains targeting the workspace root receive protected-metadata native-retry guidance before launch. Use the structured recovery guidance returned by a failed command instead of guessing at retries.

Exact command-tool parameters: [terminal tools](complete-reference.md#execute_command).

## Work with people and the session

- `ask_user` asks structured questions.
- `todo_write` maintains visible work state.
- `set_task_status` ends a turn with a truthful result.
- `switch_mode` changes the workflow mode.
- `search_session_history` and `read_session_excerpt` retrieve prior context when allowed.

Exact session-tool parameters: [orchestration tools](complete-reference.md#built-in-agent-orchestration-tools).

## Delegate work

- `spawn_background_agent` starts a bounded background task.
- `get_background_status`, `get_background_result`, `steer_background_agent`, and `kill_background_agent` supervise it.
- Fleet workflows can run structured review, browser verification, best-of-N work, or scheduled goals.

Use clear ownership and a focused review scope for writable or review work. See [background agents](capabilities.md#background-agents-and-orchestration) and the [full background tool reference](complete-reference.md#spawn_background_agent).

## Connect external capabilities

- `find_mcp_tools` and `call_mcp_tool` discover and invoke configured MCP capabilities.
- Resources and prompts use `list_mcp_resources`, `read_mcp_resource`, `list_mcp_prompts`, and `get_mcp_prompt`.
- Native web search/fetch may be available according to the configured web-access backend.

MCP configuration and trust behavior: [MCP](mcp.md).

## Exact contracts and recovery behavior

The [complete product reference tools section](complete-reference.md#tools) is currently the authoritative exhaustive list of input schemas, response shapes, mode availability, and recovery fields. This focused page is the place to start; use the linked section when an exact tool contract matters.
