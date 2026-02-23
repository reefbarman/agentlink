# Native Claude: VS Code Extension + MCP Server

## Context

Claude Code's built-in file editing and terminal tools work outside of VS Code — edits happen silently, terminal output is captured invisibly. This extension bridges that gap by exposing native VS Code capabilities as MCP tools that Claude Code can call. The result: file edits show in VS Code's diff viewer where the user can review/modify before accepting (and benefit from format-on-save), commands run in the visible integrated terminal, and diagnostics are returned automatically.

Inspired by Roo Code's architecture (cloned at `Roo-Code/` for reference) but much leaner — just an MCP server, no AI provider, no webview UI.

## Non-Goals & Security Model

**Non-goals**: This is not a full AI IDE (no webview, no AI provider, no chat UI). It is a bridge only — VS Code capabilities exposed as MCP tools.

**Security model**:

- HTTP server binds to `127.0.0.1` only (no network exposure)
- Optional auth token: on first activation, generate a random token stored in extension global state, included in `~/.claude.json` config. Validate `Authorization: Bearer <token>` on every `/mcp` request. Configurable via `native-claude.requireAuth` setting (default: true).
- **Workspace boundary enforcement**: All file tools resolve paths via `path.resolve(workspaceRoot, inputPath)` then `fs.realpath()` to resolve symlinks, then verify the result starts with a workspace root. Reject with clear error if outside boundaries.
- **Threat model**: Protects against other local processes calling the MCP endpoint. Does NOT protect against malicious VS Code extensions (they already have full API access). Auth token is primary defense for the localhost surface.

## Architecture

```text
Claude Code CLI ──(Streamable HTTP POST /mcp)──► VS Code Extension (MCP Server)
                                                      ├── DiffViewProvider (file editing with review)
                                                      ├── TerminalManager (integrated terminal)
                                                      └── VS Code APIs (diagnostics, workspace, fs)
```

The extension hosts an HTTP server on `127.0.0.1` using `http.createServer` + `@modelcontextprotocol/sdk` with **Streamable HTTP** transport (per-session `McpServer` + `StreamableHTTPServerTransport` pairs). On activation, it auto-configures `~/.claude.json` so Claude Code discovers it automatically.

### Critical: Per-Session Transport Pattern

A single `McpServer` can only be initialized once. Claude Code's auth discovery probe can trigger initialization. **Solution**: create a new `McpServer` + `StreamableHTTPServerTransport` pair per client session, keyed by `mcp-session-id` header. This is managed by the `McpServerHost` class.

### Session Lifecycle & Cleanup

- `transport.onclose` removes session from the map immediately on clean disconnect
- **Idle TTL**: a 30-minute interval timer sweeps sessions that haven't received a request (track `lastActivity` timestamp per session). Closes transport + server for stale entries.
- **Extension deactivation**: `dispose()` iterates all sessions, calls `transport.close()` and `server.close()` on each, then clears the map and closes the HTTP server.

## Project Structure

```text
src/
  extension.ts                    # Entry: activate, register providers, start HTTP server
  server/
    McpServerHost.ts              # Per-session McpServer+Transport management + idle TTL
    registerTools.ts              # Register all 7 tools on a McpServer instance
  tools/
    writeFile.ts                  # write_file — create/overwrite via diff view
    applyDiff.ts                  # apply_diff — search/replace via diff view
    executeCommand.ts             # execute_command — integrated terminal
    readFile.ts                   # read_file — read with line numbers
    listFiles.ts                  # list_files — directory listing
    searchFiles.ts                # search_files — regex search
    getDiagnostics.ts             # get_diagnostics — VS Code problems
  integrations/
    DiffViewProvider.ts           # Diff view: open, wait for decision, save/revert
    TerminalManager.ts            # Terminal creation, command execution, output capture
  util/
    paths.ts                      # Path resolution, workspace boundary checks
    ansi.ts                       # ANSI/shell-integration escape stripping
package.json                      # Extension manifest + dependencies
tsconfig.json
esbuild.mjs                      # Bundle with vscode external
.vscodeignore
```

