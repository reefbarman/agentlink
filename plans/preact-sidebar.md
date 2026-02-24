# Preact Sidebar Migration

## Context

The sidebar (`SidebarProvider.ts`, 1349 lines) generates HTML via template literals and does full `webview.html` replacement on every state change. This causes race conditions with `postMessage` updates (messages lost during webview reload), destroys client-side timers, and makes the tool call tracker UI unreliable. Migrating to Preact gives us component-level DOM updates, eliminating these problems.

## Approach

Replace inline HTML template generation with Preact components loaded from a separate bundled script. The extension-side `SidebarProvider` becomes a thin wrapper that sends state via `postMessage`. Preact's VDOM diffing handles efficient updates without full HTML replacement.

## File Structure

```
src/sidebar/
  SidebarProvider.ts              # REFACTORED: thin WebviewViewProvider wrapper (~200 lines)
  webview/                        # NEW: browser-context Preact code
    index.tsx                     # Entry: acquireVsCodeApi(), render <App />
    App.tsx                       # Root: useReducer + message listener, renders sections
    types.ts                      # Shared types (imported by both extension + webview)
    components/
      ActiveToolCalls.tsx         # Tool call rows with elapsed timer + Complete/Cancel
      ServerStatus.tsx            # Status dot, port, sessions, auth, start/stop, links
      ClaudeIntegration.tsx       # Configured badge, CLI setup/copy buttons
      WriteApproval.tsx           # Approval state, reset button, file-level write rules
      TrustedPaths.tsx            # Global/project/session path rules
      TrustedCommands.tsx         # Global/project/session command rules + add button
      AvailableTools.tsx          # Static tool list
      common/
        RuleList.tsx              # Reusable: rule rows with mode badge, edit/delete
        SessionBlock.tsx          # Reusable: session header + child content
    styles/
      sidebar.css                 # Extracted verbatim from current inline <style>
```

## Architecture

### State Flow
```
Extension                          Webview (Preact)
─────────                          ─────────────────
refreshApprovalState() ──postMessage──> useReducer dispatch
  { type: "stateUpdate", state }        → re-render changed components

refreshToolCalls() ────postMessage──> useReducer dispatch
  { type: "updateToolCalls", calls }    → re-render ActiveToolCalls only

                   <──postMessage──  button onClick handlers
                   { command: "startServer" }  etc.
```

### Message Protocol (`types.ts`)
- **Extension → Webview**: `{ type: "stateUpdate", state: SidebarState }` and `{ type: "updateToolCalls", calls: TrackedCallInfo[] }`
- **Webview → Extension**: `{ command: string, ...data }` — same 53 commands as today, unchanged

### State Management
- Single `useReducer` at `<App>` level with two actions: `stateUpdate` and `updateToolCalls`
- Props drilling (tree is shallow: App → 7 sections → few sub-components) — no Context needed
- `postCommand(command, data?)` helper wraps `vscode.postMessage`, passed via props

### Webview Lifecycle
1. Extension sets `webview.html` = minimal HTML shell with `<script src="sidebar.js">`
2. Webview mounts, posts `{ command: "webviewReady" }`
3. Extension responds with `stateUpdate` + `updateToolCalls` messages
4. All subsequent updates are postMessage — **no more full HTML replacement**

## Build Changes

### `esbuild.mjs` — Add webview entry point
```js
const webviewOptions = {
  entryPoints: ["src/sidebar/webview/index.tsx"],
  bundle: true,
  outdir: "dist",
  entryNames: "sidebar",        // → dist/sidebar.js + dist/sidebar.css
  format: "esm",
  platform: "browser",
  target: "es2022",
  sourcemap: true,
  minify: true,
  jsx: "automatic",
  jsxImportSource: "preact",
};
```
Both builds run in parallel (extension CJS/Node + webview ESM/browser).

### `tsconfig.json` — Add JSX
```json
"jsx": "react-jsx",
"jsxImportSource": "preact",
"lib": ["ES2022", "DOM"]
```

