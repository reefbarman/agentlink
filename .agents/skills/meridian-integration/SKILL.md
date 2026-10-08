---
name: meridian-integration
description: Maintain AgentLink's Meridian companion plugin when changing tools, provider transport, prompts, session identity, or Meridian integration; diagnose delayed tool handoffs through Meridian.
---

AgentLink owns tools and approvals; Meridian bridges requests through the Claude
Agent SDK. Read `integrations/meridian-plugin-agentlink/README.md` and the plugin's
`index.js` before changing this integration. The runtime user's setup guide is
`resources/builtin-skills/documentation/references/providers.md`.
For this machine's endpoint and installed-plugin workflow, read
`references/local-setup.md` relative to this skill. Reinspect the running service
before assuming that snapshot is still current.

The plugin loads the supplied catalog eagerly instead of copying tool names.
Adding or renaming a tool normally needs no Meridian change. Check these seams:

- The foreground/background system prompt must retain the leading `You are
AgentLink,` identity used by the plugin. Update detection/tests if it changes.
- `meridianSessionAffinity` must keep sending the live conversation ID as
  `x-session-affinity`. Never replace it with a static header shared by chats.
- The OpenAI translator must preserve each tool's name, schema, arguments and
  matched result ID. New deferral flags need explicit compatibility review:
  deferred tools can lift Meridian's one-turn cap and restore hidden generation.
- Native tools and MCP tools execute in AgentLink, not in Meridian. Preserve
  approvals, parallel call envelopes, real result continuation and final
  `set_task_status` delivery. Keep the plugin scoped to AgentLink requests.
- Meridian pins deferral per session. Evaluate changed policy in fresh chats;
  do not attribute an old session's retained policy to plugin failure.

Before tuning tool disclosure, run the repository's tool, context and session
telemetry reports as required by `CLAUDE.md`. After changes, run the plugin tests,
the live `probe.mjs` command in the plugin README, and affected AgentLink provider tests. For behavior
changes, use the implicated model and actual AgentLink OpenAI completion facade
against a real Meridian/SDK instance; mocks cannot establish latency savings.
Record SDK calls, hidden output, tool completion, resume, and cache behavior.
Use synthetic fixture files and avoid logging credentials or real prompt text.

Update plugin/package docs, this skill, and the bundled provider guide together
when the contract changes. Do not claim npm publication or activate/restart other
users' services merely because code changed. Honor the user's requested scope.

The local installer copies the plugin, so source edits do not automatically reach
the running service. When a requested local integration update requires a plugin
change, reinstall the copy and reload plugins, then verify active status and a
fresh conversation. Keep other plugins and clients' policies intact.