## Dependencies

```json
{
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.27.0",
    "zod": "^3.25.0",
    "diff": "^5.2.0"
  },
  "devDependencies": {
    "@types/vscode": "^1.90.0",
    "@types/diff": "^5.2.0",
    "esbuild": "^0.25.0",
    "typescript": "^5.8.0"
  }
}
```

No Express needed — raw `http.createServer` is sufficient since we only route `/mcp`.

## MCP Tools — Contracts

### write_file

Create or overwrite a file with full diff review.

- **Params**: `path` (string, required), `content` (string, required)
- **Flow**: Opens VS Code diff (left=original readonly, right=proposed editable). User reviews/edits, accepts/rejects via notification.
- **Success response**:

```json
{ "status": "accepted", "path": "src/foo.ts", "operation": "created|modified",
  "user_edits": "<unified diff if user modified, omitted if unchanged>",
  "new_diagnostics": "<new errors after save, omitted if none>" }
```

- **Rejection response**: `{ "status": "rejected", "path": "src/foo.ts" }`
- **Error response**: `{ "error": "File is outside workspace boundary", "path": "..." }`

### apply_diff

Edit existing file with search/replace blocks.

- **Params**: `path` (string, required), `diff` (string, required — `<<<<<<< SEARCH / ======= / >>>>>>> REPLACE` blocks)
- **Matching semantics**:
  - Each SEARCH block must match exactly one location in the file (whitespace-exact)
  - **0 matches**: return error `"Search block not found"` with the failing block content
  - **>1 matches**: return error `"Search block is ambiguous (N matches found)"` — caller must provide more context
  - Blocks are applied sequentially top-to-bottom; each block operates on the result of the previous
  - **Partial failure**: if block N fails, blocks 0..N-1 are still applied. Return success with `"partial": true` and `"failed_blocks": [N, ...]`
- **Success/rejection/error responses**: same shape as write_file, plus `partial` and `failed_blocks` fields when applicable

### execute_command

Run command in VS Code's integrated terminal.

- **Params**: `command` (string, required), `cwd` (string, optional)
- **Success response (shell integration available)**:

```json
{ "exit_code": 0, "output": "...", "cwd": "/current/dir", "output_captured": true }
```

- **Success response (shell integration unavailable)**:

```json
{ "exit_code": null, "output": "Command sent to terminal. Output capture unavailable — shell integration is not active.",
  "cwd": "/current/dir", "output_captured": false }
```

- **Rejection response**: `{ "status": "rejected", "command": "..." }`

### read_file

- **Params**: `path` (string, required), `offset` (number, optional, 1-indexed), `limit` (number, optional, default 2000)
- **Returns**: File content with `line_number | content` format, plus `total_lines` metadata
- **Error**: workspace boundary violation, file not found, binary file detected

### list_files

- **Params**: `path` (string, required), `recursive` (boolean, optional, default false)
- **Returns**: Newline-separated listing with `/` suffix for directories. Capped at 500 entries with `truncated: true` if exceeded.

### search_files

- **Params**: `path` (string, required), `regex` (string, required), `file_pattern` (string, optional glob)
- **Returns**: Matches grouped by file with line numbers and 1 line of context. Capped at 300 results.

### get_diagnostics

- **Params**: `path` (string, optional — omit for all workspace diagnostics)
- **Returns**: Formatted diagnostics: `[severity] file:line — message`. Filterable by severity.

## Key Implementation Details

### McpServerHost (src/server/McpServerHost.ts)

Per-session server management:

