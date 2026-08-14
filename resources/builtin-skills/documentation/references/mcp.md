# Configuring MCP Servers in AgentLink

Full detail lives in the shipped README section `### Connect the built-in agent to MCP servers`; this is the working summary.

## UI entry points

- `/mcp` — open the shared MCP Manager (connection status, tools/resources/prompts counts)
- `/mcp-config` — configuration-oriented view (guided setup, JSON import, sources)
- `/mcp-refresh` — explicitly reconnect configured servers (ordinary catalog changes load automatically)

The MCP Manager has four views: **Overview** (config + status + enabled/disabled state), **Sources** (each layered file in precedence order, with read health and editability), **Guided setup** (stdio, HTTP, legacy SSE), and **Import JSON** (paste one or many servers; conflicts require explicit Skip/Replace/Rename). A multi-project workspace uses one Manager with a project selector.

## Config files and precedence

For each project, server definitions merge from these files in ascending priority (later overrides earlier for the same server name):

1. `~/.agents/mcp.json`
2. `~/.claude/mcp.json`
3. `~/.agentlink/mcp.json`
4. `<workspace>/.agents/mcp.json`
5. `<workspace>/.claude/mcp.json`
6. `<workspace>/.agentlink/mcp.json`

AgentLink writes structured changes only to `.agentlink/mcp.json` sources (project or global). To change an inherited `.agents`/`.claude` server, create an AgentLink-owned override instead of editing those files. Browser Ask Agent uses its own `~/.agentlink/ask-agent/mcp.json`.

The main agent receives the union of every available workspace project's effective servers. Identical definitions are connected once. Different same-name definitions are kept under stable project-qualified runtime names, so one project's MCP config cannot silently hide another's.

## File format

Standard `mcpServers` object:

```json
{
  "mcpServers": {
    "example": {
      "command": "example-mcp-server",
      "args": ["--stdio"],
      "timeout": 300000,
      "toolPolicy": "ask",
      "supportsParallelToolCalls": false,
      "disabled": false
    }
  }
}
```

- HTTP servers use `url` (`serverUrl` is normalized to `url`; `streamable-http` normalizes to `http`).
- JSONC, UTF-8 BOM, and a single complete ```json fence are accepted on import; unknown client-specific fields are reported as **Not imported**, not silently written.
- Prefer `${VAR}` references for secrets in env values and headers — AgentLink expands them at runtime. Values are masked in the UI but stored plaintext in the file. URL userinfo is rejected; don't put credentials in args or query strings.
- `disabled: true` persists across refresh/reload and removes the server's tools from the runtime.
- `timeout` is the per-tool-call inactivity timeout in milliseconds (default: `60000`). AgentLink respects any positive finite configured value; MCP progress notifications reset the inactivity window, and HTTP/SSE transport deadlines do not shorten it. There is no separate hidden total cap: an active server can extend the call by continuing to report progress, while caller cancellation still stops it.
- MCP tools run concurrently only when the tool advertises the read-only annotation, or when the server opts in via `supportsParallelToolCalls: true`.

## Behavior notes

- Saving and connecting are separate: a valid config stays saved even when the server is offline or needs auth.
- Writes are revision-checked and atomic; concurrent external edits produce a `config_changed` result rather than an overwrite.
- Large catalogs are progressively disclosed (`find_mcp_tools` / `call_mcp_tool`); the same approval model applies to MCP tools as to native ones.
- A timeout or cancellation leaves remote completion unknown. AgentLink does not automatically retry; check a server-provided status/read operation before repeating a potentially mutating call.
- Browser surfaces: main-profile browser config is read-only; loopback Browser Ask Agent may configure local-process servers; LAN sessions may configure only secret-free HTTP/SSE servers.
