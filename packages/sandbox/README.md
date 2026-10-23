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

The VS Code terminal integration (coordinator, pty sessions, provider router, baseline launch authorizer, production behavior probe) stays in `src/terminal/sandbox` and imports from this package. That integration is macOS-only today.

## Linux (bubblewrap)

The helper and `launchSandboxedProcess` also run on Linux x64 and arm64 (glibc), where launch metadata reports `backend: "bubblewrap"`. No AgentLink surface turns this on yet. Commands run under bubblewrap with a read-only root, private network, PID and user namespaces and no capabilities, and under `apply-seccomp`, which stops them creating unix sockets. Loopback is private to the sandbox, so commands cannot reach services on the host's localhost.

It needs `/usr/bin/bwrap` (0.4+), `socat` in `/usr/bin` or `/bin`, ripgrep (`/usr/bin/rg`, or a host binary passed as `ripgrepPath` to `createNodeSandboxHelperTransportFactory`), and `vendor/seccomp/<arch>/apply-seccomp` in the staged runtime. Nothing is looked up on `PATH`, and a launch is refused when any of them is missing. `checkLinuxSandboxPrerequisites` reports each requirement with a distribution-specific fix. It also runs a real bubblewrap and `apply-seccomp` probe, because Ubuntu 23.10 and later restrict unprivileged user namespaces through AppArmor. There the sandbox cannot run until the host relaxes `kernel.apparmor_restrict_unprivileged_userns`, a machine-wide change AgentLink never makes itself.

`scripts/build-apply-seccomp.mjs` builds `apply-seccomp` from the `@anthropic-ai/sandbox-runtime` release source pinned by version and sha256 (the npm package ships neither the binary nor its source). Release and CI packaging build it for `linux-x64` and `linux-arm64` and set `AGENTLINK_APPLY_SECCOMP_REQUIRED=1`, so a Linux VSIX cannot ship without it.

The real-sandbox test in `sandboxedProcessLauncher.test.ts` stages the current helper scripts and runs only on macOS with `AGENTLINK_RUN_PRODUCTION_SANDBOX_ATTESTATION=1`, outside any other sandbox.
