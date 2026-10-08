# Local setup observed 2026-10-08

This snapshot belongs to Tristan's local checkout; it is not a default for other
AgentLink users. Reinspect processes and configuration before making changes.

- AgentLink checkout: `/Users/tristan/workspace/agentlink`.
- Global connection file: `/Users/tristan/.agentlink/openai-compatible.json`.
- The `claude` connection uses generic OpenAI-compatible transport at
  `http://127.0.0.1:3456/v1`, with `meridianSessionAffinity: true` and high default
  reasoning effort. It advertises Fable, Opus and Sonnet models.
- The listener on port 3456 was a native Node Meridian 1.79.0 process started by
  `~/Library/LaunchAgents/com.meridian.passthrough.plist`. Colima was not serving
  this endpoint. `/opt/homebrew/bin/meridian` resolved to the built CLI in
  `/Users/tristan/workspace/meridian`.
- Plugin source: `integrations/meridian-plugin-agentlink/index.js` in AgentLink.
- Installed copy: `~/.config/meridian/plugins/agentlink-client-tools.js`.
- Plugin status: `GET http://127.0.0.1:3456/plugins/list`; UI: `/plugins`.
- SDK thinking configuration: `~/.config/meridian/sdk-features.json`. The plugin
  does not change reasoning effort or thinking passthrough.

After editing the plugin, run from the AgentLink checkout:

```sh
node integrations/meridian-plugin-agentlink/install.mjs
curl -fsS -X POST http://127.0.0.1:3456/plugins/reload
curl -fsS http://127.0.0.1:3456/plugins/list
```

Verify the plugin is active, then use a fresh conversation: existing sessions
can retain Meridian's pinned deferral policy. For live checks, use the source
probe documented in the plugin README, with
`--meridian-checkout=/Users/tristan/workspace/meridian`.

Do not overwrite the connection file, shared Meridian settings, existing plugins,
or live AgentLink discovery files. Keep credentials and real conversation text
out of reports. Installation and reload are local operations; packaging is not
npm publication.
