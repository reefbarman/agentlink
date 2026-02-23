# Multi-Window Support Plan

## Problem

The MCP server binds to a single HTTP port (default `5765`). `~/.claude.json` has one `native-claude` entry pointing to that port. When multiple VS Code windows are open, the **last window to activate** takes over the port and config — so all Claude Code sessions route to that window, causing terminals, diffs, and approval dialogs to appear in the wrong window.

## Root Cause

VS Code extensions run per-window (separate extension host processes), but the extension writes a single global URL to `~/.claude.json`. There's no mechanism to route requests to the correct window.

## Solution: Per-Window Servers + Project-Level `.mcp.json`

Each VS Code window runs its own independent MCP server on its own port and advertises itself via a **`.mcp.json` file in the workspace root** — Claude Code's standard per-project MCP configuration mechanism.

### Why `.mcp.json`?

Claude Code reads MCP server config from two places:
1. `~/.claude.json` — global (current approach)
2. `.mcp.json` in the project root — per-project, **overrides global entries with the same name**

By writing a project-level `.mcp.json`, each workspace automatically directs its Claude Code instances to the correct VS Code window. No routing proxy, no IPC between extension hosts, no complex coordination.

### Why not other approaches?

| Approach                                | Problem                                                               |
| --------------------------------------- | --------------------------------------------------------------------- |
| Single port + workspace routing proxy   | Requires IPC between separate extension host processes; very complex  |
| Per-workspace names in `~/.claude.json` | Each project's CLAUDE.md would need to reference a unique server name |
| Shared port with last-writer-wins       | Current behavior — the problem we're solving                          |

## Implementation

### 1. Port allocation changes (`extension.ts`)

**Current**: Try configured port, fall back to port 0 on `EADDRINUSE`.
**New**: Always use port 0 (OS-assigned) by default. Keep `native-claude.port` setting but only as an explicit override for single-window users.

Rationale: With multiple windows, a fixed port guarantees conflicts. Port 0 gives each window a unique port with zero coordination.

### 2. New function: `updateProjectMcpConfig(port, authToken?)` in `extension.ts`

For each workspace folder (`vscode.workspace.workspaceFolders`):

1. Read existing `.mcp.json` from the folder root (if it exists)
2. Parse as JSON, preserving all existing entries
3. Add/update the `native-claude` entry with the window's port and auth headers
4. Write back atomically (temp file + rename)

```typescript
// Example .mcp.json content:
{
  "mcpServers": {
    "native-claude": {
      "type": "http",
      "url": "http://localhost:52341/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    },
    // Other MCP servers the user configured are preserved
    "some-other-server": { ... }
  }
}
```

### 3. New function: `cleanupProjectMcpConfig()` in `extension.ts`

On deactivation/server stop:

1. For each workspace folder, read `.mcp.json`
2. Remove the `native-claude` entry
3. If the file is now empty (`mcpServers` has no entries), delete the file
4. If other entries remain, write back the file without our entry

### 4. Modify `startServer()` in `extension.ts`

After the server starts and we know the actual port:

1. Call `updateProjectMcpConfig(actualPort, authToken)` — writes to workspace `.mcp.json`
2. Keep calling `updateClaudeConfig(actualPort, authToken)` — updates `~/.claude.json` as fallback for non-workspace usage

### 5. Modify `stopServer()` / deactivation in `extension.ts`

- Call `cleanupProjectMcpConfig()` before stopping the server
- This prevents stale configs from pointing to dead ports

### 6. Workspace folder lifecycle listener in `activate()`

```typescript
vscode.workspace.onDidChangeWorkspaceFolders((e) => {
  // Write .mcp.json to newly added folders
  for (const added of e.added) {
    updateProjectMcpConfigForFolder(added.uri.fsPath, port, authToken);
  }
  // Clean up .mcp.json from removed folders  
  for (const removed of e.removed) {
    cleanupProjectMcpConfigForFolder(removed.uri.fsPath);
  }
});
```

### 7. Update default port setting

Change the default `native-claude.port` from `5765` to `0` in `package.json`. Port `0` means "OS-assigned". Users who want a fixed port can still set one.

### 8. Update README

- Remove the "Known Limitations: Single MCP Server Instance" section
- Add a note about `.mcp.json` being auto-managed
- Suggest adding `.mcp.json` to `.gitignore` if users don't want it committed

## What doesn't need to change

These are already per-window by nature of running in the extension host:

- **McpServerHost** — creates per-session MCP servers within the window
- **Tool handlers** — use window-scoped `vscode.window`, `vscode.workspace` APIs
- **TerminalManager** — singleton within each window's extension host
- **DiffViewProvider** — opens diffs in the current window
- **ApprovalManager** — uses `globalState` (shared across windows, but session IDs are per-MCP-session so there's no conflict)

## Edge cases

| Scenario                                      | Handling                                                                       |
| --------------------------------------------- | ------------------------------------------------------------------------------ |
| `.mcp.json` already exists with other servers | Merge — only add/update `native-claude` entry                                  |
| Multiple workspace folders in one window      | Write `.mcp.json` to each folder                                               |
| Window reload                                 | New port, `.mcp.json` updated; Claude Code needs restart to pick up new port   |
| VS Code crash (no clean deactivation)         | Stale `.mcp.json` left behind; next activation overwrites it                   |
| User manually edits `.mcp.json`               | Our entry gets overwritten on next server start; their other entries preserved |
| Claude Code started before VS Code            | `.mcp.json` doesn't exist yet; falls back to `~/.claude.json` global config    |
| Read-only filesystem / workspace              | Catch write errors gracefully, log warning, fall back to `~/.claude.json` only |

## Trade-offs

**Pros:**
- Simple, no IPC or routing complexity
- Each window is fully independent
- Uses Claude Code's standard per-project config mechanism
- No changes to MCP protocol or server architecture

**Cons:**
- Adds a `.mcp.json` file to each workspace (can be `.gitignore`d)
- Claude Code must be restarted if VS Code reloads (port changes)
- Stale `.mcp.json` on crash (harmless — overwritten on next start)

## Files to modify

1. `src/extension.ts` — Port allocation, `.mcp.json` management, workspace folder listener
2. `package.json` — Change default port to `0`
3. `README.md` — Update known limitations section
