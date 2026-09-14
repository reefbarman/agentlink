# AgentLink Tools Reference

This guide explains the built-in agent's tool families and points to the complete parameter reference. Tools are available only when the current mode, active skill, session type, and approval policy allow them.

## Read and understand a workspace

Use the lightweight orientation tools before broad changes:

- `get_context` — read an oriented file slice with metadata, diagnostics, and symbols.
- `read_file` — read exact content or a bounded range.
- `list_files`, `search_files`, and `codebase_search` — find files and code.
- `get_repo_map` and `get_module_neighbors` — understand structure and dependency impact.
- Language tools — definitions, references, symbols, hovers, code actions, and rename support through VS Code.

**Indexed tools are workspace-only.** `get_repo_map`, `get_module_neighbors`, `codebase_search`, `read_file(query)`, `list_files(query)`, and `search_files(semantic=true)` only cover files/folders within the current workspace folders. An absolute path to an external repository does not make its index available, even if it is open in another window or was previously indexed. `get_repo_map.include_external` includes dependency names, not external repository contents.

For external paths, use `read_file` and `list_files` without `query`, or regex `search_files` with `semantic=false`, subject to existing path permissions and approvals. The repo-map-first and semantic-search-first guidance does not apply outside the current workspace.

Exact parameters: [read and language tools](complete-reference.md#tools).

## Reduce related read-only fan-out

`compose` is a default-on foreground tool for known workflows with roughly four or more related reads. It runs a bounded JavaScript function body that calls authorized read-only tools, keeps child results out of provider history, and returns only the filtered, projected, joined, counted, or summarized JSON the model needs.

Compose is inline by default in workspace-backed foreground sessions whose mode and active skill permit it; no `find_native_tools` call is needed. Set the machine-scoped `agentlink.compose.enabled` setting to `false` to opt out, and reload affected VS Code windows after changing it. It remains unavailable to background agents, `/btw`, ACP, worktree setup, and projectless sessions. `AGENTLINK_DISABLE_COMPOSE=1` before startup force-disables it for recovery.

Use direct or ordinary parallel calls for one-offs, independent full results, and exploration where each result determines the next action. Compose cannot write, run commands, use MCP/web/memory/UI tools, nest itself, or open an approval. Text and extracted-PDF `read_file` calls are composable only without `query`; media/document output is rejected.

For independent reads, prefer `toolAllSettled`: it returns fulfilled values and recoverable per-child errors without cancelling useful siblings when a file is missing. Preserve those errors in the reduced summary. Reserve `toolAll` for batches where every result is required; it deliberately fails fast. Use paths established by prior reads/searches rather than guessed filenames, and use each child's documented result shape (`search_files.results` is formatted text, not an array).

Compose cards in VS Code and browser workspace chat distinguish succeeded, failed, and cancelled children. Child errors wrap below the affected read instead of disrupting row alignment. The script is readable JavaScript under **Script**; failed results show the error first, with raw JSON and stack traces under **Technical details**.

The final output limit is 40 KiB. If exact secure retention succeeds, oversized output returns completed-with-spill metadata (`outputSpilled: true`) and a bounded preview plus `recovery.output_file`, rather than an execution failure. Read only needed artifact records instead of rerunning completed work. Retention failures and genuine execution errors remain errors; cancellation remains cancellation. Byte limits are unchanged.

Exact script helpers, child constraints, limits, and recovery behavior: [compose](complete-reference.md#compose).

## Make reviewed changes

- `write_file` creates or replaces a file through the reviewed editor save boundary.
- `apply_diff` applies reviewed search/replace blocks or unified diff hunks.
- `find_and_replace` makes a bounded multi-file replacement proposal.
- `rename_symbol` uses VS Code language intelligence where available.

In VS Code, automatic write/edit review opens and tab cleanup preserve keyboard focus so they do not interrupt typing in chat. Explicitly opening a pending diff still focuses it. Exception: Save without Formatting (including exact-preservation saves for Unity files) still activates the target editor because VS Code's command requires it. Browser diff review remains read-only.

Accepted writes include durability evidence. If format-on-save changes approved content, re-read when the result requests it. Protected targets, outside-workspace paths, and other policy boundaries remain reviewable. Foreground Review mode exposes `write_file` only for absolute paths inside the host temporary directory, such as Markdown bodies passed to review or approval commands; workspace files remain read-only. Normal write approval still applies. Background agents using the `review` tool profile remain fully read-only.

The standalone CLI exposes a narrower terminal-native contract: project-relative reads, bounded regex search, hash-bearing `get_context`, and single-file `write_file`/canonical SEARCH-DIVIDER-REPLACE `apply_diff`. Existing files require the saved baseline hash, new files require an absent-file precondition, and the terminal shows the complete resulting diff before approval. A session grant continues only the same tool and path along its verified content-hash chain; external edits, changed scope or policy, and switching between patch and replacement require a fresh review. CLI writes preserve exact content and return a verified final hash; they do not run VS Code format-on-save. After explicit managed TypeScript/JavaScript installation and separate typed enablement for the canonical project, the CLI also exposes read-only `get_diagnostics`, `get_symbols`, `go_to_definition`, `get_references`, and `get_hover`. These use project-relative paths, return explicit freshness/readiness metadata, and recheck file scopes before returning locations.

Exact write-tool parameters and marker grammar: [write tools](complete-reference.md#write_file). Standalone CLI details: [Standalone CLI](standalone-cli.md).

## Generate and present images

- `generate_image` is available in Code and Architect modes and defaults to GPT-Image-2.5 Flare for fast visual exploration. Use Sunburst when editing precision or final polish matters. OpenAI API-key sessions can select validated dimensions, quality through `max`, input fidelity, background transparency, PNG/JPEG/WebP output and compression, or explicitly edit a selected image with an optional PNG mask. ChatGPT/Codex OAuth keeps legacy generation and reference-led refinement; advanced controls are rejected before spending quota until that backend is verified.
- `present_images` shows images already retained in the session without generating a new image or consuming quota.

VS Code can save generated PNG, JPEG, and WebP files and use workspace-local edit/reference images. Browser Ask Agent remains display-only and uses retained session image IDs. Advanced calls require approval each time; legacy generation can still use **Generate for Session**. Partial streaming frames are never reported or saved as completed assets. Exact parameters: [image tools](complete-reference.md#generate_image).

## Run and inspect commands

- `execute_command` runs a command in a managed terminal. Command approval checks are ordered within each chat session, not across tabs: a pending approval in another tab does not block this session's checks or approval card. All authorization and shared workspace scheduling constraints remain in force.
- `get_terminal_output` reads retained output or controls an observed command. Pass the `command_id` returned by native/sandbox `execute_command` together with `terminal_id` to read the same command after terminal reuse. Omitting it selects the latest command. An unavailable or expired command ID returns an error rather than another command's output; `kill: true` cannot interrupt a newer command when an older ID is selected.
- `close_terminals` closes managed terminals when appropriate.

The standalone CLI has a separate non-PTY command contract. Its `execute_command` uses an exact reviewed `/bin/zsh -c` launch with closed stdin, no persistent shell state, a project-contained working directory, and no sandbox claim. Environment values are omitted from approval and prepared-launch persistence; approvals retain variable names plus a host-keyed digest and revalidate the resolved environment before launch. Values of credential-like environment variables are redacted if a command prints them. `get_command_output`, `list_commands`, and `stop_command` operate on stable session-owned command IDs. Foreground commands hold the project mutation window until exit. Background development processes require typing `allow background` for each exact launch and remain observable through `/processes`, `/output ID`, and `/stop ID`. Retained interleaved output is bounded and reports dropped offsets; restart marks prior running records interrupted without reconnecting or replaying them.

Command history and output retention are bounded, not permanent storage. Earlier command IDs remain readable while their records are retained in an open terminal; closing or reclaiming a terminal retains only its latest command. Read final output before closing and use a returned `output_file` when available. Native/sandbox signal deaths include `signal` and a nonzero `exit_code` (128 + signal when the PTY supplied zero or no exit code), so an aborted process cannot look successful. Carriage returns move the output cursor without erasing text that has not been overwritten.

Command route, network access, shell persistence, and approval behavior depend on policy. Native Agent commands are dispatched through verified private command artifacts so complex approved shell text is not retyped through the interactive line editor. Bare SSH sessions remain blocked, while a command supplied after the SSH host is treated as one-shot/non-interactive. Safe `git init` chains targeting the workspace root receive protected-metadata native-retry guidance before launch. Use the structured recovery guidance returned by a failed command instead of guessing at retries.

Exact command-tool parameters: [terminal tools](complete-reference.md#execute_command).

## Work with people and the session

- `ask_user` asks structured questions.
- `todo_write` maintains visible work state. Todo identifiers and labels must contain non-whitespace text; malformed blank rows are ignored with model-visible correction guidance. The list changes only when the agent calls the tool, so multi-step work should update it at each real task transition.
- `set_task_status` ends a turn with a truthful result.
- `switch_mode` changes the workflow mode.
- `search_session_history` and `read_session_excerpt` retrieve prior context when allowed.

Exact session-tool parameters: [orchestration tools](complete-reference.md#built-in-agent-orchestration-tools).

## Delegate work

- `spawn_background_agent` starts a bounded background task.
- `get_background_status`, `get_background_result`, `steer_background_agent`, and `kill_background_agent` supervise it.
- Fleet workflows can run structured review, browser verification, best-of-N work, or scheduled goals.

Use clear ownership and a focused review scope for writable or review work. Native text and structured reviews receive bounded finalization recovery after an output limit or missing result. Empty text and unfinalized native review output are incomplete, not successful; partial output remains available. Explicit unsuccessful provider/ACP stops cannot turn partial output into a completed review. See [background agents](capabilities.md#background-agents-and-orchestration) and the [full background tool reference](complete-reference.md#spawn_background_agent).

## Connect external capabilities

- `find_mcp_tools` and `call_mcp_tool` discover and invoke configured MCP capabilities.
- Resources and prompts use `list_mcp_resources`, `read_mcp_resource`, `list_mcp_prompts`, and `get_mcp_prompt`.
- Native `web_search` and `web_fetch` may be available according to the configured web-access backend.

A Codex OAuth `web_fetch` can follow the provider's line-addressed continuation. The VS Code host keeps the inline result bounded and returns an AgentLink temp `output_file` for additional retained content; read it with `read_file` rather than repeating the fetch. If the provider still has more than AgentLink retained, continue from `next_start_line` with `start_line`. Browser Ask Agent does not expose host temp-file paths.

MCP configuration and trust behavior: [MCP](mcp.md). Exact native web contracts: [web access](complete-reference.md#web-access).

## Exact contracts and recovery behavior

The [complete product reference tools section](complete-reference.md#tools) is currently the authoritative exhaustive list of input schemas, response shapes, mode availability, and recovery fields. This focused page is the place to start; use the linked section when an exact tool contract matters.
