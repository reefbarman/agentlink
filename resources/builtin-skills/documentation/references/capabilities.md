# AgentLink Capabilities Overview

AgentLink is a VS Code extension whose built-in agent chats in the sidebar, edits files through diff views, runs commands in the integrated terminal, and uses VS Code diagnostics, symbol navigation, code actions, and rename support. It connects to MCP servers, spawns background agents, and can be remote-controlled from a browser.

For any per-tool details (parameters, response shape), read the `## Tools` section of the shipped README.

## Modes

| Mode        | Purpose                                                                            |
| ----------- | ---------------------------------------------------------------------------------- |
| `code`      | Primary implementation mode: read, edit, run commands, navigate symbols, MCP tools |
| `architect` | Planning and design with read/search/language tools                                |
| `ask`       | Lightweight Q&A with read/search tools only                                        |
| `debug`     | Investigation with commands, language tools, and search                            |
| `review`    | Focused code review with structured review output                                  |

Switch with `/mode <slug>` or the mode selector. Default mode: `agentlink.defaultMode`. In foreground sessions, mode instructions travel in-conversation (`<current_mode>` blocks) and all modes' tools are advertised for prompt-cache stability across switches; out-of-mode tool calls are rejected at invocation with guidance to `switch_mode`. Projects can add or override modes via `modes.json` (see `references/customization.md`). With no workspace folder open, AgentLink instead starts a non-persistent, Ask-only projectless chat using global model/reasoning/context settings. Self-contained pasted or dropped images/PDFs remain available, but workspace files, path attachments, shell/editor tools, MCP, checkpoints, and approval controls require an open folder.

## Models and providers

- Model picker is built into the chat UI (`/model`). Per-mode defaults: `agentlink.modeModelPreferences`; per-mode thinking level: `agentlink.modeReasoningEffortPreferences`.
- Auth: command palette entries **AgentLink: Set Anthropic API Key**, **AgentLink: Set OpenAI API Key**, **AgentLink: Sign In to OpenAI/Codex** (ChatGPT/Codex OAuth, multi-account management available), plus secure set/clear commands for named OpenAI-compatible connection keys.
- Anthropic model metadata (context window, output tokens, reasoning efforts) refreshes lazily from the API; toggle with `agentlink.anthropic.dynamicModelCapabilities`.
- **AgentLink: Configure OpenAI-compatible Model** is the guided, add-only setup path. It selects or creates a named credential, performs bounded user-invoked OpenRouter/generic `/models` discovery with manual fallback and editable conservative defaults, then adds one model backed by one connection. Edit/remove and advanced multi-model settings remain in User Settings JSON.
- `agentlink.openaiCompatible.connections` configures multiple named OpenAI Chat Completions-compatible endpoints (for example OpenRouter or no-auth LM Studio/vLLM) and multiple declared models per connection. Each has a stable local selector ID separate from the upstream wire model ID. Text, reasoning, images when declared, tool calls, replay, usage estimates, condensing/helper calls, and Browser Ask Agent share the portable runtime. Chat-only models remain selectable but are excluded from automatic background routing. Browser Ask Agent can use wizard-created models but cannot write configuration or credentials.
- The legacy local OpenAI-compatible helper settings (`agentlink.openaiCompatible.baseUrl`, `.model`, `.apiKey`, `.timeoutMs`) remain separate for question detection and background-agent status summaries.
- **Polish prompt** — sparkle button in the composer toolbar rewrites the draft (spelling, grammar, wording) with the current provider's fast model before sending; a revert button restores the original text. Available in VS Code chat and the browser remote; uses model quota. See the README "Core built-in agent features" section.

## Built-in slash commands

`/new`, `/mode`, `/model`, `/condense`, `/checkpoint`, `/revert`, `/help`, `/fleet`, `/remember`, `/skills`, `/mcp`, `/mcp-config`, `/mcp-refresh`, `/btw`, `/worktree`, `/pair`, `/usage`. Custom commands and detected skills appear in the same picker (see `references/customization.md`).

- `/btw <question>` — quick side question in a forked read-only session; answer can be promoted into the main transcript. VS Code-only.
- `/worktree [task] [--branch <name>]` — set up isolated work without interrupting the current turn; missing details are gathered in a small text session, followed by inline **Create & start** / **Create & prefill** actions in the Activity Shelf. VS Code-only.
- `/pair` — pairing code for a new browser remote device.
- `/usage` — Codex subscription usage and reset times.

## Context management

- **Auto-condense** compresses the conversation when the context window fills (`agentlink.autoCondense`, per-model thresholds in `agentlink.modelCondenseThresholds`) and deterministically reattaches the current structured TODO list with its completed, in-progress, and pending states. Resume guidance tells the agent to reconcile stale status against the checkpoint/workspace rather than repeat already-completed work; `/condense` triggers it manually.
- **Checkpoints** (`/checkpoint`, `/revert`) snapshot the workspace into AgentLink's own shadow git repo under `.agentlink/checkpoints/` — separate from the project's real git history.
- Sessions persist and restore across VS Code reloads.