```typescript
class McpServerHost {
  private sessions = new Map<string, {
    transport: StreamableHTTPServerTransport;
    server: McpServer;
    lastActivity: number;
  }>()
  private cleanupInterval: NodeJS.Timeout

  constructor() {
    // Sweep stale sessions every 5 minutes
    this.cleanupInterval = setInterval(() => this.pruneIdleSessions(), 5 * 60_000)
  }

  async handleRequest(req, res) {
    // Auth check first (if enabled)
    if (!this.validateAuth(req)) { res.writeHead(401); res.end(); return }

    const sessionId = req.headers['mcp-session-id']

    // Existing session → route + update lastActivity
    if (sessionId && this.sessions.has(sessionId)) {
      this.sessions.get(sessionId).lastActivity = Date.now()
      await this.sessions.get(sessionId).transport.handleRequest(req, res)
      return
    }

    // Unknown session ID → 404
    if (sessionId) { res.writeHead(404); res.end(JSON.stringify({
      jsonrpc: '2.0', error: { code: -32000, message: 'Session not found' }, id: null
    })); return }

    // No session ID → new client
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID()
    })
    const server = new McpServer({ name: 'native-claude', version: '0.1.0' })
    registerTools(server)
    await server.connect(transport)
    await transport.handleRequest(req, res)
    if (transport.sessionId) {
      this.sessions.set(transport.sessionId, {
        transport, server, lastActivity: Date.now()
      })
    }
    transport.onclose = () => {
      if (transport.sessionId) this.sessions.delete(transport.sessionId)
    }
  }

  private pruneIdleSessions() {
    const TTL = 30 * 60_000 // 30 minutes
    for (const [id, session] of this.sessions) {
      if (Date.now() - session.lastActivity > TTL) {
        session.transport.close().catch(() => {})
        session.server.close().catch(() => {})
        this.sessions.delete(id)
      }
    }
  }

  async close() {
    clearInterval(this.cleanupInterval)
    for (const [, session] of this.sessions) {
      await session.transport.close().catch(() => {})
      await session.server.close().catch(() => {})
    }
    this.sessions.clear()
  }
}
```

### Extension Activation (src/extension.ts)

1. Create output channel "Native Claude"
2. Register TextDocumentContentProvider for `"native-claude-diff"` scheme
3. Create McpServerHost instance
4. Start `http.createServer` on `127.0.0.1:PORT`, route `/mcp` to `mcpHost.handleRequest()`
5. Handle `EADDRINUSE`: try configured port, then fallback to port 0 (OS-assigned), log actual port
6. Auto-configure `~/.claude.json` with mcpServers entry
7. Create status bar item showing port + status
8. Register commands (start/stop/status)
9. Push dispose handler to close server + mcpHost on deactivation

### Auto-Configure Claude Code

On activation, read `~/.claude.json`, upsert `mcpServers["native-claude"]`:

```json
{ "type": "http", "url": "http://localhost:PORT/mcp" }
```

**Robustness**:

- If `~/.claude.json` doesn't exist, create it with just the mcpServers entry
- If file exists but contains malformed JSON, log a warning to the output channel and skip (do not corrupt)
- Use atomic write: write to temp file then rename
- Skip write if entry already exists and URL matches
- Log all config changes to the output channel so the user can see what happened

### Path Safety (src/util/paths.ts)

```typescript
function resolveAndValidatePath(inputPath: string, workspaceRoots: string[]): string {
  // 1. Resolve relative to first workspace root
  const resolved = path.resolve(workspaceRoots[0], inputPath)
  // 2. Resolve symlinks
  const real = fs.realpathSync(resolved)  // throws if doesn't exist — caller handles
  // 3. Check boundary
  const inWorkspace = workspaceRoots.some(root => real.startsWith(root + path.sep) || real === root)
  if (!inWorkspace) throw new Error(`Path "${inputPath}" resolves outside workspace boundary`)
  return real
}
```

