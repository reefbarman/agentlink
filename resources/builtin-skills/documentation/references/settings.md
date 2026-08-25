# AgentLink Settings Reference

All settings live under the `agentlink.*` namespace and are set in VS Code Settings (UI or `settings.json`).

**Authoritative source:** `contributes.configuration` in the shipped `package.json` — always confirm exact names, defaults, enum values, and full descriptions there before quoting them. This file groups the settings by area so you can find the right one fast; it lists names and purpose, not full details.

## Model and agent behavior

- `modeModelPreferences` — startup model per mode slug; the last model selected in each mode becomes that mode's default
- `modeReasoningEffortPreferences` — default thinking level per mode slug
- `modelPromptProfiles` — exact model-ID overrides for `compatibility` or compact `reasoning` prompts; a committed frontier cohort (current Claude Opus/Sonnet and full-size Codex models) automatically uses `reasoning`, while unknown, invalid, and small-tier models fail closed to compatibility
- `agentMaxTokens` — max output tokens per response
- `thinkingBudget`, `showThinking` — extended-thinking budget and UI visibility
- `defaultMode` — mode for new sessions
- `anthropic.dynamicModelCapabilities` — refresh Anthropic model metadata from the API
- `provider.maxConcurrentRequests` — cap on simultaneous model requests per provider; queued foreground requests take priority over background and maintenance work

## Context condensing

- `autoCondense` — condense automatically when context fills
- `modelCondenseThresholds` — per-model thresholds (GPT-5.6 defaults to 0.65, other 1M+ context models to 0.85, legacy frontier models to 0.8 when capabilities are unavailable, and remaining models to 0.9); explicit model-ID overrides take precedence

## Autonomous memory

- `memory.mode` — typed autonomous low-authority memory (`autonomous`, the default) or explicitly disable its tools (`off`). Autonomous writes are scope-bound, secret-scanned, quota-bound, revisioned, auditable, and treated as evidence rather than instructions; authoritative instructions, skills, and commands retain reviewed proposal flow. `/memory` opens the no-model inspection/audit/undo/import/export manager. VS Code exposes global and current-project scopes; projectless Browser Ask Agent exposes global scope only.

## Approvals and safety

- `commandAutoApproveTier` — auto-approve commands at or below a safety tier
- `writeRules` — glob patterns whose writes are always auto-approved
- `recentApprovalTtl` — seconds an identical command approval repeats within the same session without re-prompting
- `masterBypass` — skip ordinary command and file-write prompts; native escalation, outside-path reads, MCP tools, protected paths, and read-only/delegation boundaries still apply

## Web access

- `webAccess.searchBackend`, `webAccess.fetchBackend` — expose native web_search/web_fetch and pick backend
- `webAccess.nativeSearchMode` — external access mode for provider-native transports
- `webAccess.allowedDomains` / `webAccess.blockedDomains` — mutually exclusive domain lists; a native route is omitted for the turn if its provider cannot enforce them
- `webAccess.maxSearchUsesPerTurn`, `webAccess.maxFetchUsesPerTurn`, `webAccess.maxFetchContentTokens`, `webAccess.maxReplayBytesPerTurn` — per-turn caps

## MCP

MCP servers are configured in `mcp.json` files, not VS Code settings — see `references/mcp.md`.

## Background agents

- `background.defaultAgent` — backend for `spawn_background_agent` (`native:auto` or `acp:<id>`)
- `background.reviewAgent` — legacy ACP backend for adversarial `review_*` tasks; the ACP entry's declared provider must differ from the foreground provider or native cross-provider routing is retained. Ignored when `background.reviewTarget` is set
- `background.reviewTarget` — machine-scoped provider map for review backends. Each foreground-provider entry (`codex`, `openai-compatible:<connection-id>`, …), plus optional `default`, requires `{ target, effort? }`; target is `native:auto`, `acp:<id>`, or deterministic `model:<local-model-id>`, and effort is checked against the resolved model. ACP targets control their own effort. Unmapped providers use `default`, then legacy `background.reviewAgent`. An explicit spawn `model`/`provider` still wins
- `background.acpAgents` — ACP-compatible stdio agent definitions
- `background.maxConcurrent` — concurrent background agent cap
- `bgSummary.mode` — how background-agent status strings are summarized

