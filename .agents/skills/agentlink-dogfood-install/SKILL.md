---
name: agentlink-dogfood-install
description: Install AgentLink; wait for reload.
---

# AgentLink Dogfood Install

Use this workflow when a task needs the current AgentLink checkout installed into VS Code for live testing.

## Required workflow

1. Finish the intended code and documentation changes and run the appropriate validation before installing.
2. Run `npm run release -- --install` from the repository root with `execute_command` using `sandbox_permissions: "require_escalated"` and a clear reason. The install must run outside the sandbox because sandboxed installation does not update the real VS Code extension installation.
3. Do not retry the install in the sandbox. If the escalated command is rejected or fails, report the exact result and stop unless the returned retry guidance authorizes a different exact recovery.
4. After a successful install, stop all implementation, testing, terminal work, and smoke testing. Ask the user to reload the relevant VS Code window or windows and tell you when reload is complete.
5. End the turn with `set_task_status` using `status: "waiting_for_user"`. Include the installed version when known, and provide a continuation action that asks the user to confirm the reload.
6. Do not assume installation activates the new extension in the current window. Do not continue merely because the install command succeeded or because VS Code reports an update badge.
7. Resume live smoke testing only after the user explicitly confirms that this window has reloaded. Treat any message that clearly confirms reload as sufficient; otherwise keep waiting or ask one focused confirmation question.

## Installation command

```sh
npm run release -- --install
```

Do not manually bump the version first. The release workflow owns the version bump, build, VSIX packaging, verification, and installation. If an earlier failed release already bumped the version, rerunning the release workflow may bump it again; report the final installed version and keep the resulting `package.json` and `package-lock.json` changes.

## Reload handoff

Use concise wording such as:

> Installed AgentLink `<version>`. Please reload this VS Code window, then tell me when it is back. I will not continue the smoke test until you confirm the reload.

Do not call additional tools after issuing this handoff until the user confirms reload.
