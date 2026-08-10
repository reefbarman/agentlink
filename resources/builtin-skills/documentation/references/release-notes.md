# Changelog

## Unreleased

### Added

- Added local workspace-history continuity: when folders are added, AgentLink can branch-copy prior chat history into the expanded workspace shape and preserve the source. Automatic migration does not run for reverse folder-removal transitions or into a destination that already has history; those cases remain explicit recovery work. Migration now shows flush, inspection, copy, publication, and reload progress. Added `/workspace` and **AgentLink: Show Workspace History** for exact history-location diagnostics and recovery.
- Added `agentlink.semanticEmbeddingsEnabled`, an explicit opt-in for OpenAI embeddings. Local lexical and structural codebase retrieval is enabled by default and remains on-device; configured credentials alone never send indexed source chunks or search queries to OpenAI.
- Added project-level `.agentlink/AGENTS.md` instructions, preferred over the existing `.agentlink/CLAUDE.md` fallback, and documented `AGENTS.local.md` for uncommitted personal project guidance.
- Added default-on hybrid web access for the built-in VS Code agent and Browser Ask Agent. `auto` selects one supported provider-hosted backend or an explicitly configured SearXNG MCP binding before each request; strict `provider`, `mcp`, and `disabled` strategies are also available.
- Added durable hosted search/fetch activity and safe `http`/`https` citations across live transcripts, restore, retry/fallback, export, browser reconnect, and background-agent views. Provider-private replay stays out of public browser state, logs, and exports.
- Added a one-time installation/upgrade disclosure and persistent `agentlink.webAccess.*` settings for provider charges, external data flow, domain restrictions, bounded usage where supported, and disabling web access before a turn.

### Security

- Treat web search results and fetched pages as untrusted model input in both owning runtimes; embedded prompts must not override the user/system request, reveal secrets, or exfiltrate private/workspace data.
- Provider-hosted web requests may incur additional provider charges and send queries or fetched content to the selected provider. MCP requests send them to the configured server; self-hosted SearXNG does not make upstream search engines private.

### Changed

- Made the helper-owned browser relay/data plane the dogfood default through `agentlink.browserGateway.dataPlane`; `shadow` retains dual publication with legacy browser traffic, and `off` preserves complete snapshot/proxy rollback while semantic parity work continues.
- Hide the Agent Fleet panel after every background agent finishes, while keeping paused work visible and adding `/fleet` to reveal completed results again in VS Code or the browser remote.
- `get_background_result` now returns early with `status: "wait_interrupted"` when a user message is interjected into the waiting session (including steering a blocked background parent), so new instructions no longer wait behind a long-running background agent. The background agent keeps running; the agent handles the message and re-waits.
- Matched Codex-style sandbox loopback behavior on supported local macOS hosts: baseline commands can connect to loopback services but cannot bind TCP listeners, while a fresh exact-command `allow_local_binding` capability review permits listeners without granting public or private outbound access.
- Coupled Approve for Me to session-scoped writes: enabling it enables session writes, turning session writes back to Prompt disables it, and both remain active across mode switches only while Approve for Me is active.
- Extended Guardian with fail-closed one-shot review for supported outside-workspace reads/single-file writes and fully enumerable `find_and_replace` proposals that reach outside the workspace. Multi-file grants atomically bind the complete canonical affected-file set and every file's full baseline/proposed content; canonical or sensitive-path rejection, dirty documents, evidence limits, and drift fall back to human review. Guardian never persists rules. Under Approve for Me, mode switches proceed immediately without Guardian or user approval. Arbitrary `rename_symbol` edits remain human-reviewed when authority is missing because VS Code cannot expose a provably complete resource-operation set; every rename target now uses per-target authority, so outside targets cannot inherit blanket session/project/global write approval. Editor apply and authorization are atomic, while later disk-save failures are reported rather than treated as transactional rollback.
- Added a foreground sandbox interactive-prompt watchdog. High-confidence prompts terminate the sandbox process group after a short inactivity grace and return `termination_reason: "interactive_prompt"` without native retry; background commands remain observation-only through `get_terminal_output`.
- Repositioned AgentLink around its built-in VS Code coding agent and browser remote control.
- Removed the retired inbound MCP server and external-agent configuration flows while preserving outbound MCP client support.
- Added conservative cleanup and manual remediation guidance for legacy AgentLink-managed external-agent entries, instruction blocks, and hooks.

### Fixed

- Fixed premature "terminal pool exhausted" failures in the implicit agent terminal pool. Background commands — including foreground commands that time out or are handed to background — now release their foreground pool slot while running and count against a separate, larger background limit; commands that arrive while the pool is busy wait for a slot instead of failing immediately (fixing a race that reported exhaustion while every terminal was idle); channels rejoin the pool when their background command finishes; and the exhaustion error now names only the actually busy terminals with their running commands instead of blaming every terminal.
- Fixed slow AgentLink terminal rendering during sustained heavy output. PTY and sandbox output is now coalesced for a few milliseconds before parsing and delivery (mirroring VS Code's pty-host data buffering), and the terminal webview writes each run of output to xterm in one call, cutting per-chunk postMessage/acknowledgment round trips and eliminating forced replay resyncs caused by render-queue batch overflow.
- Default new installations to flagship GPT-5.6 Sol while keeping the Pro-only GPT-5.3 Codex Spark model available.
- Migrate persisted selections only after their model is retired, including the former GPT-5.3 Codex default, before session creation, restore, mode switches, or manual model updates.
- Report an unavailable selected model directly instead of misdiagnosing it as unavailable native web search during request preflight.