For new files (write_file creating a file that doesn't exist yet), check the parent directory instead since the file itself won't exist for realpath. Validate that the resolved parent is within workspace bounds.

### DiffViewProvider (ref: `Roo-Code/src/integrations/editor/DiffViewProvider.ts`)

**Concurrency**: A per-path `Map<string, Promise<void>>` mutex. When a write_file or apply_diff is called, it acquires the lock for that path. If already locked, it waits (with 60s timeout — returns error if exceeded). This prevents two concurrent edits to the same file from conflicting. Different files can be edited concurrently.

**open(relPath, newContent):**

1. Save dirty document if file exists, capture pre-edit diagnostics
2. Read original content (or `""` for new files)
3. Create directories for new files, write empty placeholder
4. Close existing tabs for this file
5. Open diff: `vscode.commands.executeCommand("vscode.diff", leftUri, rightUri, title)`
   - Left: `native-claude-diff:filename?<base64 original>` (readonly via content provider)
   - Right: `vscode.Uri.file(absolutePath)` (editable)
6. Apply new content to right side via `WorkspaceEdit.replace()`

**waitForUserDecision():**

- `vscode.window.showInformationMessage("Review changes to X", "Accept", "Reject")`
- Also listen for `onDidChangeVisibleTextEditors` to detect tab close → treat as reject

**saveChanges():**

1. Read edited content from right pane: `document.getText()`
2. Save document (triggers format-on-save)
3. Close diff views, open file normally
4. Wait for diagnostics using event-driven approach: listen to `vscode.languages.onDidChangeDiagnostics` for our file URI, resolve on first event or after `diagnosticDelay` timeout (whichever comes first)
5. Compare normalized edited content vs proposed content (normalize EOL before comparing)
6. If different → generate unified diff patch as `user_edits` (using `diff` library)
7. Return `{ userEdits, newProblems, finalContent }`

**revertChanges():**

- Existing files: restore original content via WorkspaceEdit
- New files: delete file + created directories (in reverse order)

### TerminalManager (ref: `Roo-Code/src/integrations/terminal/`)

- Creates terminals via `vscode.window.createTerminal({ name: "Native Claude", cwd, iconPath })`
- Reuses terminals by matching cwd
- Polls for shell integration availability (up to 5s, 100ms intervals)
- If available: `terminal.shellIntegration.executeCommand(cmd)` → read async iterable stream
- If not: `terminal.sendText(cmd)` → return deterministic response with `exit_code: null`, `output_captured: false`
- Strips ANSI escape codes and VS Code shell integration markers from output
- Listens for `onDidEndTerminalShellExecution` to get exit code

### Approval UX

- **File writes**: The diff view IS the review UI. Non-modal notification with Accept/Reject buttons.
- **Commands**: `showWarningMessage` with Run/Reject buttons showing the command text.
- **Configurable**: `approvalMode` setting — `"write-only"` (default), `"always"`, or `"never"`

### Extension Settings

| Setting                          | Default      | Description                             |
| -------------------------------- | ------------ | --------------------------------------- |
| `native-claude.port`             | 5765         | HTTP port for MCP server                |
| `native-claude.autoStart`        | true         | Start server on activation              |
| `native-claude.approvalMode`     | "write-only" | When to require user approval           |
| `native-claude.diagnosticDelay`  | 1500         | Max ms to wait for diagnostics          |
| `native-claude.requireAuth`      | true         | Require auth token on /mcp endpoint     |

## Implementation Order

### Phase 1 — Foundation

1. Scaffold project: `package.json`, `tsconfig.json`, `esbuild.mjs`, `.vscodeignore`
2. `src/extension.ts` — activation, TextDocumentContentProvider registration, status bar
3. `src/server/McpServerHost.ts` — per-session management with idle TTL + auth validation
4. HTTP server in extension.ts routing `/mcp` to McpServerHost, with EADDRINUSE fallback
5. `src/server/registerTools.ts` — initially with just a test `ping` tool
6. Auto-configure `~/.claude.json` (with atomic write + malformed JSON handling)
7. **Verify**: build, install extension, confirm server starts, Claude Code discovers and connects

### Phase 2 — Read-only tools

1. `src/util/paths.ts` — path resolution with workspace boundary enforcement + symlink resolution
2. `src/tools/readFile.ts`
3. `src/tools/listFiles.ts`
4. `src/tools/searchFiles.ts`
5. `src/tools/getDiagnostics.ts`
6. **Verify**: test each tool via Claude Code; test path traversal rejection

### Phase 3 — Diff view + write tools

1. `src/integrations/DiffViewProvider.ts` — open, waitForUserDecision, saveChanges, revertChanges, per-path mutex
2. `src/tools/writeFile.ts` — using DiffViewProvider
3. `src/tools/applyDiff.ts` — parse search/replace blocks with 0-match/multi-match/partial-failure handling
4. **Verify**: file create, modify, user edits detection, rejection, format-on-save, ambiguous match error

### Phase 4 — Terminal

1. `src/util/ansi.ts` — ANSI/shell-integration escape stripping
2. `src/integrations/TerminalManager.ts` — create/reuse terminals, shell integration, output capture
3. `src/tools/executeCommand.ts` — deterministic return shape for both capture modes
4. **Verify**: command execution, output capture, exit codes, fallback mode with `output_captured: false`

### Phase 5 — Polish

1. Error handling for failure modes (see matrix below)
2. Status bar updates reflecting connection state
3. End-to-end testing with Claude Code

## Failure Mode Matrix

| Scenario                        | Expected behavior                                              |
| ------------------------------- | -------------------------------------------------------------- |
| Port in use                     | Fallback to port 0, log actual port, update status bar + config |
| No workspace open               | File tools return error "No workspace folder open"             |
| Binary file (read_file)         | Detect via null bytes in first 8KB, return error               |
| Path outside workspace          | Return error with clear message, do not access file            |
| Symlink escape                  | Resolved via realpath, caught by boundary check                |
| Permission denied               | Return OS error message                                        |
| Shell integration absent        | Return `output_captured: false` + informational message        |
| Malformed ~/.claude.json        | Log warning, skip config write, don't corrupt                  |
| Client disconnects uncleanly    | Idle TTL prunes session after 30 min                           |
| Concurrent edits to same file   | Per-path mutex, 60s timeout → error if exceeded                |
| apply_diff 0 matches            | Error with failing search block content                        |
| apply_diff >1 matches           | Error "ambiguous match (N found)"                              |
| apply_diff partial failure      | Apply successful blocks, return `partial: true` + failed list  |
| User closes diff without choice | Treated as rejection                                           |

## Verification Plan

1. `npm run build` produces `dist/extension.js` without errors
2. Install extension in VS Code → status bar shows "Native Claude: :5765"
3. Confirm `~/.claude.json` has `native-claude` entry auto-added
4. Open Claude Code, verify `native-claude` MCP server connects (tools appear)
5. Test `read_file` → returns file content with line numbers
6. Test `list_files` → returns directory listing
7. Test `search_files` → returns regex matches
8. Test `get_diagnostics` → returns VS Code problems
9. Test `write_file` → diff opens, edit right side, Accept → file saved with user edits returned
10. Test `write_file` rejection → file reverted to original
11. Test `apply_diff` → search/replace applied, diff shown, accept works
12. Test `execute_command` → terminal visible, output captured, exit code returned
13. Test format-on-save: write_file with poorly formatted code → Accept → verify formatted content returned
14. Test path traversal: `read_file` with `../../etc/passwd` → rejected
15. Test port conflict: start two VS Code windows → second falls back gracefully
16. Test shell integration fallback: verify deterministic response shape

## Key Reference Files (Roo Code)

- `Roo-Code/src/integrations/editor/DiffViewProvider.ts` — Diff view open/save/revert patterns
- `Roo-Code/src/integrations/terminal/TerminalProcess.ts` — Shell integration, output streaming, ANSI stripping
- `Roo-Code/src/integrations/terminal/Terminal.ts` — Terminal creation, env vars, shell integration polling
- `Roo-Code/src/integrations/diagnostics/index.ts` — getNewDiagnostics, formatting
- `Roo-Code/src/extension.ts:336-344` — TextDocumentContentProvider registration pattern
