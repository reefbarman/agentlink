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

Switch with `/mode <slug>` or the mode selector. Default mode: `agentlink.defaultMode`. Projects can add or override modes via `modes.json` (see `references/customization.md`).

## Models and providers

- Model picker is built into the chat UI (`/model`). Per-mode defaults: `agentlink.modeModelPreferences`; per-mode thinking level: `agentlink.modeReasoningEffortPreferences`.
- Auth: command palette entries **AgentLink: Set Anthropic API Key**, **AgentLink: Set OpenAI API Key**, **AgentLink: Sign In to OpenAI/Codex** (ChatGPT/Codex OAuth, multi-account management available).
- Anthropic model metadata (context window, output tokens, reasoning efforts) refreshes lazily from the API; toggle with `agentlink.anthropic.dynamicModelCapabilities`.
- A local OpenAI-compatible endpoint (`agentlink.openaiCompatible.*`, e.g. LM Studio) powers helper features: question detection and background-agent status summaries.

## Built-in slash commands

`/new`, `/mode`, `/model`, `/condense`, `/checkpoint`, `/revert`, `/help`, `/remember`, `/skills`, `/mcp`, `/mcp-config`, `/mcp-refresh`, `/btw`, `/worktree`, `/pair`, `/usage`. Custom commands and detected skills appear in the same picker (see `references/customization.md`).

- `/btw <question>` — quick side question in a forked read-only session; answer can be promoted into the main transcript. VS Code-only.
- `/worktree [task] [--branch <name>]` — set up isolated work without interrupting the current turn; missing details are gathered in a small text session, followed by inline **Create & start** / **Create & prefill** actions in the Activity Shelf. VS Code-only.
- `/pair` — pairing code for a new browser remote device.
- `/usage` — Codex subscription usage and reset times.

## Context management

- **Auto-condense** compresses the conversation when the context window fills (`agentlink.autoCondense`, per-model thresholds in `agentlink.modelCondenseThresholds`); `/condense` triggers it manually.
- **Checkpoints** (`/checkpoint`, `/revert`) snapshot the workspace into AgentLink's own shadow git repo under `.agentlink/checkpoints/` — separate from the project's real git history.
- Sessions persist and restore across VS Code reloads.

## Approvals

Command, write, rename, MCP, and mode-switch approvals render inline in chat, with a separate approval panel for focused review. Key knobs:

- `agentlink.commandAutoApproveTier` — auto-approve terminal commands at or below a safety tier (default `safe`).
- `agentlink.writeRules` — glob patterns always auto-approved for writes.
- `agentlink.recentApprovalTtl` — repeat identical commands auto-approve within a window.
- `agentlink.masterBypass` — skip ALL approvals (use with caution).
- **Approve for Me** selects sandbox-first execution with a separate Guardian reviewer. Routine baseline commands run without a model call; dangerous commands and requests for managed public network or native host authority receive an exact allow/deny review. Invalid, unavailable, timed-out, or cancelled reviews fail closed, repeated reviewed denials interrupt the turn, and one-shot authority never transfers to another command or child agent.
- Explicit command `allow` rules intentionally follow Codex-style authority: exact/prefix matches skip future approval and may run outside the Protected Terminal with normal user permissions when every safely parsed command segment is explicitly allowed. Prompt/forbidden rules take precedence. Regex allow rules and legacy rules remain sandboxed approval shortcuts; command-only rules do not promote inline files, environment overrides, validator forcing, managed-network requests, or explicit escalation. Broad shell/interpreter/wrapper prefixes are not suggested automatically; manual creation remains possible but is warning- and confirmation-gated.
- `execute_command.sandbox_permissions` accepts `use_default`, `require_managed_network`, or `require_escalated`. Managed network stays sandboxed behind AgentLink's attributed proxy: private/local destinations are blocked, and each resolved public HTTP/CONNECT/SOCKS destination pauses before its retained numeric dial. Approve for Me uses a network-specific Guardian; manual mode and exact `protocol://host:port` prompt rules use the shared network card. Redirects and later sockets are reviewed again, network rules never reuse command approval caches, and encrypted paths/payloads/credentials remain unknown. A native route authorized by an exact/prefix command allow rule instead uses normal host networking and bypasses managed destination review. `require_escalated` requests native host authority when no rule supplies it. Boundary requests require a reason.
- Session approvals can be cleared and command policies added via command palette entries. The creation, approval-card, and Trusted Commands surfaces label native exact/prefix authority separately from sandboxed regex and legacy approval-only rules. Rules are persisted independently per chat session across VS Code windows, and active session use refreshes their 24-hour retention window.
- `diagnose_activity` lets the agent inspect bounded, redacted evidence for recent tool results, warnings, errors, and recorded authorization provenance in its own session. Use `search_session_history` alongside it when exact historical transcript context is needed.

