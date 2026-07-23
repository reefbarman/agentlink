# AgentLink Settings Reference

All settings live under the `agentlink.*` namespace and are set in VS Code Settings (UI or `settings.json`).

**Authoritative source:** `contributes.configuration` in the shipped `package.json` — always confirm exact names, defaults, enum values, and full descriptions there before quoting them. This file groups the settings by area so you can find the right one fast; it lists names and purpose, not full details.

## Model and agent behavior

- `agentModel` — legacy global fallback model; prefer `modeModelPreferences`
- `modeModelPreferences` — default model per mode slug
- `modeReasoningEffortPreferences` — default thinking level per mode slug
- `agentMaxTokens` — max output tokens per response
- `thinkingBudget`, `showThinking` — extended-thinking budget and UI visibility
- `defaultMode` — mode for new sessions
- `anthropic.dynamicModelCapabilities` — refresh Anthropic model metadata from the API
- `provider.maxConcurrentRequests` — cap on simultaneous streaming model requests per provider

## Context condensing

- `autoCondense` — condense automatically when context fills
- `modelCondenseThresholds` — per-model thresholds (1M+ context models default 0.7, others 0.9)
- `autoCondenseThreshold` — legacy global threshold, kept for migration

## Approvals and safety

- `commandAutoApproveTier` — auto-approve commands at or below a safety tier
- `writeRules` — glob patterns whose writes are always auto-approved
- `recentApprovalTtl` — seconds a single-use command approval repeats without re-prompting
- `masterBypass` — skip ALL approval prompts

## Web access

- `webAccess.searchBackend`, `webAccess.fetchBackend` — expose native web_search/web_fetch and pick backend
- `webAccess.nativeSearchMode` — external access mode for provider-native transports
- `webAccess.allowedDomains` / `webAccess.blockedDomains` — mutually exclusive domain lists; a native route is omitted for the turn if its provider cannot enforce them
- `webAccess.maxSearchUsesPerTurn`, `webAccess.maxFetchUsesPerTurn`, `webAccess.maxFetchContentTokens`, `webAccess.maxReplayBytesPerTurn` — per-turn caps

## MCP

MCP servers are configured in `mcp.json` files, not VS Code settings — see `references/mcp.md`.

## Background agents

- `background.defaultAgent` — backend for `spawn_background_agent` (`native:auto` or `acp:<id>`)
- `background.acpAgents` — ACP-compatible stdio agent definitions
- `background.maxConcurrent` — concurrent background agent cap
- `bgSummary.mode` — how background-agent status strings are summarized

## Browser gateway (remote control)

- `browserGatewayPort` — stable localhost port for the shared gateway
- `browserGatewayLanAccess` — expose on LAN (requires device pairing via `/pair`)
- `browserGatewayMdnsName` — mDNS hostname (`<name>.local`)

## Semantic codebase search

- `semanticSearchEnabled`, `qdrantUrl`, `autoIndex`, `indexExclusions`, `chunkGranularity`

## OpenAI-compatible connections and helper endpoint

- Use **AgentLink: Configure OpenAI-compatible Model** for guided add-only setup. It can query OpenRouter or generic `/models` catalogs, uses editable conservative defaults when metadata is unavailable, and creates one model backed by one connection. Edit/remove entries and advanced multi-model/headers/auxiliary configuration remain in User Settings JSON.
- `openaiCompatible.connections` — machine-scoped named Chat Completions-compatible connections with nested models. Connections own endpoint/auth/profile behavior; models own stable local IDs, opaque wire IDs, context/output limits, and declared tool/thinking/image capabilities.
- The wizard can select or create a named SecretStorage credential; maintain credentials separately with **AgentLink: Set OpenAI-compatible API Key** and **AgentLink: Clear OpenAI-compatible API Key**. Settings hold only non-secret `authKey` names; values remain in VS Code SecretStorage.
- Authenticated endpoints must use HTTPS or loopback HTTP unless `allowInsecureHttp` is explicitly enabled. AgentLink rejects redirects and unsafe static headers.
- The legacy `openaiCompatible.baseUrl`, `.model`, `.apiKey`, and `.timeoutMs` settings remain separate, window-scoped helper configuration for question detection/background summaries (for example LM Studio). The plaintext `.apiKey` is not used by configured chat connections.
- `questionDetection.mode` — heuristic vs LLM question detection (`questionDetection.llmEnabled`/`baseUrl`/`model`/`apiKey`/`timeoutMs` are deprecated aliases)

## Codex / OpenAI provider

- `codexStatefulResponses` — OpenAI Responses chaining via `previous_response_id`
- `codexStoreResponses` — set `store=true` on Responses requests
- `codexProMode` — GPT-5.6 Pro reasoning mode for API-key requests

## Terminal, worktrees, misc

- `terminal.enabled`, `terminal.nodePath` — sandbox-backed AgentLink terminals (macOS hosts)
- `terminal.environmentPolicy` — sandbox command environment inheritance; the default inherits all host variables, including credential-like names, while helper-reserved variables remain host-controlled
- `worktreeDirectorySuffix` — sibling worktree container naming for `start_worktree_agent`
- `diagnosticDelay` — ms to wait after save for diagnostics to settle
