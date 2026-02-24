# Tool Call Tracker - In-Progress Tool Calls with Cancel/Complete UI

## Context
MCP tool calls can hang indefinitely (terminal commands that never finish, approval prompts never answered). Currently the only escape is interrupting from the Claude Code side, which loses output capture. We need VS Code-side UI to force-finish hung tool calls, with smart recovery where possible.

## Approach

Introduce a **ToolCallTracker** that wraps every tool handler at registration time using `Promise.race`. Each tracked call gets a deferred "force-resolve" promise. When the user clicks Cancel or Complete in the sidebar, the deferred resolves, winning the race and returning a result to MCP immediately. The original handler's `finally` block cleans up regardless.

## Files to Create

### `src/server/ToolCallTracker.ts` (new)
Central tracker class with:
- `TrackedCall` interface: `{ id, toolName, displayArgs, sessionId, startedAt, forceResolve, approvalId?, terminalId?, metadata? }`
- `wrapHandler()` — returns a new handler that registers the call, runs `Promise.race([original, forcePromise])`, cleans up in `finally`
- `cancelCall(id, approvalPanel)` — cancels any linked approval, then force-resolves with MCP-format result
- `completeCall(id, approvalPanel)` — tool-specific recovery, then force-resolves
- `getActiveCalls()` — returns snapshot for UI
- `setApprovalId(toolCallId, approvalId)` — links a pending approval to a tracked call (called by tool handlers after enqueueing)
- `setTerminalId(toolCallId, terminalId)` — links a terminal to a tracked call (called via `onTerminalAssigned` callback)
- Extends `EventEmitter`, emits `"change"` on call start/end so sidebar auto-updates

**All forced results use MCP ToolResult format** — a helper ensures consistency:
```typescript
type ToolResult = { content: Array<{ type: "text"; text: string }> };

function makeToolResult(payload: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}
```

**Cancel** resolves with: `makeToolResult({ status: "cancelled", tool: name, message: "Cancelled by user from VS Code" })`

**Complete** recovery per tool type:
- `execute_command`: Use linked `terminalId` to call `TerminalManager.getCurrentOutput()`, resolve with partial output in same shape as normal command result
- `write_file`/`apply_diff`: Call `resolveCurrentDiff("accept")`. If returns true, the original handler completes naturally (no force-resolve needed). If returns false (no pending diff), fallback to force-resolve with `makeToolResult({ status: "force-completed", message: "No pending diff to accept" })`
- All other tools: Same as Cancel (no meaningful partial result)

## Files to Modify

### `src/server/registerTools.ts`
- Add `tracker: ToolCallTracker` parameter to `registerTools()`
- Wrap each of the 16 tool handler callbacks with `tracker.wrapHandler()`
- Each tool gets an `extractDisplayArgs` function for the sidebar label:
  - `execute_command` → `p.command?.slice(0, 80)`
  - `write_file`/`apply_diff`/`read_file`/`list_files` etc → `p.path`
  - `search_files` → `p.regex?.slice(0, 60)`

### `src/server/McpServerHost.ts`
- Constructor accepts `ToolCallTracker` as new parameter, stores it
- Line 65: Pass `this.tracker` to `registerTools()`

### `src/extension.ts`
- Create `ToolCallTracker` instance in `activate()`
- Pass to `McpServerHost` in `startServer()`
- Wire to sidebar: `sidebarProvider.setToolCallTracker(toolCallTracker)`
- Register two new commands:
  - `native-claude.cancelToolCall` → `toolCallTracker.cancelCall(id, approvalPanel)`
  - `native-claude.completeToolCall` → `toolCallTracker.completeCall(id, approvalPanel)`