## Providers

- `disabledProviders` — provider IDs temporarily removed from model selection and automatic routing without deleting credentials (`anthropic` and `codex` are the built-in IDs)

## Browser gateway (remote control)

- `browserGatewayPort` — stable localhost port for the shared gateway
- `browserGatewayLanAccess` — expose on LAN (requires device pairing via `/pair`)
- `browserGatewayMdnsName` — mDNS hostname (`<name>.local`)
- `browserGateway.dataPlane` — staged data-plane mode: `on` uses the helper relay and is the dogfood default, `shadow` dual-publishes while browsers use legacy traffic, and `off` is the complete legacy rollback

## Semantic codebase search

- `semanticSearchEnabled`, `semanticEmbeddingsEnabled`, `autoIndex`, `indexExclusions`, `chunkGranularity`
- Embedded local LanceDB stores support lexical and structural indexing/search without credentials and are enabled by default. `semanticEmbeddingsEnabled` remains off until explicitly set to `true`; only then can AgentLink send indexed source chunks and search queries to OpenAI for vector and hybrid ranking. Configuring credentials alone never enables embeddings. Each canonical project/workspace-folder root has a reusable code store, isolating unrelated projects while allowing windows that reference the same project to share its index. Current production retrieval does not require Qdrant; legacy Qdrant data and code rows in the former global store require a per-project rebuild rather than in-place migration.

## OpenAI-compatible connections and helper endpoint

- Use **AgentLink: Configure OpenAI-compatible Model** for guided add-only setup. It can query OpenRouter or generic `/models` catalogs, uses editable conservative defaults when metadata is unavailable, and creates one model backed by one connection. Edit/remove entries and advanced multi-model/headers/auxiliary configuration remain in User Settings JSON.
- `openaiCompatible.connections` — machine-scoped named Chat Completions-compatible connections with nested models. Connections own endpoint/auth/profile behavior, including the bounded `reasoningEffortMode` request mapping (`none`, `reasoning_effort`, `reasoning.effort`, or `output_config.effort`); models own stable local IDs, opaque wire IDs, context/output limits, declared tool/thinking/image capabilities, and optional `modelFamily` prompt behavior (`anthropic` or `openai`) for proxy-hosted vendor models.
- The wizard can select or create a named SecretStorage credential; maintain credentials separately with **AgentLink: Set OpenAI-compatible API Key** and **AgentLink: Clear OpenAI-compatible API Key**. Settings hold only non-secret `authKey` names; values remain in VS Code SecretStorage.
- Authenticated endpoints must use HTTPS or loopback HTTP unless `allowInsecureHttp` is explicitly enabled. AgentLink rejects redirects and unsafe static headers.
- `openaiCompatible.baseUrl`, `.model`, `.apiKey`, and `.timeoutMs` are separate, window-scoped helper configuration for question detection/background summaries (for example LM Studio). The plaintext `.apiKey` is not used by configured chat connections.
- `questionDetection.mode` — heuristic vs LLM question detection

## Codex / OpenAI provider

- `codexStatefulResponses` — OpenAI Responses chaining via `previous_response_id`
- `codexStoreResponses` — set `store=true` on Responses requests
- `codexProMode` — GPT-5.6 Pro reasoning mode for API-key requests
- `codex.textVerbosity` — final-message verbosity (`text.verbosity`) for Codex agent turns: `default` sends `low` for GPT-5.6 models and omits the parameter for older ones; `off` never sends it; `low`/`medium`/`high` force a level for all Codex models. Does not affect detached requests such as condensing. If an endpoint rejects the parameter, the request is retried once without it.

## Terminal, worktrees, misc

- `terminal.enabled`, `terminal.nodePath` — sandbox-backed AgentLink terminals (macOS hosts)
- `terminal.environmentPolicy` — sandbox command environment inheritance; the default inherits all host variables, including credential-like names, while helper-reserved variables remain host-controlled
- `worktreeDirectorySuffix` — sibling worktree container naming for the manual `/worktree` flow
- `diagnosticDelay` — ms to wait after save for diagnostics to settle
