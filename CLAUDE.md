# Claude Code Instructions

## Building & Installing

- **Build**: `npm run build`
- **Release & install**: `npm run release -- --install` — bumps patch version, builds, packages VSIX, and installs into VS Code. Use `--major` or `--minor` for non-patch bumps. Don't currently run when developing the agent.

> ⚠️ **Packaging allowlist gotcha:** [.vscodeignore](.vscodeignore) ignores everything then re-includes specific files with `!`. **Any new bundle output in [esbuild.mjs](esbuild.mjs) (webview entry, worker, css/asset) must get a matching `!dist/<file>` line in `.vscodeignore`**, or it builds fine locally but is silently dropped from the published `.vsix` and 404s for installed users. This is easy to miss because the dev workspace `dist/` still has the file. (It bit us once already: the Monaco diff workers were omitted, so the browser Review pane diff editor rendered both sides but never computed the diff → no red/green highlighting.) After packaging, sanity-check with `npx @vscode/vsce ls`.

## Branding

- **Brand color**: `#4EC9B0` (teal) — used in `media/agentlink-terminal.svg` and throughout the chat webview UI (file picker indicator, active states)
- **Icon**: `media/agentlink.svg` uses `currentColor` (themed by VS Code); `media/agentlink-terminal.svg` uses the hardcoded brand color

## Verification

Choose verification based on the type of change:

### Main code changes (production code, shared libraries, extension runtime, tests, build config, tool definitions)
Run full verification before considering the task complete:

1. `npm run lint` — type-checks all tsconfigs (`tsc --noEmit`) and runs oxlint. Fix **all** errors and warnings.
2. `npm test` — runs the vitest suite. Fix any failures.

Both must pass cleanly (zero exit code, no warnings).

### Spikes / experiments / one-off scripts / docs-only changes
Full-project lint + test is **not required** by default.

Use lightweight verification appropriate to the task (for example: run only the script, run a focused test, or do no execution for docs-only edits).

When full verification is skipped, explicitly state:
- what was skipped,
- why it was skipped,
- and what validation was run instead (if any).

## Adding or Changing Tools

When adding a new tool or changing tool parameters:

1. Register the tool in `src/server/registerTools.ts`
2. Update `resources/claude-instructions.md` — add to the "Additional tools" list with a description
3. Update `README.md` — add a full tool section with parameter table and response details
4. Run `npm run release -- --install` to rebuild, reinstall, and re-inject the CLAUDE.md instructions. (Not when developing the agent, though)

## Project Structure Boundaries

- `src/core/**` is for portable, surface-neutral runtime contracts and logic only. Do not put VS Code, browser gateway, webview, CLI, or product-surface-specific names/behavior there.
- Surface-specific composition belongs in the owning surface package: VS Code in `src/agent`/`src/integrations`/extension composition, browser gateway in `src/browser-gateway`, webview UI in the relevant `webview` package.
- If a concept may later be packaged as reusable core, name it generically (`sessionProtocol`, `modelAuth`, `capabilityPolicy`) and keep host-specific labels such as “Ask Agent tab” or browser routing in the surface layer.

## File Naming Conventions

- Match existing local conventions before creating new files.
- Use `PascalCase.ts` / `PascalCase.tsx` for modules whose primary export is a class, React component, provider, manager, or named UI/type object.
  - Examples: `AgentSession.ts`, `BrowserGatewayService.ts`, `Composer.tsx`.
- Use `camelCase.ts` for utility modules, functions, registries, policies, feature logic, and non-component shared code.
  - Examples: `randomId.ts`, `applyDiff.ts`, `questionDetection.ts`.
- Test files should mirror the subject file exactly and append `.test`, e.g. `AgentSession.test.ts`, `randomId.test.ts`.
- Use lowercase/kebab-case for docs, plans, scripts, CSS/assets, generated/conventional files, and externally named directories.
- Avoid case-only renames. On macOS/default Git settings, perform renames through an intermediate filename if casing must change.
- Import paths must match the on-disk casing exactly.

## Browser Remote Gateway

AgentLink ships a browser-based remote control surface for the built-in agent. A shared helper process serves the browser UI on a stable port (`agentlink.browserGatewayPort`) and routes to per-VS-Code-window API/SSE bridge servers by instance ID, so one URL can switch between all open windows. Full architecture snapshot: [plans/browser-remote-session-status-handoff.md](plans/browser-remote-session-status-handoff.md).

**Any change to chat state, session state, agent events, or UI surfaces must be considered against the browser remote view** — it is a first-class surface, not a debug page, and regressions there are easy to miss because the VS Code webview keeps working.

When touching these areas, keep the browser in sync:

- **Session/chat state** — the browser mirrors foreground session state through [src/browser-gateway/BrowserGatewayService.ts](src/browser-gateway/BrowserGatewayService.ts) (`BrowserGatewayWireSessionState`, `getSessionState()`). New fields on `ChatState` / `AppState` / foreground projection (mode, model, tokens, context budget, todos, debug info, queue, detected-question, restoring-session, etc.) typically need to flow through here too, or the browser will silently lag VS Code.
- **Agent UI events** — approval/question/idle/progress events are published via [src/agent/AgentUiPublisher.ts](src/agent/AgentUiPublisher.ts) and consumed in `BrowserGatewayService.applyEvent`. A new event kind that the VS Code webview reacts to should be handled here and, if user-visible, surfaced in the browser app.
- **Gateway endpoints** — browser-initiated actions (send, attach, `@`-mentions, thinking toggle, mode/model/write-approval changes, approval/question submit, `/mcp` open, debug refresh, media paste/drop) round-trip through [src/browser-gateway/BrowserGatewayServer.ts](src/browser-gateway/BrowserGatewayServer.ts) and extension runtime state on [src/agent/ChatViewProvider.ts](src/agent/ChatViewProvider.ts). New user-triggered actions that affect session state usually need a matching gateway endpoint rather than browser-local state.
- **Shared rendering** — prefer the shared primitives used by both surfaces: [TranscriptMessageList.tsx](src/agent/webview/components/TranscriptMessageList.tsx), [src/shared/ui/](src/shared/ui/) (`Panes`, `Meta`, `Composer`, `ComposerBox`, `ToolbarSelector`), [src/shared/composerBehavior.ts](src/shared/composerBehavior.ts), [src/shared/chatProjection.ts](src/shared/chatProjection.ts). Most historical parity regressions came from browser-only rendering diverging from VS Code.
- **Read-only constraints** — the browser is intentionally read-only for diffs and has no remote shell surface. Do not add write/exec paths to the browser surface.
- **Multi-window** — browser gateway instance IDs are persisted in `workspaceState` (not `globalState`) so multiple VS Code windows register distinctly in the helper registry. Preserve this when touching [src/extension.ts](src/extension.ts) activation/lifecycle.

The browser webview (`src/browser-gateway/webview/`) has its own tsconfig and is **excluded from the root `tsc` program** — lint type-checks each webview tsconfig separately. Don't re-add it to root `tsconfig.json`.

If a new feature genuinely cannot work over the browser gateway (e.g. requires a VS Code-only API with no snapshot equivalent), gate it explicitly rather than silently regressing the browser surface.

## Browser/Webview ID Generation

Browser gateway pages may run over LAN HTTP, where `crypto.randomUUID()` is unavailable because the page is an insecure browser context. In browser/webview code, use `randomId()` from `src/shared/randomId.ts` instead of calling `crypto.randomUUID()` directly. This matters for Ask Agent/browser gateway flows because failures can happen before request/logging paths and look like the UI silently does nothing.