### `src/integrations/TerminalManager.ts`
- Add `outputBuffer: string` to `ManagedTerminal` interface (init to `""` in `createTerminal`)
- In `executeWithShellIntegration()`: replace local `output` variable with `managed.outputBuffer` so accumulated output is externally readable. Reset to `""` at start of each execution
- Add `onTerminalAssigned?: (terminalId: string) => void` to `ExecuteOptions` interface
- In `executeCommand()` after `resolveTerminal()` (line 67-68), call `options.onTerminalAssigned?.(managed.id)` so the tracker knows which terminal is in use
- Add public method `getCurrentOutput(terminalId: string): string | undefined` — finds the terminal by ID, returns `cleanTerminalOutput(managed.outputBuffer)` if busy

### `src/tools/executeCommand.ts`
- After the tracker wrapping, but we need the terminal ID to flow back. The `handleExecuteCommand` function calls `terminalManager.executeCommand()` directly. We modify it to accept an optional `onTerminalAssigned` callback from the tracker and pass it through to `ExecuteOptions`
- Approach: `wrapHandler` passes a mutable `TrackedCall` reference into the handler via a `context` argument. The handler sets `context.terminalId` after terminal resolution. Simpler alternative: `handleExecuteCommand` accepts an optional `onTerminalAssigned` callback, which `wrapHandler` provides for `execute_command` specifically

### `src/approvals/ApprovalPanelProvider.ts`
- Change `enqueueCommandApproval()` return type from `Promise<CommandApprovalResponse>` to `{ promise: Promise<CommandApprovalResponse>; id: string }` — matching the pattern already used by `enqueueWriteApproval()`
- Change `enqueuePathApproval()` return type from `Promise<PathApprovalResponse>` to `{ promise: Promise<PathApprovalResponse>; id: string }`
- The `id` is already generated inside `enqueue()` via the `ApprovalRequest.id` — just need to extract and return it

### Callers of enqueueCommandApproval / enqueuePathApproval
These need updating since the return type changes from `Promise` to `{ promise, id }`:
- `src/tools/executeCommand.ts` line 160: `const response = await approvalPanel.enqueueCommandApproval(...)` → `const { promise, id: approvalId } = approvalPanel.enqueueCommandApproval(...); const response = await promise;` — then call `tracker.setApprovalId(toolCallId, approvalId)` if tracker context is available
- `src/tools/pathAccessUI.ts` (if it calls `enqueuePathApproval`) — same pattern

### `src/sidebar/SidebarProvider.ts`
- Add `activeToolCalls` to `SidebarState` interface
- Add `setToolCallTracker()` — subscribes to tracker `"change"` events
- **Update strategy**: Use `webview.postMessage()` to send tool call updates to the client side rather than full HTML re-renders. The client JavaScript handles DOM updates for the tool calls section. This avoids:
  - Destroying/recreating the client-side `setInterval` for elapsed timers
  - Flickering from rapid full re-renders during fast tool call start/end cycles
  - Conflicts with the existing full-render model used for server state
- Initial render includes the tool calls section HTML + JS listener for `updateToolCalls` messages
- `refreshToolCalls()` method: calls `this.view?.webview.postMessage({ type: "updateToolCalls", calls: [...] })` — the client JS patches the DOM
- Handle `cancelToolCall` and `completeToolCall` messages from webview → dispatch to commands
- Client-side JS:
  - `setInterval` every 1s updates elapsed time spans via `data-started-at` attributes
  - `updateToolCalls` message handler rebuilds just the tool calls container (not the whole page)
  - `sendToolAction(command, id)` posts message back to extension

### `package.json`
- Add `native-claude.cancelToolCall` and `native-claude.completeToolCall` to commands array

## Key Implementation Details

### Promise.race pattern (with MCP-compliant result shape)
```
wrapHandler(name, handler, extractDisplayArgs, getSessionId):
  return async (params, extra) => {
    let forceResolve: (r: ToolResult) => void
    const forcePromise = new Promise<ToolResult>(resolve => { forceResolve = resolve })
    const tracked = { id, toolName: name, forceResolve, ... }
    activeCalls.set(id, tracked)
    emit("change")
    try {
      return await Promise.race([handler(params, extra), forcePromise])
    } finally {
      activeCalls.delete(id)
      emit("change")
    }
  }
```