### `package.json` — Add Preact
```json
"preact": "^10.25.0"   // in dependencies
```

### `.vscodeignore` — Include webview assets
```
!dist/sidebar.js
!dist/sidebar.css
```

## SidebarProvider.ts Changes

### Keeps (unchanged):
- All 53 `onDidReceiveMessage` switch cases
- All private methods: `editRule()`, `editPathRule()`, `editWriteRule()`, `copyClaudeConfig()`, `copyCliCommand()`, `installViaCli()`, `openConfigFile()`
- `setApprovalManager()`, `setToolCallTracker()`, `updateState()`

### Changes:
- **`getHtml()`**: Returns minimal HTML shell loading `dist/sidebar.js` + `dist/sidebar.css` with nonce CSP
- **`refreshApprovalState()`**: Replaces `this.view.webview.html = this.getHtml()` with `this.view?.webview.postMessage({ type: "stateUpdate", state: this.state })`
- **New case**: `"webviewReady"` triggers initial `refreshApprovalState()` + `refreshToolCalls()`
- **Add `masterBypass`** to `SidebarState` (currently computed at render time via `getMasterBypass()`)

### Deletes:
- `renderToolCalls()`, `escapeHtml()`, entire HTML template body (~800 lines of template literals, CSS, inline JS)

## Component Details

### `ActiveToolCalls.tsx`
- Local `useState` tick + `useEffect` with `setInterval(1000)` for elapsed timer updates
- Returns `null` when no calls — section disappears entirely
- Buttons: `postCommand("completeToolCall", { id })` / `postCommand("cancelToolCall", { id })`

### `RuleList.tsx` (shared by WriteApproval, TrustedPaths, TrustedCommands)
- Props: `rules[]`, `editCommand?`, `removeCommand`, `postCommand`, `sessionId?`
- Renders rule rows: mode badge, clickable pattern (triggers edit), delete icon
- Handles URL encoding of patterns for safe round-tripping

### Other sections are straightforward template → JSX conversions with no behavioral changes.

## Implementation Order

### Phase 1: Infrastructure
1. `npm install preact`
2. Update `tsconfig.json` (jsx, jsxImportSource, DOM lib)
3. Update `esbuild.mjs` (add webview build target)
4. Update `.vscodeignore` (include sidebar.js/css)
5. Create `types.ts` with shared types
6. Create `styles/sidebar.css` (extract current CSS verbatim)
7. Create stub `index.tsx` (renders "Loading...")
8. Build — verify `dist/sidebar.js` + `dist/sidebar.css` produced

### Phase 2: Wire Up
9. Refactor `SidebarProvider.getHtml()` → minimal HTML shell
10. Change `refreshApprovalState()` → postMessage instead of HTML replacement
11. Add `"webviewReady"` message handler
12. Add `masterBypass` to state
13. Create `App.tsx` with useReducer + message listener
14. Build + test: sidebar loads, receives state

### Phase 3: Components (one at a time)
15. `ActiveToolCalls.tsx`
16. `ServerStatus.tsx`
17. `ClaudeIntegration.tsx`
18. `WriteApproval.tsx` + `RuleList.tsx`
19. `TrustedPaths.tsx` + `SessionBlock.tsx`
20. `TrustedCommands.tsx`
21. `AvailableTools.tsx`

### Phase 4: Cleanup
22. Delete dead code from SidebarProvider (~800 lines)
23. Build + end-to-end test all interactions

## Verification

1. `npm run build` — both extension.js and sidebar.js produced, no errors
2. `npm run release -- --install` — install updated extension
3. Sidebar loads: all 7 sections render correctly with current state
4. Server start/stop buttons work
5. Rule edit/delete/add work for all scopes (global/project/session)
6. Write approval reset works
7. Tool call tracking: appears on tool start, disappears on completion, elapsed timer ticks
8. Complete/Cancel buttons work on active tool calls
9. CLI setup/copy config buttons work
10. Settings/Output/Config links work
11. Rapid state changes (multiple tool calls, approval changes) don't flicker or lose updates