## Approvals

Command, write, rename, MCP, and mode-switch approvals render inline in chat, with a separate approval panel for focused review. Key knobs:

- `agentlink.commandAutoApproveTier` — auto-approve terminal commands at or below a safety tier (default `safe`).
- `agentlink.writeRules` — glob patterns always auto-approved for writes.
- `agentlink.recentApprovalTtl` — repeat identical commands auto-approve within the same session and a bounded window.
- `agentlink.masterBypass` — skip ordinary command and file-write prompts; native escalation, outside-path reads, MCP tools, protected paths, and read-only/delegation boundaries still apply.
- **Approve for Me** selects sandbox-first execution with a separate Guardian reviewer and enables session-scoped writes. Turning session writes back to Prompt disables Approve for Me. While Approve for Me remains active, both settings survive mode switches; session writes selected without it reset to Prompt on a mode switch. Reloading may restore an existing session's valid policy, but a new chat starts with Approve for Me off and no inherited session authority. Routine baseline commands run without a model call; dangerous commands and requests for listener binding, managed public network, native host authority, exact non-silent mode switches, supported outside-workspace reads/single-file writes, and fully enumerable `find_and_replace` proposals that reach outside the workspace receive an exact allow/deny review. Command reviews include host-measured filesystem evidence — bounded contents of workspace/temp script files the command would execute (metadata only elsewhere) and location/type/size/entry facts for `rm`/`rmdir` targets — so wrapper scripts are judged by their body and bounded deletes of generated artifacts can be allowed on their merits. Under Approve for Me the agent routes mode changes through `switch_mode` for Guardian review instead of asking the user for mode-switch or plan-approval consent (architect mode proceeds to implementation after self-review), while still asking questions when it genuinely needs user input. Multi-file write grants bind the current session and policy plus the complete canonical affected-file set and every file's full baseline/proposed content, then are consumed once for that complete proposal under all target locks. Canonical or sensitive-path rejection, dirty documents, incomplete or over-limit evidence, and action drift fall back to human approval. Guardian cannot persist mode/path/write/project/global trust, and one-shot authority never transfers to another action or child agent. Arbitrary `rename_symbol` edits stay human-reviewed when per-target authority is missing because VS Code's public edit entries cannot prove that no hidden resource operations exist; outside rename targets cannot inherit blanket session/project/global write approval. Editor application and authorization cover the accepted edit as a unit, while later disk-save failures are reported separately.
- Explicit command `allow` rules intentionally follow Codex-style authority: exact/prefix matches skip future approval and may run outside the Protected Terminal with normal user permissions when every safely parsed command segment is explicitly allowed. Prompt/forbidden rules take precedence. Regex allow rules and legacy rules remain sandboxed approval shortcuts; command-only rules do not promote inline files, environment overrides, validator forcing, managed-network requests, or explicit escalation. Broad shell/interpreter/wrapper prefixes are not suggested automatically; manual creation remains possible but is warning- and confirmation-gated.
- The baseline sandbox allows loopback client connections but blocks listener binding and public/LAN egress. `execute_command.sandbox_permissions` accepts `use_default`, `with_additional_permissions`, `require_managed_network`, or `require_escalated`. Pair `with_additional_permissions` with `additional_permissions.network.allow_local_binding: true` for a fresh exact-command listener review; on macOS this authorizes wildcard local binding, while outbound access remains separately constrained. Managed network stays sandboxed behind AgentLink's attributed proxy: private/local destinations are blocked, and each resolved public HTTP/CONNECT/SOCKS destination pauses before its retained numeric dial. Approve for Me uses a network-specific Guardian; manual mode and exact `protocol://host:port` prompt rules use the shared network card. Redirects and later sockets are reviewed again, network rules never reuse command approval caches, and encrypted paths/payloads/credentials remain unknown. A native route authorized by an exact/prefix command allow rule instead uses normal host networking and bypasses managed destination review. `require_escalated` requests native host authority when no rule supplies it. Boundary requests require a reason.
- Session approvals can be cleared and command policies added via command palette entries. The creation, approval-card, and Trusted Commands surfaces label native exact/prefix authority separately from sandboxed regex and legacy approval-only rules. Rules and MCP session grants are persisted independently per chat session across VS Code windows, and active session use refreshes their 24-hour retention window.
- Project/global command, path, write, and MCP choices fail closed with an explicit error when the backing config file cannot be updated.
- `diagnose_activity` lets the agent inspect bounded, redacted evidence for recent tool results, warnings, errors, and recorded authorization provenance in its own session. Use `search_session_history` alongside it when exact historical transcript context is needed.

