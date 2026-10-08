# AgentLink tools for Meridian

This standalone Meridian plugin keeps AgentLink's advertised tools eagerly
available and returns tool requests to AgentLink for execution. It uses Meridian's
existing `onRequest` hook; no Meridian fork or global deferral setting is required.
See [Meridian's plugin guide](https://github.com/rynfar/meridian/blob/main/PLUGINS.md).
The package has no dependencies and can be installed from a checkout or packed
as an npm tarball. It has not been published to npm.

## Install

From an AgentLink checkout:

```sh
node integrations/meridian-plugin-agentlink/install.mjs
curl -fsS -X POST http://127.0.0.1:3456/plugins/reload
```

For a protected Meridian server, authenticate the reload using its configured
server key. The installer accepts an optional plugin-directory argument and
honors `MERIDIAN_PLUGIN_DIR`. It copies only `agentlink-client-tools.js` and
preserves other plugins. An existing disabled entry for this filename in
`plugins.json` must be enabled through Meridian's Plugins UI.

Enable `meridianSessionAffinity: true` on the AgentLink OpenAI-compatible
connection. Start a **fresh conversation** after loading the plugin: Meridian
pins automatic deferral per session, so old conversations can retain their old
policy. Confirm `agentlink-client-tools` is active in Meridian's Plugins UI.

Distribute the dependency-free package with:

```sh
npm pack ./integrations/meridian-plugin-agentlink
```

Other users can extract that tarball and run `node package/install.mjs`. For
Docker, mount the installed `.js` into Meridian's plugin directory or register
its absolute container path in `plugins.json`.

## Behavior and compatibility

The plugin selects the `openai` adapter only when a dynamic `x-session-affinity`
header exists and the system prompt starts with `You are AgentLink,`. AgentLink's
foreground and background prompts currently share that identity. Other clients
are unchanged. This marker identifies a client; it is not authentication.

AgentLink supplies the complete current catalog, including MCP discovery tools.
The plugin does not keep a duplicate name/schema list, modify messages, change
thinking effort, or execute tools. Explicit `defer_loading` flags remain intact
and can still require multiple SDK turns. Operator-pinned turn budgets, advisors,
and structured output can also prevent the ordinary single-turn handoff.

Meridian's generic OpenAI adapter otherwise applies OpenCode's core names
(`read`, `write`, `edit`, `bash`, `glob`, `grep`). Above its default 15-tool
threshold, AgentLink names such as `read_file` and `execute_command` are deferred.
Deferred requests lift the one-turn SDK cap and can generate a hidden response
to the synthetic tool denial before returning control. Eager loading trades a
larger upfront tool catalog for avoiding that discovery/continuation path.

The transport contract requires Meridian to forward the keyed OpenAI request's
affinity header into its request pipeline. Verified against the local 1.79.0
implementation; rerun the integration probe when updating Meridian.

## Verify

```sh
npm test --prefix integrations/meridian-plugin-agentlink
```

From a source checkout with Bun and a local Meridian checkout matching the running
server, run the live probe (this consumes your Claude subscription):

```sh
bun integrations/meridian-plugin-agentlink/probe.mjs \
  --meridian-checkout=/path/to/meridian \
  --model=claude-opus-5-5 --deferred=false --report=/tmp/meridian-agentlink.json
```

It uses AgentLink's production completion facade with 38 synthetic tool schemas
and two local fixture files. It asserts parallel reads, real-result continuation,
session resume, `set_task_status` completion, and one new SDK model response per
eager request. It inspects history through the supported Agent SDK API, not
private transcript files. `MERIDIAN_API_KEY` supplies optional server auth;
`--url` overrides the local `/v1` endpoint. For a baseline, disable the plugin,
reload, and pass `--deferred=true`; every run creates a fresh conversation.
The source-only probe is excluded from the standalone tarball.

Maintenance instructions live in `.agents/skills/meridian-integration/SKILL.md`.
Check fresh-request telemetry for `hasDeferredTools: false`, intact tool calls,
and resume on the next result round. Latency comparisons must use the same model,
effort, prompt, and tools; a cache hit alone does not prove a faster handoff.

To disable, remove the installed file or disable it through Meridian's Plugins UI,
reload plugins, and start a fresh conversation.