Accepted write results identify whether authority came from master bypass, the architect-plan exception, a session/project/global blanket approval, a workspace setting, a matching write rule, or an interactive human decision. Diagnostic evidence is bounded and can report truncation; missing evidence is not proof that an operation did not occur.

## Background agents and orchestration

The agent can spawn parallel background agents for review/research (`spawn_background_agent` and related status/steer/kill tools). `agentlink.background.maxConcurrent` caps concurrency; `agentlink.background.defaultAgent` picks the backend (`native:auto` or a configured ACP stdio agent from `agentlink.background.acpAgents`). Review mode routes review work to background agents. `start_worktree_agent` launches agents in isolated git worktrees.

Native background children inherit the parent's effective command mode and session-scoped write, path, command, network, and MCP approvals. Parent grants made later flow additively to active descendants, while child-only grants and prior inherited authority remain isolated. ACP children receive the session snapshot and can reuse write/path authority for requests with complete structured file locations; opaque provider-defined command and MCP requests still prompt. Isolated-worktree agents inherit only the command mode because their approvals live in a separate VS Code process. One-shot authority never transfers.

Inherited authority does not weaken write safeguards: outside-workspace targets, including symlinks resolving outside, still require a matching file rule, and protected instruction or memory files still require explicit approval.

## Browser remote control

A local gateway serves a browser UI that mirrors sessions, approvals, questions, background activity, and read-only diff review — one stable URL (`agentlink.browserGatewayPort`) switches between all open VS Code windows. LAN access for phones/other devices is opt-in (`agentlink.browserGatewayLanAccess`, mDNS name via `agentlink.browserGatewayMdnsName`) and requires per-device pairing (`/pair`). The browser surface is intentionally read-only for diffs and has no shell or write paths. Browser Ask Agent has its own MCP config source.

## Web access

Native `web_search` / `web_fetch` tools with configurable backends, domain allow/deny lists, and per-turn caps — all under `agentlink.webAccess.*`. See the README `## Web Access` section for cost/privacy notes.

## Semantic codebase search

Optional `codebase_search` tool backed by a Qdrant vector index with OpenAI embeddings: `agentlink.semanticSearchEnabled`, `agentlink.qdrantUrl`, `agentlink.autoIndex`, `agentlink.indexExclusions`, `agentlink.chunkGranularity`. Setup steps: README `## Semantic Codebase Search Setup`.

## AgentLink Terminal

Sandbox-backed terminals on supported local macOS hosts (`agentlink.terminal.enabled`, `agentlink.terminal.nodePath`). Requirements: README `### AgentLink Terminal requirements`.

## Editor entry points

**Add File to Chat**, **Add Selection to Chat**, **Explain with AgentLink**, **Fix with AgentLink** push editor context into the chat without copy/paste.

## Images in chat

Image-returning tools, including MCP screenshot tools, retain previews inside their collapsed tool-call results by default so routine agent inspection does not crowd the transcript. When the user explicitly asks to see an image or screenshot, the agent can call `present_images` to show an existing session image directly in the main transcript without writing a file, consuming generation quota, or requesting approval. The tool can select exact `image_N` IDs or recent images and works in both VS Code chat and Browser Ask Agent. See the README `### present_images` tool section for parameters and response details.