Accepted write results identify whether authority came from master bypass, the architect-plan exception, a session/project/global blanket approval, a workspace setting, a matching write rule, a one-shot Guardian review, or an interactive human decision. Guardian outside-file review never creates a rule. Protected instruction/memory files, `.env*`, `.ssh`, `.aws`, `.gnupg`, authenticated CLI configuration, unresolved/ambiguous paths, dirty documents, incomplete or over-limit write evidence, and drift stay human-only. Diagnostic evidence is bounded and can report truncation; missing evidence is not proof that an operation did not occur.

## Background agents and orchestration

The agent can spawn parallel background agents for review/research (`spawn_background_agent` and related status/steer/kill tools). `agentlink.background.maxConcurrent` caps concurrency; `agentlink.background.defaultAgent` picks the backend (`native:auto` or a configured ACP stdio agent from `agentlink.background.acpAgents`). Review mode routes review work to background agents. Agents cannot launch worktrees; isolated worktree windows are available only through the user-controlled `/worktree` VS Code flow.

Native background-agent questions go first to the root foreground coordinator. It answers from the existing task, delegation, and workspace context with `respond_to_background_question`; if the answer genuinely needs human judgment or human-only information, the coordinator escalates through its own `ask_user`. Detached agents or sessions without an available coordinator use the direct human question flow. The fleet reports `awaiting_coordinator` while this handoff is pending.

The Agent Fleet panel remains visible while agents are running or paused, then hides after every agent finishes. `/fleet` reveals the completed fleet again in both VS Code and the browser remote.

Native background children inherit the parent's effective command mode and session-scoped write, path, command, network, and MCP approvals. Later parent mode changes and grants flow to active descendants in that tab's agent tree, while child-only grants and prior inherited authority remain isolated. Review and read-only research children can run beside a foreground writer; their MCP surface is restricted to tools whose servers explicitly set `readOnlyHint: true`, and unannotated MCP tools are unavailable. ACP children receive the session snapshot and can reuse write/path authority for requests with complete structured file locations; opaque provider-defined command and MCP requests still prompt. Recent human command approvals and queued path approvals remain session-bound, and Guardian one-shot authority never transfers.

Inherited authority does not weaken write safeguards: outside-workspace targets, including symlinks resolving outside, still require a matching file rule, and protected instruction or memory files still require explicit approval.

## Browser remote control

A local gateway serves a browser UI that mirrors sessions, approvals, questions, background activity, and read-only diff review — one stable URL (`agentlink.browserGatewayPort`) switches between all open VS Code windows. The bounded helper-owned relay/event data plane is the dogfood default; `agentlink.browserGateway.dataPlane` can select shadow dual-publication or the complete legacy rollback while semantic parity work continues. LAN access for phones/other devices is opt-in (`agentlink.browserGatewayLanAccess`, mDNS name via `agentlink.browserGatewayMdnsName`) and requires per-device pairing (`/pair`). The browser surface is intentionally read-only for diffs and has no shell or write paths. Browser Ask Agent has its own MCP config source and can use the same configured OpenAI-compatible models; endpoint profiles and credentials stay server-side, owner/generation-bound, and absent from browser snapshots and JavaScript.

## Web access

Native `web_search` / `web_fetch` tools with configurable backends, domain allow/deny lists, and per-turn caps — all under `agentlink.webAccess.*`. See the README `## Web Access` section for cost/privacy notes.

## Semantic codebase search

Optional `codebase_search` tool backed by a Qdrant vector index with OpenAI embeddings: `agentlink.semanticSearchEnabled`, `agentlink.qdrantUrl`, `agentlink.autoIndex`, `agentlink.indexExclusions`, `agentlink.chunkGranularity`. Setup steps: README `## Semantic Codebase Search Setup`.

## AgentLink Terminal

Sandbox-backed terminals on supported local macOS hosts (`agentlink.terminal.enabled`, `agentlink.terminal.nodePath`). Foreground sandbox commands that end in a high-confidence interactive prompt are terminated after a short inactivity grace and return structured `interactive_prompt` termination evidence without native retry. Background commands remain observation-only and expose prompt hints through `get_terminal_output`. Requirements: README `### AgentLink Terminal requirements`.

## Editor entry points

**Add File to Chat**, **Add Selection to Chat**, **Explain with AgentLink**, **Fix with AgentLink** push editor context into the chat without copy/paste.

## Images in chat

Image-returning tools, including MCP screenshot tools, retain previews inside their collapsed tool-call results by default so routine agent inspection does not crowd the transcript. When the user explicitly asks to see an image or screenshot, the agent can call `present_images` to show an existing session image directly in the main transcript without writing a file, consuming generation quota, or requesting approval. The tool can select exact `image_N` IDs or recent images and works in both VS Code chat and Browser Ask Agent. See the README `### present_images` tool section for parameters and response details.
