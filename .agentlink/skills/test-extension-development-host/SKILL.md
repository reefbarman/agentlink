---
name: test-extension-development-host
description: Test and debug AgentLink changes in an isolated VS Code Extension Development Host. Use when an agent needs to launch or reload the development extension, validate activation or VS Code API behavior, inspect chat/sidebar/approval/terminal webviews, reproduce a host-only bug, verify browser-gateway parity against a running development instance, or collect Extension Host, output-channel, developer-tools, console, network, and screenshot evidence. Also use to decide whether a change needs only browser/component tests or a real host smoke test.
---

# Test Extension Development Host

Validate the smallest real-host surface needed for the change, preserve user state, and return evidence that distinguishes build, activation, extension-runtime, webview, and browser-gateway failures.

## Choose the test surface

Use the existing Vitest/component suite when the behavior is surface-neutral or DOM layout is irrelevant.

Use a standalone browser UI lab or browser fixture when one exists and the change concerns Preact rendering, CSS, scrolling, focus, responsive layout, or scripted webview events. Do not launch VS Code merely to inspect production components that the browser harness covers.

Use the Extension Development Host when the change touches or may depend on:

- extension activation, contributions, commands, settings, or lifecycle;
- `ChatViewProvider`, sidebar/approval/terminal providers, webview HTML, CSP, resource URIs, or the webview/extension message boundary;
- VS Code workspace, editor, diagnostics, language, secrets, terminal, diff, or file-picker APIs;
- browser gateway registration, credential grants, instance routing, or parity with a VS Code-owned session;
- a bug that occurs only inside VS Code.

Use an installed VSIX only for packaging/release dogfood or when the user explicitly requests installation. Do not run `npm run release -- --install` for ordinary development-host iteration.

## Inspect before launching

1. Read `AGENTS.md`, `.vscode/launch.json`, the affected provider/entry point, and focused tests.
2. Inspect `git status --short`. Preserve all unrelated user changes.
3. Identify the smoke path and expected visible or observable result before starting.
4. Choose the reload scope:

   - Preact/CSS only: rebuild, then reload the affected webview; reload the host if state makes this unreliable.
   - Webview messages or provider behavior: rebuild and reload the Development Host.
   - Extension runtime, contributions, settings, helper/server, native dependencies, or build configuration: rebuild and restart/reload the Development Host.
   - Browser gateway bundle only: rebuild, restart the gateway if necessary, then refresh the browser.

## Build and start

Run `npm run build` before the first launch. Use `npm run watch` in a persistent terminal for repeated edits.

Prefer the repository's `Run Extension` launch configuration: press F5 from the source workspace. It builds first and opens a window whose title includes `[Extension Development Host]`.

If the agent has desktop-control capability, it may operate that isolated window. If it lacks desktop control, ask the user to launch F5 or perform the specific blocking UI action while continuing all non-blocked terminal and file inspection.

Before launching any GUI process from a shell tool, request the required approval. Never automate the user's ordinary VS Code window. When a scripted host launcher becomes available, require:

- a temporary `--user-data-dir`;
- a temporary `--extensions-dir`;
- a dedicated fixture workspace;
- `--disable-extensions` except for the development extension;
- cleanup limited to exact validated temporary directories.

Confirm the tested window is the Extension Development Host, not the source or normal installed-extension window.

## Exercise the smoke path

Keep the scenario minimal and deterministic:

1. Open the contributed AgentLink surface or run the relevant AgentLink command.
2. Confirm activation completes and the surface renders.
3. Perform the smallest action that crosses the changed seam.
4. Observe both producer and terminal consumer when callback/request data crosses layers.
5. Use distinctive fixture data so stale or default state cannot accidentally satisfy the check.
6. Verify the browser gateway too when chat/session state or agent UI events changed.

Use a disposable fixture workspace for writes, commands, approvals, terminals, or file operations. Do not enable master bypass or broad approval rules merely to simplify a smoke test.

## Inspect failures

Collect evidence from the narrowest relevant source:

- **Build/type error:** inspect the build terminal and expected `dist` output.
- **Activation/provider error:** inspect **View > Output > AgentLink**, **AgentLink Agent**, and Extension Host logs.
- **Webview error:** run **Developer: Toggle Developer Tools** or the available webview developer-tools command; inspect the webview frame console, network, DOM, computed `--vscode-*` variables, and failed resource URLs.
- **Stale webview:** confirm `npm run watch` rebuilt the expected bundle, then reload the webview or Development Host.
- **Browser gateway error:** run **AgentLink: Show Browser Gateway Status**, inspect AgentLink output, restart with **AgentLink: Restart Browser Gateway**, refresh the page, and inspect browser console/network.
- **Contribution/lifecycle error:** inspect `package.json`, activation logs, **Developer: Show Running Extensions**, and rerun in a clean isolated host.
- **Cross-layer data loss:** trace every adapter/wrapper/composition root and add a production composition-boundary test with distinctive data.

Do not report success from appearance alone. Check console/output errors and the expected command, state, or terminal effect.

## Iterate safely

After a code edit:

1. Let `npm run watch` finish and inspect compilation output.
2. Apply the selected reload scope.
3. Repeat only the focused smoke path.
4. Capture new console/output errors immediately.
5. Stop leaked helper, watch, test, or host processes when the task is done, without touching unrelated user processes.

Do not delete AgentLink feedback entries during diagnosis. Review relevant feedback before changing existing tool behavior, as required by `AGENTS.md`.

## Finish verification

A manual or automated Development Host smoke does not replace repository verification.

For main code changes:

```text
npm run fmt
npm run lint
npm test
```

Run focused browser-gateway gates when that surface changed. If production bundle outputs changed, verify the `.vscodeignore` allowlist and inspect the packaged file list as required by `AGENTS.md`.

For docs-only or local planning/skill changes, use lightweight validation and state that full lint/test was skipped.

Report:

- exact build/test commands and outcomes;
- host launch method and isolation used;
- scenario exercised;
- expected versus observed behavior;
- output channels, console/network, screenshots, or traces inspected;
- browser parity result when applicable;
- anything not tested and why.
