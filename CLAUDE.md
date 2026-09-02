# Agent Instructions

## Building & Installing

- **Build**: `npm run build`
- **Release & install**: `npm run release -- --install` — bumps patch version, builds, packages VSIX, and installs into VS Code. Use `--major` or `--minor` for non-patch bumps. Prefer this version-bumped workflow for dogfood installs: VS Code shows an extension update badge in windows still running the previous version, making every window that needs reloading easy to identify.
- If installing a new extension version leaves a matching version-only bump in `package.json` and `package-lock.json`, include those files in the next commit instead of treating them as unrelated changes.

> ⚠️ **Packaging allowlist gotcha:** [.vscodeignore](.vscodeignore) ignores everything then re-includes specific files with `!`. **Any new bundle output in [esbuild.mjs](esbuild.mjs) (webview entry, worker, css/asset) must get a matching `!dist/<file>` line in `.vscodeignore`**, or it builds fine locally but is silently dropped from the published `.vsix` and 404s for installed users. This is easy to miss because the dev workspace `dist/` still has the file. (It bit us once already: the Monaco diff workers were omitted, so the browser Review pane diff editor rendered both sides but never computed the diff → no red/green highlighting.) After packaging, sanity-check with `npx @vscode/vsce ls`.

## Branding

- **Brand color**: `#4EC9B0` (teal) — used in `media/agentlink-terminal.svg` and throughout the chat webview UI (file picker indicator, active states)
- **Icon**: `media/agentlink.svg` uses `currentColor` (themed by VS Code); `media/agentlink-terminal.svg` uses the hardcoded brand color

## Public Documentation

Public documentation is a product surface. Keep it as current and deliberate as the code. `AGENTS.md` is a symlink to this file; edit `CLAUDE.md` and preserve that symlink.

| Artifact                                                                                      | Owns                                                                                    | Do not use it for                                                              |
| --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| [README.md](README.md)                                                                        | Product pitch, first impression, install path, broad feature overview, and links        | Tool schemas, release-note detail, internal storage, or recovery-code catalogs |
| [why-agentlink.md](why-agentlink.md)                                                          | The concise durable argument for why AgentLink is worth using                           | Setup instructions, a feature matrix, tool contracts, or changelog dumping     |
| [documentation index](resources/builtin-skills/documentation/README.md)                       | Task-oriented navigation for users and the bundled documentation skill                  | Product sales copy or duplicated detailed reference prose                      |
| Focused bundled references                                                                    | Getting started, capabilities, tools, settings, MCP, customization, and troubleshooting | Details owned by another focused guide                                         |
| [complete reference](resources/builtin-skills/documentation/references/complete-reference.md) | Compatibility coverage while focused guides are split out                               | The preferred entry point when an owning focused guide exists                  |
| [CHANGELOG.md](CHANGELOG.md)                                                                  | Release deltas                                                                          | Evergreen product explanation                                                  |
| Generated references                                                                          | Exact package metadata and release notes                                                | Manual edits                                                                   |

### README and positioning rules

- Keep `README.md` conversion-focused: a clear category statement, user outcome, visual proof when available, a short install/first-run path, and an outcome-led feature overview. Link to focused documentation instead of inlining operational detail.
- Do not claim Marketplace availability until it has been published and verified from a clean VS Code profile. Keep GitHub VSIX installation documented as a fallback.
- [why-agentlink.md](why-agentlink.md) remains a first-class public article. Keep it concise, argument-led, and current; update its date when a material differentiator, non-goal, or maturity statement changes.
- Preserve the emphasis order in the article: (1) deep editor integration, (2) steerable/visible autonomy, (3) cross-provider review, (4) context efficiency, (5) MCP and ecosystem integration. Compare with the field generally, never through named competitor attacks.
- Keep claims honest. Label rough edges and maturing work rather than promoting them to complete.

### Bundled documentation rules

