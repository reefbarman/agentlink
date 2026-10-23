# @agentlink/sandbox

`@agentlink/sandbox` holds the portable parts of AgentLink's macOS command sandbox, so hosts other than the VS Code extension can launch sandboxed processes without importing extension code.

It contains:

- `SandboxPolicy` and the capability-grant binding contract (`sandboxPolicy.ts`).
- `prepareWorkspaceSandboxLaunch` (`workspaceSandboxPolicy.ts`): the workspace-write policy for one command. Writable workspace roots, protected Git and agent-policy metadata, private per-command HOME/TMP/cache directories, a budgeted private environment, and the launch binding that capability grants attach to. The VS Code `BaselineSandboxLaunchAuthorizer` adds grant activation on top.
- `launchSandboxedProcess` (`sandboxedProcessLauncher.ts`): a non-interactive launch for hosts without a terminal UI. It runs on pipes (stdin closed, separate stdout and stderr), with loopback-only networking, only the given roots plus private per-command directories writable, a private `TMPDIR`, and `*KEY*`/`*SECRET*`/`*TOKEN*` variables dropped by default. `@agentlink/workspace-host` adapts it to `WorkspaceProcessLauncher` with `createSandboxedWorkspaceProcessLauncher`.
- The sandbox helper wire protocol, the policy-to-launch-request compiler, and the Node helper transport and client. Launch requests may set `stdio: "pipe"`; data frames from such launches carry `stream`.
- Shell environment policy resolution, Git metadata protection, and the sandbox Node runtime probe.
- The behavior attestation service and capability grant authority.

The sandbox itself is enforced by the packaged helper scripts (`scripts/sandbox-*.mjs`) on top of `@anthropic-ai/sandbox-runtime`, staged into `dist/sandbox-runtime` by `scripts/package-sandbox-runtime.mjs`. `createNodeSandboxHelperTransportFactory` locates that staged runtime relative to an `extensionRoot`.

The VS Code terminal integration (coordinator, pty sessions, provider router, baseline launch authorizer, production behavior probe) stays in `src/terminal/sandbox` and imports from this package. Only macOS is supported today.

The real-sandbox test in `sandboxedProcessLauncher.test.ts` stages the current helper scripts and runs only on macOS with `AGENTLINK_RUN_PRODUCTION_SANDBOX_ATTESTATION=1`, outside any other sandbox.
