# Changelog

## Unreleased

### Added

- Added default-on hybrid web access for the built-in VS Code agent and Browser Ask Agent. `auto` selects one supported provider-hosted backend or an explicitly configured SearXNG MCP binding before each request; strict `provider`, `mcp`, and `disabled` strategies are also available.
- Added durable hosted search/fetch activity and safe `http`/`https` citations across live transcripts, restore, retry/fallback, export, browser reconnect, and background-agent views. Provider-private replay stays out of public browser state, logs, and exports.
- Added a one-time installation/upgrade disclosure and persistent `agentlink.webAccess.*` settings for provider charges, external data flow, domain restrictions, bounded usage where supported, and disabling web access before a turn.

### Security

- Treat web search results and fetched pages as untrusted model input in both owning runtimes; embedded prompts must not override the user/system request, reveal secrets, or exfiltrate private/workspace data.
- Provider-hosted web requests may incur additional provider charges and send queries or fetched content to the selected provider. MCP requests send them to the configured server; self-hosted SearXNG does not make upstream search engines private.

### Changed

- Repositioned AgentLink around its built-in VS Code coding agent and browser remote control.
- Removed the retired inbound MCP server and external-agent configuration flows while preserving outbound MCP client support.
- Added conservative cleanup and manual remediation guidance for legacy AgentLink-managed external-agent entries, instruction blocks, and hooks.

### Fixed

- Default new installations to flagship GPT-5.6 Sol while keeping the Pro-only GPT-5.3 Codex Spark model available.
- Migrate persisted selections only after their model is retired, including the former GPT-5.3 Codex default, before session creation, restore, mode switches, or manual model updates.
- Report an unavailable selected model directly instead of misdiagnosing it as unavailable native web search during request preflight.