[resources/builtin-skills/documentation/](resources/builtin-skills/documentation/) is the self-contained product documentation used by the built-in documentation skill. At runtime the skill must answer only from this directory and must not inspect the extension root, source code, local settings, or build output to fill a documentation gap.

- Update the owning focused reference **in the same piece of work** whenever user-facing behavior changes. Update the README or positioning article only when the change materially affects product story, onboarding, or a stated differentiator.
- `references/package-contract.md` is generated from `package.json`, and `references/release-notes.md` is generated from `CHANGELOG.md`. Do not edit either manually: run `npm run docs:generate`; `npm run build` and `npm run watch` regenerate them, and `npm run docs:check` detects drift during lint.
- Keep frontmatter single-line (AgentLink's simple `key: value` parser) and descriptions trigger-rich, per the bundled `skill-writing` skill.
- A focused page must be self-contained for its topic. Do not make it depend on the repository README for runtime answers. A complete-reference section may become a link-only stub only when its owning page lands in the same change.
- Bundled skills under `resources/builtin-skills/` are auto-discovered by `src/agent/skillLoader.ts` and shipped via the `!resources/**` line in `.vscodeignore`. Update `scripts/verify-retrieval-package.mjs` and its test whenever a new bundled owner page must ship.

### Update and validation checklist

- User-visible behavior → update the owning focused guide.
- Exact command, setting, view, default, scope, or allowed value → update the source manifest and regenerate the package contract.
- Installation or release behavior → update getting started and the README only if the top-level path changes.
- Release delta → update `CHANGELOG.md` and regenerate release notes.
- Tool changes → update `references/tools.md`, the owning workflow guide, tests, and the README only if the tool changes the public product story. Do **not** add a full parameter table to the root README.
- Refresh screenshots when UI changes make them materially misleading. Commit only optimized publication assets; keep raw captures out of the VSIX and measure package-size impact when README media changes.
- For docs-only work, run appropriate lightweight checks: generated-doc drift, Markdown links/anchors, and VSIX inventory when bundled docs or media change. Keep smoke-test notes concise and checklist-based.

## Formatting

- **Format**: `npm run fmt` — formats supported project files with Oxfmt using `.oxfmtrc.json`.
- **Check formatting**: `npm run fmt:check` — verifies formatting without writing files.
- Format touched supported files before validation. `npm run lint` also runs `oxfmt --check`, so formatting drift fails the main verification gate.
- For VS Code format-on-save, install the official Oxc extension (`oxc.oxc-vscode`) and configure it to use the repository's `.oxfmtrc.json`.

## Verification

Choose verification based on the type of change:

### Main code changes (production code, shared libraries, extension runtime, tests, build config, tool definitions)

Run full verification before considering the task complete:

1. `npm run lint` — checks Oxfmt formatting, type-checks all tsconfigs (`tsc --noEmit`), and runs oxlint. Fix **all** errors and warnings.
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

1. Add or update its metadata in `src/shared/toolRegistry.ts`
2. Add or update its input schema in `src/shared/toolSchemas.ts`
3. Wire the tool definition and dispatch path in `src/agent/toolAdapter.ts`, following the cross-layer forwarding guidance below
4. Add or update handler/unit tests for definitions, dispatch, and result behavior. When new callback or request data crosses layers, include a production composition-boundary test that proves the terminal consumer receives it.
5. Keep the VS Code and browser surfaces in parity when the tool affects shared session state or user-visible events
6. Update `references/tools.md` plus the owning workflow guide; update `README.md` only when the tool materially changes the public product story
7. If the change alters what the built-in documentation skill distills (new user-facing capability area, mode, or setting — see [Public Documentation](#public-documentation)), update that skill too
8. Run `npm run release -- --install` to rebuild and reinstall the extension. (Not when developing the agent, though)

## Cross-Layer Callback and Request Plumbing

- TypeScript intentionally permits a callback to omit trailing parameters, even with `strict` and `strictFunctionTypes`. When adding or changing callback/request data, search every wrapper, adapter, copied context, and composition root; do not rely on type-checking to detect a dropped optional or trailing value.
- For pass-through callbacks, use a handler typed from the canonical contract and forward the complete argument tuple (for example, `(...args) => target(...args)`), or pass an already-bound handler directly. Do not manually enumerate positional arguments unless the adapter is deliberately transforming them.
- Prefer a single request object for internal callback contracts expected to evolve. Forward the whole request object; when constructors should be forced to acknowledge new fields, use required keys whose values may include `undefined` rather than optional keys.
- Add a composition-boundary regression test that sends distinctive data through the production wiring and asserts that the terminal consumer receives it. Producer and consumer unit tests alone do not verify the seam between them.

## Tool Usage and Feedback Review

- Run `npm run telemetry:tools -- --top 60` to inspect the local aggregate tool-usage report before changing an existing tool because of anecdotal friction, apparent underuse, or a suspected failure pattern.
- Run `npm run telemetry:context` to inspect local context-window telemetry: large usage jumps between API requests (with per-source attribution, e.g. `tool:read_file`), post-condense estimate gaps, estimated static request floor, retrieved-context omission, and envelope overflow. Use it before tuning prompts, tool disclosure, condense thresholds, the post-condense token estimate, or investigating "context suddenly full" reports.
- Run `npm run telemetry:sessions` to inspect goal-level session outcomes: per-turn wall-clock decomposition, provider-reported cache coverage/share, resource use per self-reported completion, background agent cost/benefit, and named sanity indicators. Use it before and after changing prompts, context/tool disclosure, delegation/review behavior, or approval mechanics; do not treat self-reported completion as verifier-passed success.
- Run `npm run telemetry:mcp-auth` to inspect local MCP OAuth connection attempts, browser-open bursts, cross-window lease contention, blocked reasons, refresh fallbacks, and trigger attribution. The event stream records bounded categories and locally salted server identities; it never records tokens, headers, authorization URLs, callback parameters, or raw SDK errors.
- Use `npm run telemetry:tools -- --compare <versionsA>..<versionsB>` to compare tool usage between extension version sets (e.g. before/after a prompt change); the key-signals table covers spawn rate, background blocking time, and `execute_command` approval paths.
- Use `npm run telemetry:tools:csv` when a sortable export is useful. Generated files under `telemetry-reports/` are ignored and must not be committed.
- In dev builds, inspect relevant entries with `get_feedback` before changing tool behavior. Do not delete feedback until the issue has been addressed or deliberately declined; delete only reviewed stable IDs, not filtered-list positions.
- Treat raw call counts as directional, not as an availability-normalized adoption rate. The current telemetry does not yet say how often a tool was advertised, and legacy outcome aggregates may classify structured rejections as successful calls. See [plans/tool-usage-observability-and-adoption-plan.md](plans/tool-usage-observability-and-adoption-plan.md).
- After adding or materially changing a tool, dogfood it and rerun the report to check that it appears under the expected name/mode, records the intended outcome, does not introduce unknown parameters, and has corresponding feedback reviewed.

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

### Chat Activity Shelf

The **Chat Activity Shelf** is the resizable region between the chat transcript and the composer. It is the shared home for session activity and controls that should remain visible near the input without becoming transcript messages: context/progress indicators, queued messages, TODOs, questions and approval cards, MCP/provider status, interrupted/running state, and Agent Fleet. The composer is not part of the Chat Activity Shelf. New components in this region must preserve its bounded, internally scrollable layout and remain in parity between the VS Code and browser chat surfaces.

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

## Local planning files

- Files under `plans/` are local-only working documents and are intentionally Git-ignored.
- Do not force-add, stage, or commit any `plans/` path.
- Before committing all changes, verify that no `plans/` path is staged or tracked.