### Terminal ID linkage
1. `TerminalManager.executeCommand()` calls `options.onTerminalAssigned?.(managed.id)` right after `resolveTerminal()` (line 67-68)
2. `handleExecuteCommand()` passes through `onTerminalAssigned` from tracker context
3. The callback calls `tracker.setTerminalId(toolCallId, managedTerminalId)`
4. When Complete is clicked, tracker looks up `tracked.terminalId` and calls `getCurrentOutput(terminalId)` — no guessing needed

### Terminal output recovery
The `output` variable in `executeWithShellIntegration` (line 230) moves to `managed.outputBuffer`. This lets `getCurrentOutput()` read partial output mid-execution. Buffer resets to `""` at execution start, so stale output is never leaked. `getCurrentOutput()` returns `cleanTerminalOutput(managed.outputBuffer)`.

Complete for execute_command returns:
```
makeToolResult({
  exit_code: null,
  output: partialOutput || "[No output captured]",
  cwd: managed.cwd,
  output_captured: !!partialOutput,
  terminal_id: terminalId,
  status: "force-completed",
  message: "Command force-completed by user. May still be running in terminal."
})
```

### Write tool recovery
Complete calls `resolveCurrentDiff("accept")`:
- Returns `true` → original handler completes naturally through `saveChanges()` with real result
- Returns `false` → no pending diff; force-resolve with `makeToolResult({ status: "force-completed", path: tracked.displayArgs, message: "No pending diff to accept — file may already be saved or approval was not yet shown" })`

### Approval cancellation on Cancel
When `cancelCall(id, approvalPanel)` is called:
1. Check if `tracked.approvalId` is set
2. If yes, call `approvalPanel.cancelApproval(tracked.approvalId)` — this rejects the approval, which causes the original handler to return a rejection result, which wins `Promise.race` before the force-resolve (both produce valid cancelled results)
3. Also call `resolveCurrentDiff("reject")` in case a diff is pending
4. Then force-resolve with the cancelled result as a safety net

### Passing tracker context to tool handlers
The `wrapHandler` method provides a `TrackerContext` object to the handler:
```typescript
interface TrackerContext {
  toolCallId: string;
  setApprovalId: (approvalId: string) => void;
  setTerminalId: (terminalId: string) => void;
}
```
The wrapped handler signature: `(params, extra, trackerCtx?) => Promise<ToolResult>`. Tool handlers that need it (execute_command, write_file, apply_diff, path access tools) accept the optional context and use it. Read-only tools ignore it.

### Edge cases
- Double force-resolve is safe (Promise resolves once)
- If handler completes at same moment as force-resolve, `Promise.race` picks first settler — both valid
- Terminal process keeps running after force-complete; `busy` flag cleared by `finally` in `TerminalManager.executeCommand()`
- Approval cancel + force-resolve double-resolution: the first to resolve wins, second is harmless
- Sidebar webview not yet resolved: `postMessage` calls are no-ops, tool calls will render on next full render

## Verification

1. Build: `npm run build` — no errors
2. Install: `npm run release -- --install`
3. Test normal flow: Start a Claude Code session, verify all tools work normally with tracker wrapping (transparent)
4. Test sidebar: Open sidebar, trigger a tool call, verify it appears with elapsed timer
5. Test Cancel: Run a long command (e.g. `sleep 60`), click Cancel, verify MCP gets cancelled response immediately and approval panel clears
6. Test Complete on command: Run a slow command producing output (e.g. `for i in $(seq 1 100); do echo $i; sleep 1; done`), click Complete mid-way, verify partial output is returned in correct MCP format
7. Test Complete on write: Trigger a write_file that shows diff view, click Complete in sidebar, verify diff is auto-accepted and file is saved
8. Test Complete on write (no diff): Click Complete when no diff is pending, verify graceful fallback message
9. Test cleanup: Verify tool calls disappear from sidebar after completion, no stale entries
