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
- `webAccess.allowedDomains` / `webAccess.blockedDomains` — mutually exclusive domain lists; fail closed if unenforceable
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
- `browserGateway.dataPlane` — staged data-plane mode: `on` uses the helper relay and is the dogfood default, `shadow` dual-publishes while browsers use legacy traffic, and `off` is the complete legacy rollback

## Semantic codebase search

- `semanticSearchEnabled`, `qdrantUrl`, `autoIndex`, `indexExclusions`, `chunkGranularity`

## OpenAI-compatible helper endpoint

Used by question detection and background summaries (e.g. LM Studio):

- `openaiCompatible.baseUrl`, `openaiCompatible.model`, `openaiCompatible.apiKey`, `openaiCompatible.timeoutMs`
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
