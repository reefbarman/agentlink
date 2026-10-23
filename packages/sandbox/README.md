# @agentlink/sandbox

`@agentlink/sandbox` holds the portable parts of AgentLink's macOS command sandbox, so hosts other than the VS Code extension can launch sandboxed processes without importing extension code.

It contains:

- `SandboxPolicy` and the capability-grant binding contract (`sandboxPolicy.ts`).
- The sandbox helper wire protocol, the policy-to-launch-request compiler, and the Node helper transport and client.
- Shell environment policy resolution, Git metadata protection, and the sandbox Node runtime probe.
- The behavior attestation service and capability grant authority.

The sandbox itself is enforced by the packaged helper scripts (`scripts/sandbox-*.mjs`) on top of `@anthropic-ai/sandbox-runtime`, staged into `dist/sandbox-runtime` by `scripts/package-sandbox-runtime.mjs`. `createNodeSandboxHelperTransportFactory` still locates that staged runtime relative to an `extensionRoot`.

The VS Code terminal integration (coordinator, pty sessions, provider router, baseline launch authorizer, production behavior probe) stays in `src/terminal/sandbox` and imports from this package. Only macOS is supported today.
