import type {
  ConfinementPreparingTerminalProvider,
  TerminalExecutionRouteContext,
} from "../../core/capabilities/terminal.js";
import { describe, expect, it, vi } from "vitest";

import { AgentTerminalProviderRouter } from "./AgentTerminalProviderRouter.js";

function provider(label: string) {
  const instance: ConfinementPreparingTerminalProvider & {
    dispose: ReturnType<typeof vi.fn>;
  } = {
    executeCommand: vi.fn(async (options) => ({
      exit_code: 0,
      output: label,
      output_captured: true,
      terminal_id: `${label}-1`,
      command: options.command,
    })),
    prepareConfinementExecution: vi.fn(async (options, security) => {
      let available = true;
      return {
        security,
        execute: async () => {
          if (!available) throw new Error("prepared execution unavailable");
          available = false;
          const result = await instance.executeCommand(options);
          return { ...result, security };
        },
        dispose: () => {
          available = false;
        },
      };
    }),
    getBackgroundState: vi.fn(() => undefined),
    interruptTerminal: vi.fn(() => false),
    getRecentlyClosedTerminals: vi.fn(() => []),
    listTerminals: vi.fn(() => []),
    closeTerminals: vi.fn(() => ({ closed: 0 })),
    dispose: vi.fn(),
  };
  return instance;
}

const sandboxRoute: TerminalExecutionRouteContext = {
  requiredAuthority: "sandbox",
  permissionIntent: "default",
  approvalRequirement: "policy",
  authorityReason: "approval-policy",
  approvalPolicySnapshot: "on-request" as const,
  approvalReviewerSnapshot: "auto-review" as const,
  executionPresetSnapshot: "workspace-write" as const,
  commandApprovalPolicySnapshot: "approve-for-me",
};

const nativeAgentRoute: TerminalExecutionRouteContext = {
  requiredAuthority: "native-agent",
  permissionIntent: "default",
  approvalRequirement: "policy",
  authorityReason: "approval-policy",
  approvalPolicySnapshot: "on-request" as const,
  approvalReviewerSnapshot: "user" as const,
  executionPresetSnapshot: "native-manual" as const,
  commandApprovalPolicySnapshot: "manual",
};

function harness() {
  let enabled = false;
  let sandboxAvailable = true;
  let host = {
    platform: "darwin" as NodeJS.Platform,
    remoteName: undefined as string | undefined,
    workspaceTrusted: true,
  };
  const native = provider("native");
  const nativeAgent = provider("native-agent");
  const sandbox = provider("sandbox");
  const sandboxes = [sandbox];
  const createNativeProvider = vi.fn(() => native);
  const createNativeAgentProvider = vi.fn(() => nativeAgent);
  const createSandboxProvider = vi.fn(() => {
    if (createSandboxProvider.mock.calls.length === 1) return sandbox;
    const generation = provider(`sandbox-${sandboxes.length + 1}`);
    sandboxes.push(generation);
    return generation;
  });
  const getSandboxAvailability = vi.fn(async () =>
    sandboxAvailable
      ? {
          status: "verified" as const,
          attestation: {
            attestationId: "attestation-1",
            attestationVersion: "sandbox-behavior-v2",
            policyVersion: "policy-v1",
            profileId: "workspace-write",
            backend: "seatbelt" as const,
            architecture: "arm64" as const,
            capabilities: {
              backend: "seatbelt",
              processTree: true,
              filesystemRead: "isolated" as const,
              filesystemWrite: "strict" as const,
              network: "blocked" as const,
              privateHome: true,
              privateTmp: false,
              hostIpcBlocked: false,
              resourceLimits: "partial" as const,
              warnings: [],
            },
          },
        }
      : { status: "runtime-unavailable" as const },
  );
  const log = vi.fn();
  const audit = vi.fn();
  const revealCustomTerminal = vi.fn(() => true);
  const router = new AgentTerminalProviderRouter({
    isEnabled: () => enabled,
    getHost: () => host,
    createNativeProvider,
    createNativeAgentProvider,
    createSandboxProvider,
    getSandboxAvailability,
    recordExecutionAudit: audit,
    revealCustomTerminal,
    log,
  });
  return {
    router,
    native,
    nativeAgent,
    sandbox,
    sandboxes,
    createNativeProvider,
    createNativeAgentProvider,
    createSandboxProvider,
    getSandboxAvailability,
    log,
    audit,
    revealCustomTerminal,
    setEnabled(value: boolean) {
      enabled = value;
    },
    setSandboxAvailable(value: boolean) {
      sandboxAvailable = value;
    },
    setHost(value: Partial<typeof host>) {
      host = { ...host, ...value };
    },
  };
}

describe("AgentTerminalProviderRouter", () => {
  it("emits token-free prepared and execution audit events", async () => {
    const test = harness();
    test.setEnabled(true);

    await test.router.executeCommand({
      owner: undefined,
      command: "echo super-secret-command",
      cwd: "/workspace/private-path",
      env: { SECRET_VALUE: "do-not-log" },
      sandboxSessionId: "private-session-id",
    });

    expect(test.audit.mock.calls.map(([event]) => event.type)).toEqual([
      "execution_prepared",
      "prepared_execution_consumed",
      "execution_started",
      "execution_completed",
    ]);
    const serialized = JSON.stringify(test.audit.mock.calls);
    expect(serialized).not.toContain("super-secret-command");
    expect(serialized).not.toContain("private-path");
    expect(serialized).not.toContain("SECRET_VALUE");
    expect(serialized).not.toContain("do-not-log");
    expect(serialized).not.toContain("private-session-id");
    expect(serialized).not.toContain("bindingDigest");
  });

  it("rejects managed network before routing when destination mediation is missing", async () => {
    const test = harness();
    test.setEnabled(true);

    await expect(
      test.router.prepareExecution(
        {
          owner: undefined,
          command: "npm view vite version",
          cwd: "/workspace",
          sandboxSessionId: "session-1",
          sandboxCapabilityRequest: { unrestrictedPublicNetwork: true },
        },
        { ...sandboxRoute, permissionIntent: "additional-permissions" },
      ),
    ).rejects.toThrow(
      "Managed public network requires an interactive destination authorization callback",
    );
    expect(test.createSandboxProvider).not.toHaveBeenCalled();
    expect(test.createNativeProvider).not.toHaveBeenCalled();
  });

  it("uses and reuses the native provider when disabled", async () => {
    const test = harness();

    await expect(
      test.router.executeCommand({
        owner: undefined,
        command: "pwd",
        cwd: "/workspace",
      }),
    ).resolves.toMatchObject({ output: "native", terminal_id: "native-1" });
    test.router.listTerminals({ owner: undefined });

    expect(test.createNativeProvider).toHaveBeenCalledTimes(1);
    expect(test.createSandboxProvider).not.toHaveBeenCalled();
    expect(test.getSandboxAvailability).not.toHaveBeenCalled();
  });

  it.each([
    ["linux", undefined],
    ["win32", undefined],
    ["darwin", "ssh-remote"],
  ] as const)(
    "keeps unsupported host %s/%s on native without loading sandbox assets",
    async (platform, remoteName) => {
      const test = harness();
      test.setEnabled(true);
      test.setHost({ platform, remoteName });

      await expect(
        test.router.executeCommand({
          owner: undefined,
          command: "pwd",
          cwd: "/workspace",
        }),
      ).resolves.toMatchObject({ output: "native" });
      expect(test.createSandboxProvider).not.toHaveBeenCalled();
      expect(test.getSandboxAvailability).not.toHaveBeenCalled();
    },
  );

  it("snapshots route context before asynchronous availability checks", async () => {
    let resolveAvailability!: (
      value: Awaited<
        ReturnType<
          ConstructorParameters<
            typeof AgentTerminalProviderRouter
          >[0]["getSandboxAvailability"]
        >
      >,
    ) => void;
    const availability = new Promise<
      Awaited<
        ReturnType<
          ConstructorParameters<
            typeof AgentTerminalProviderRouter
          >[0]["getSandboxAvailability"]
        >
      >
    >((resolve) => {
      resolveAvailability = resolve;
    });
    const test = harness();
    test.setEnabled(true);
    const mutableRoute = { ...sandboxRoute };
    const router = new AgentTerminalProviderRouter({
      isEnabled: () => true,
      getHost: () => ({
        platform: "darwin",
        workspaceTrusted: true,
      }),
      createNativeProvider: test.createNativeProvider,
      createNativeAgentProvider: test.createNativeAgentProvider,
      createSandboxProvider: test.createSandboxProvider,
      getSandboxAvailability: () => availability,
    });

    const preparation = router.prepareExecution(
      { owner: undefined, command: "pwd", cwd: "/workspace" },
      mutableRoute,
    );
    Object.assign(mutableRoute, nativeAgentRoute);
    resolveAvailability({
      status: "verified",
      attestation: {
        attestationId: "attestation-delayed",
        attestationVersion: "sandbox-behavior-v2",
        policyVersion: "policy-v1",
        profileId: "workspace-write",
        backend: "seatbelt",
        architecture: "arm64",
        capabilities: {
          backend: "seatbelt",
          processTree: true,
          filesystemRead: "isolated",
          filesystemWrite: "strict",
          network: "blocked",
          privateHome: true,
          privateTmp: false,
          hostIpcBlocked: false,
          resourceLimits: "partial",
          warnings: [],
        },
      },
    });

    const prepared = await preparation;
    expect(prepared.security).toMatchObject({
      requiredAuthority: "sandbox",
      permissionIntent: "default",
      approvalRequirement: "policy",
      authorityReason: "approval-policy",
      approvalPolicySnapshot: "on-request" as const,
      approvalReviewerSnapshot: "auto-review" as const,
      executionPresetSnapshot: "workspace-write" as const,
      commandApprovalPolicySnapshot: "approve-for-me",
      route: "sandbox",
    });
    expect(Object.isFrozen(prepared.security)).toBe(true);
    expect(Object.isFrozen(prepared.security.sandbox)).toBe(true);
    expect(Object.isFrozen(prepared.security.sandbox?.capabilities)).toBe(true);
    expect(
      Object.isFrozen(prepared.security.sandbox?.capabilities.warnings),
    ).toBe(true);
    expect(test.createNativeAgentProvider).not.toHaveBeenCalled();
    prepared.dispose();
    router.dispose();
  });

  it("prepares sandbox authority without executing and consumes it once", async () => {
    const test = harness();
    test.setEnabled(true);

    const prepared = await test.router.prepareExecution({
      owner: undefined,
      command: "pwd",
      cwd: "/workspace",
    });

    expect(test.sandbox.executeCommand).not.toHaveBeenCalled();
    expect(prepared.security).toMatchObject({
      route: "sandbox",
      confinement: "verified-baseline",
      executionSurface: "verified-sandbox",
      requiredAuthority: "sandbox",
      permissionIntent: "default",
      approvalRequirement: "policy",
      authorityReason: "approval-policy",
      approvalPolicySnapshot: "on-request" as const,
      approvalReviewerSnapshot: "auto-review" as const,
      executionPresetSnapshot: "workspace-write" as const,
      commandApprovalPolicySnapshot: "approve-for-me",
      executionPolicy: "sandbox-baseline-v2",
    });
    await expect(prepared.execute()).resolves.toMatchObject({
      output: "sandbox",
    });
    await expect(prepared.execute()).rejects.toThrow("no longer available");
  });

  it("rejects a prepared lease after router refresh", async () => {
    const test = harness();
    test.setEnabled(true);
    const prepared = await test.router.prepareExecution({
      owner: undefined,
      command: "pwd",
      cwd: "/workspace",
    });

    test.router.refresh();

    await expect(prepared.execute()).rejects.toThrow("no longer available");
    expect(test.sandbox.executeCommand).not.toHaveBeenCalled();
    expect(
      test.audit.mock.calls.filter(
        ([event]) => event.type === "preparation_revoked",
      ),
    ).toHaveLength(1);
  });

  it("uses one stable sandbox provider for enabled trusted local macOS", async () => {
    const test = harness();
    test.setEnabled(true);

    await expect(
      test.router.executeCommand({
        owner: undefined,
        command: "pwd",
        cwd: "/workspace",
      }),
    ).resolves.toMatchObject({ output: "sandbox" });
    test.router.getBackgroundState({
      owner: undefined,
      terminalId: "sandbox-1",
    });
    test.router.closeTerminals({ owner: undefined });

    expect(test.createSandboxProvider).toHaveBeenCalledTimes(1);
    expect(test.createNativeProvider).not.toHaveBeenCalled();
  });

  it("uses the native provider when the sandbox runtime is unavailable", async () => {
    const test = harness();
    test.setEnabled(true);
    test.setSandboxAvailable(false);

    await expect(
      test.router.executeCommand({
        owner: undefined,
        command: "pwd",
        cwd: "/workspace",
      }),
    ).resolves.toMatchObject({ output: "native", terminal_id: "native-1" });
    expect(test.createNativeProvider).toHaveBeenCalledTimes(1);
    expect(test.createSandboxProvider).not.toHaveBeenCalled();
  });

  it("fails closed when required sandbox runtime is unavailable", async () => {
    const test = harness();
    test.setEnabled(true);
    test.setSandboxAvailable(false);

    await expect(
      test.router.prepareExecution(
        { owner: undefined, command: "pwd", cwd: "/workspace" },
        sandboxRoute,
      ),
    ).rejects.toThrow("Required Sandbox execution is unavailable");
    expect(test.createNativeProvider).not.toHaveBeenCalled();
    expect(test.createNativeAgentProvider).not.toHaveBeenCalled();
    expect(test.sandbox.executeCommand).not.toHaveBeenCalled();
  });

  it("fails closed with a Native Agent availability error when initialization fails", async () => {
    const test = harness();
    test.setEnabled(true);
    test.createNativeAgentProvider.mockImplementation(() => {
      throw new Error("Packaged node-pty is missing");
    });

    await expect(
      test.router.prepareExecution(
        { owner: undefined, command: "pwd", cwd: "/workspace" },
        nativeAgentRoute,
      ),
    ).rejects.toThrow(
      "Required Native Agent execution is unavailable: Packaged node-pty is missing. No compatibility terminal fallback was attempted.",
    );
    expect(test.createNativeProvider).not.toHaveBeenCalled();
    expect(test.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "execution_failed",
        failure: "native_runtime_unavailable",
      }),
    );
  });

  it("routes required Native Agent authority only to its dedicated provider", async () => {
    const test = harness();
    test.setEnabled(true);

    const prepared = await test.router.prepareExecution(
      { owner: undefined, command: "pwd", cwd: "/workspace" },
      nativeAgentRoute,
    );
    await expect(prepared.execute()).resolves.toMatchObject({
      output: "native-agent",
      security: {
        route: "native",
        executionSurface: "agentlink-native",
        requiredAuthority: "native-agent",
      },
    });
    expect(test.createNativeAgentProvider).toHaveBeenCalledTimes(1);
    expect(test.createNativeProvider).not.toHaveBeenCalled();
    expect(test.createSandboxProvider).not.toHaveBeenCalled();
  });

  it.each([
    ["host target", "host-terminal-1", "host target"],
    ["unknown target", "missing-terminal", "not found"],
  ])(
    "rejects an explicit %s without retargeting",
    async (_name, terminalId, reason) => {
      const test = harness();
      test.setEnabled(true);

      await expect(
        test.router.prepareExecution(
          {
            owner: undefined,
            command: "pwd",
            cwd: "/workspace",
            terminal_id: terminalId,
          },
          sandboxRoute,
        ),
      ).rejects.toThrow(reason);
      expect(test.sandbox.executeCommand).not.toHaveBeenCalled();
      expect(test.native.executeCommand).not.toHaveBeenCalled();
      expect(test.nativeAgent.executeCommand).not.toHaveBeenCalled();
    },
  );

  it("rejects an explicit terminal owned by the wrong authority", async () => {
    const test = harness();
    test.setEnabled(true);
    vi.mocked(test.nativeAgent.listTerminals).mockReturnValue([
      { id: "native-agent-1", name: "Native Agent", busy: false },
    ]);
    const nativePrepared = await test.router.prepareExecution(
      { owner: undefined, command: "pwd", cwd: "/workspace" },
      nativeAgentRoute,
    );
    await nativePrepared.execute();

    await expect(
      test.router.prepareExecution(
        {
          owner: undefined,
          command: "pwd",
          cwd: "/workspace",
          terminal_id: "native-agent-1",
        },
        sandboxRoute,
      ),
    ).rejects.toThrow("wrong authority");
    expect(test.sandbox.executeCommand).not.toHaveBeenCalled();
  });

  it("rejects ambiguous names across authority providers", async () => {
    const test = harness();
    test.setEnabled(true);
    vi.mocked(test.nativeAgent.listTerminals).mockReturnValue([
      { id: "native-agent-1", name: "Shared", busy: false },
    ]);
    vi.mocked(test.sandbox.listTerminals).mockReturnValue([
      { id: "sandbox-1", name: "Shared", busy: false },
    ]);
    await (
      await test.router.prepareExecution(
        { owner: undefined, command: "pwd", cwd: "/workspace" },
        nativeAgentRoute,
      )
    ).execute();

    await expect(
      test.router.prepareExecution(
        {
          owner: undefined,
          command: "pwd",
          cwd: "/workspace",
          terminal_name: "Shared",
        },
        sandboxRoute,
      ),
    ).rejects.toThrow("ambiguous name");
  });

  it("routes lifecycle operations only to the exact terminal owner", async () => {
    const test = harness();
    test.setEnabled(true);
    vi.mocked(test.sandbox.listTerminals).mockReturnValue([
      { id: "sandbox-1", name: "Sandbox", busy: true },
    ]);
    vi.mocked(test.sandbox.getBackgroundState).mockReturnValue({
      is_running: true,
      state: "running",
      exit_code: null,
      output: "running",
      output_captured: true,
    });
    vi.mocked(test.sandbox.interruptTerminal).mockReturnValue(true);
    await (
      await test.router.prepareExecution(
        { owner: undefined, command: "pwd", cwd: "/workspace" },
        sandboxRoute,
      )
    ).execute();

    expect(
      test.router.getBackgroundState({
        owner: undefined,
        terminalId: "sandbox-1",
      }),
    ).toMatchObject({
      output: "running",
    });
    expect(
      test.router.interruptTerminal({
        owner: undefined,
        terminalId: "sandbox-1",
      }),
    ).toBe(true);
    expect(
      test.router.interruptTerminal({
        owner: undefined,
        terminalId: "unknown-1",
      }),
    ).toBe(false);
    expect(test.sandbox.interruptTerminal).toHaveBeenCalledTimes(1);
    expect(test.native.interruptTerminal).not.toHaveBeenCalled();
    expect(test.nativeAgent.interruptTerminal).not.toHaveBeenCalled();
  });

  it("aggregates recently closed terminals across active authorities", async () => {
    const test = harness();
    test.setEnabled(true);
    vi.mocked(test.nativeAgent.getRecentlyClosedTerminals).mockReturnValue([
      {
        id: "native-agent-closed",
        name: "Native Agent",
        closedAt: 20,
        is_running: false,
        state: "completed",
        exit_code: 0,
        output: "native output",
        output_captured: true,
      },
    ]);
    vi.mocked(test.sandbox.getRecentlyClosedTerminals).mockReturnValue([
      {
        id: "sandbox-closed",
        name: "Sandbox",
        closedAt: 10,
        is_running: false,
        state: "completed",
        exit_code: 0,
        output: "sandbox output",
        output_captured: true,
      },
    ]);
    await (
      await test.router.prepareExecution(
        { owner: undefined, command: "pwd", cwd: "/workspace" },
        nativeAgentRoute,
      )
    ).execute();
    await (
      await test.router.prepareExecution(
        { owner: undefined, command: "pwd", cwd: "/workspace" },
        sandboxRoute,
      )
    ).execute();

    expect(
      test.router.getRecentlyClosedTerminals({ owner: undefined, limit: 5 }),
    ).toEqual([
      expect.objectContaining({ id: "native-agent-closed" }),
      expect.objectContaining({ id: "sandbox-closed" }),
    ]);
    expect(test.nativeAgent.getRecentlyClosedTerminals).toHaveBeenCalledWith({
      owner: undefined,
      limit: 5,
    });
    expect(test.sandbox.getRecentlyClosedTerminals).toHaveBeenCalledWith({
      owner: undefined,
      limit: 5,
    });
  });

  it("reveals exact custom terminals through the surface fallback", async () => {
    const test = harness();
    test.setEnabled(true);
    vi.mocked(test.sandbox.listTerminals).mockReturnValue([
      { id: "sandbox-1", name: "Sandbox", busy: true },
    ]);
    await (
      await test.router.prepareExecution(
        { owner: undefined, command: "pwd", cwd: "/workspace" },
        sandboxRoute,
      )
    ).execute();

    expect(
      test.router.revealTerminal({ owner: undefined, terminalId: "sandbox-1" }),
    ).toBe(true);
    expect(test.revealCustomTerminal).toHaveBeenCalledWith("sandbox-1");
    expect(
      test.router.revealTerminal({ owner: undefined, terminalId: "unknown-1" }),
    ).toBe(false);
    expect(test.revealCustomTerminal).toHaveBeenCalledTimes(1);
  });

  it("keeps provider-native terminal reveal authoritative", async () => {
    const test = harness();
    const revealTerminal = vi.fn(() => false);
    test.setEnabled(false);
    test.native.revealTerminal = revealTerminal;
    vi.mocked(test.native.listTerminals).mockReturnValue([
      { id: "native-1", name: "Native", busy: true },
    ]);
    await test.router.executeCommand({
      owner: undefined,
      command: "pwd",
      cwd: "/workspace",
    });

    expect(
      test.router.revealTerminal({ owner: undefined, terminalId: "native-1" }),
    ).toBe(false);
    expect(revealTerminal).toHaveBeenCalledWith({
      owner: undefined,
      terminalId: "native-1",
    });
    expect(test.revealCustomTerminal).not.toHaveBeenCalled();
  });

  it("does not close host targets or ambiguous cross-provider names", async () => {
    const test = harness();
    test.setEnabled(true);
    vi.mocked(test.nativeAgent.listTerminals).mockReturnValue([
      { id: "native-agent-1", name: "Shared", busy: false },
    ]);
    vi.mocked(test.sandbox.listTerminals).mockReturnValue([
      { id: "sandbox-1", name: "Shared", busy: false },
    ]);
    await (
      await test.router.prepareExecution(
        { owner: undefined, command: "pwd", cwd: "/workspace" },
        nativeAgentRoute,
      )
    ).execute();
    await (
      await test.router.prepareExecution(
        { owner: undefined, command: "pwd", cwd: "/workspace" },
        sandboxRoute,
      )
    ).execute();

    expect(
      test.router.closeTerminals({
        owner: undefined,
        names: ["Shared", "host-terminal-1"],
      }),
    ).toEqual({
      closed: 0,
      not_found: ["Shared", "host-terminal-1"],
    });
    expect(test.nativeAgent.closeTerminals).not.toHaveBeenCalled();
    expect(test.sandbox.closeTerminals).not.toHaveBeenCalled();
  });

  it("fails closed when runtime availability is lost after sandbox selection", async () => {
    const test = harness();
    test.setEnabled(true);
    await test.router.executeCommand({
      owner: undefined,
      command: "pwd",
      cwd: "/workspace",
    });

    test.setSandboxAvailable(false);
    await expect(
      test.router.executeCommand({
        owner: undefined,
        command: "echo must not downgrade",
        cwd: "/workspace",
      }),
    ).rejects.toThrow("failed closed");
    expect(test.createSandboxProvider).toHaveBeenCalledTimes(1);
    expect(test.createNativeProvider).not.toHaveBeenCalled();
  });

  it("fails closed for an untrusted enabled local macOS workspace", async () => {
    const test = harness();
    test.setEnabled(true);
    test.setHost({ workspaceTrusted: false });

    await expect(
      test.router.executeCommand({
        owner: undefined,
        command: "pwd",
        cwd: "/workspace",
      }),
    ).rejects.toThrow("unavailable until the workspace is trusted");
    expect(test.createNativeProvider).not.toHaveBeenCalled();
    expect(test.createSandboxProvider).not.toHaveBeenCalled();
  });

  it("latches sandbox initialization failure without native fallback", async () => {
    const test = harness();
    test.setEnabled(true);
    test.createSandboxProvider.mockImplementation(() => {
      throw new Error("helper missing");
    });

    await expect(
      test.router.executeCommand({
        owner: undefined,
        command: "pwd",
        cwd: "/workspace",
      }),
    ).rejects.toThrow("failed closed: helper missing");
    await expect(
      test.router.executeCommand({
        owner: undefined,
        command: "echo again",
        cwd: "/workspace",
      }),
    ).rejects.toThrow("failed closed: helper missing");

    expect(test.createSandboxProvider).toHaveBeenCalledTimes(1);
    expect(test.createNativeProvider).not.toHaveBeenCalled();
    expect(test.log).toHaveBeenCalledWith(
      expect.stringContaining("Initialization failed closed: helper missing"),
    );
  });

  it("keeps status queries attached to an existing sandbox across route changes", async () => {
    const test = harness();
    test.setEnabled(true);
    await test.router.executeCommand({
      owner: undefined,
      command: "pwd",
      cwd: "/workspace",
    });

    test.setEnabled(false);
    test.router.listTerminals({ owner: undefined });

    expect(test.sandbox.listTerminals).toHaveBeenCalledTimes(1);
    expect(test.sandbox.dispose).not.toHaveBeenCalled();
    expect(test.createNativeProvider).not.toHaveBeenCalled();
  });

  it("keeps existing sandbox channels while routing new work native after disable", async () => {
    const test = harness();
    test.setEnabled(true);
    await test.router.executeCommand({
      owner: undefined,
      command: "pwd",
      cwd: "/workspace",
    });

    test.setEnabled(false);
    await expect(
      test.router.executeCommand({
        owner: undefined,
        command: "echo native",
        cwd: "/workspace",
      }),
    ).resolves.toMatchObject({ output: "native" });

    expect(test.sandbox.dispose).not.toHaveBeenCalled();
    expect(test.createNativeProvider).toHaveBeenCalledTimes(1);
  });

  it("refreshes sandbox routing across enabled, disabled, and re-enabled states", async () => {
    const test = harness();
    test.setEnabled(true);
    await expect(
      test.router.executeCommand({
        owner: undefined,
        command: "echo sandbox",
        cwd: "/workspace",
      }),
    ).resolves.toMatchObject({ output: "sandbox" });
    const oldLease = await test.router.prepareExecution({
      owner: undefined,
      command: "echo prepared",
      cwd: "/workspace",
    });
    expect(test.getSandboxAvailability).toHaveBeenCalledTimes(2);
    expect(test.createSandboxProvider).toHaveBeenCalledTimes(1);

    test.setEnabled(false);
    test.router.refresh();

    await expect(oldLease.execute()).rejects.toThrow("no longer available");
    expect(test.sandbox.dispose).toHaveBeenCalledTimes(1);
    await expect(
      test.router.executeCommand({
        owner: undefined,
        command: "echo native",
        cwd: "/workspace",
      }),
    ).resolves.toMatchObject({ output: "native" });
    expect(test.getSandboxAvailability).toHaveBeenCalledTimes(2);

    test.setEnabled(true);
    test.router.refresh();
    await expect(
      test.router.executeCommand({
        owner: undefined,
        command: "echo fresh sandbox",
        cwd: "/workspace",
      }),
    ).resolves.toMatchObject({ output: "sandbox-2" });

    expect(test.getSandboxAvailability).toHaveBeenCalledTimes(3);
    expect(test.createSandboxProvider).toHaveBeenCalledTimes(2);
    expect(test.sandbox.executeCommand).toHaveBeenCalledTimes(1);
    expect(test.sandboxes[1]?.executeCommand).toHaveBeenCalledTimes(1);
    expect(test.native.executeCommand).toHaveBeenCalledTimes(1);
    await expect(oldLease.execute()).rejects.toThrow("no longer available");
  });

  it("retains a logger assigned before lazy provider creation", async () => {
    const test = harness();
    const assignedLog = vi.fn();
    test.router.log = assignedLog;
    test.setEnabled(true);

    await test.router.executeCommand({
      owner: undefined,
      command: "pwd",
      cwd: "/workspace",
    });

    expect(test.router.log).toBe(assignedLog);
    expect(test.sandbox.log).toBe(assignedLog);
  });

  it("disposes an empty Native Agent provider on route refresh", async () => {
    const test = harness();
    test.setEnabled(true);
    await (
      await test.router.prepareExecution(
        { owner: undefined, command: "pwd", cwd: "/workspace" },
        nativeAgentRoute,
      )
    ).execute();

    test.router.refresh();

    expect(test.nativeAgent.dispose).toHaveBeenCalledTimes(1);
    await (
      await test.router.prepareExecution(
        { owner: undefined, command: "pwd", cwd: "/workspace" },
        nativeAgentRoute,
      )
    ).execute();
    expect(test.createNativeAgentProvider).toHaveBeenCalledTimes(2);
  });

  it("rejects new execution in a retired Native Agent channel", async () => {
    const test = harness();
    vi.mocked(test.nativeAgent.listTerminals).mockReturnValue([
      { id: "native-agent-1", name: "Retired Native", busy: true },
    ]);
    test.setEnabled(true);
    await (
      await test.router.prepareExecution(
        { owner: undefined, command: "sleep 30", cwd: "/workspace" },
        nativeAgentRoute,
      )
    ).execute();

    test.router.refresh();
    const nextNativeAgent = provider("native-agent-2");
    test.createNativeAgentProvider.mockImplementationOnce(
      () => nextNativeAgent,
    );

    await expect(
      test.router.prepareExecution(
        {
          owner: undefined,
          command: "pwd",
          cwd: "/workspace",
          terminal_id: "native-agent-1",
        },
        nativeAgentRoute,
      ),
    ).rejects.toThrow("provider retired");
    expect(test.nativeAgent.executeCommand).toHaveBeenCalledTimes(1);
    expect(test.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "execution_failed",
        failure: "provider_retired",
      }),
    );
  });

  it("retains a live Native Agent provider across refresh until its channel closes", async () => {
    const test = harness();
    const terminals = [
      { id: "native-agent-1", name: "Native Agent", busy: true },
    ];
    vi.mocked(test.nativeAgent.listTerminals).mockImplementation(() => [
      ...terminals,
    ]);
    vi.mocked(test.nativeAgent.getBackgroundState).mockReturnValue({
      is_running: true,
      state: "running",
      exit_code: null,
      output: "still running",
      output_captured: true,
    });
    vi.mocked(test.nativeAgent.closeTerminals).mockImplementation(() => {
      terminals.length = 0;
      return { closed: 1 };
    });
    const closedTerminal = {
      id: "native-agent-1",
      name: "Native Agent",
      closedAt: 500,
      is_running: false,
      state: "unknown_termination" as const,
      exit_code: null,
      output: "still running",
      output_captured: true,
    };
    vi.mocked(test.nativeAgent.getRecentlyClosedTerminals).mockReturnValue([
      closedTerminal,
    ]);
    const metadata = vi.fn(() => ({
      complete: false,
      finalized: false,
      total_bytes: 13,
      retained_bytes: 13,
      dropped_bytes: 0,
    }));
    const read = vi.fn(() => ({
      output: "still running",
      ...metadata(),
    }));
    const dispose = vi.fn();
    test.nativeAgent.detachRetainedOutput = vi.fn(() => ({
      metadata,
      read,
      dispose,
    }));
    test.setEnabled(true);
    await (
      await test.router.prepareExecution(
        { owner: undefined, command: "sleep 30", cwd: "/workspace" },
        nativeAgentRoute,
      )
    ).execute();

    test.router.refresh();

    expect(test.nativeAgent.dispose).not.toHaveBeenCalled();
    expect(
      test.router.getBackgroundState({
        owner: undefined,
        terminalId: "native-agent-1",
      }),
    ).toMatchObject({
      is_running: true,
      output: "still running",
    });
    expect(
      test.router.closeTerminals({
        owner: undefined,
        names: ["native-agent-1"],
      }),
    ).toEqual({
      closed: 1,
    });
    expect(test.nativeAgent.dispose).toHaveBeenCalledTimes(1);
    expect(test.nativeAgent.detachRetainedOutput).toHaveBeenCalledWith({
      owner: undefined,
      terminalId: "native-agent-1",
    });
    expect(read).not.toHaveBeenCalled();
    expect(
      test.router.getRecentlyClosedTerminals({ owner: undefined }),
    ).toEqual([closedTerminal]);
    expect(
      test.router.getRetainedOutput({
        owner: undefined,
        terminalId: "native-agent-1",
      }),
    ).toEqual({
      output: "still running",
      complete: false,
      finalized: false,
      total_bytes: 13,
      retained_bytes: 13,
      dropped_bytes: 0,
    });
    expect(read).toHaveBeenCalledOnce();

    test.router.dispose();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("disposes an empty retired sandbox and creates a new generation", async () => {
    const test = harness();
    test.setEnabled(true);
    await test.router.executeCommand({
      owner: undefined,
      command: "pwd",
      cwd: "/workspace",
    });

    test.router.refresh();
    expect(test.sandbox.dispose).toHaveBeenCalledTimes(1);
    await test.router.executeCommand({
      owner: undefined,
      command: "pwd",
      cwd: "/workspace",
    });
    expect(test.createSandboxProvider).toHaveBeenCalledTimes(2);
    test.router.dispose();
    expect(test.sandbox.dispose).toHaveBeenCalledTimes(1);
    expect(test.sandboxes[1]?.dispose).toHaveBeenCalledTimes(1);
  });

  it("rejects new execution in a retired sandbox channel", async () => {
    const test = harness();
    vi.mocked(test.sandbox.listTerminals).mockReturnValue([
      { id: "sandbox-1", name: "Retired Sandbox", busy: true },
    ]);
    test.setEnabled(true);
    await test.router.executeCommand({
      owner: undefined,
      command: "sleep 30",
      cwd: "/workspace",
    });

    test.router.refresh();

    await expect(
      test.router.prepareExecution(
        {
          owner: undefined,
          command: "pwd",
          cwd: "/workspace",
          terminal_name: "Retired Sandbox",
        },
        sandboxRoute,
      ),
    ).rejects.toThrow("provider retired");
    expect(test.sandbox.executeCommand).toHaveBeenCalledTimes(1);
    expect(test.sandboxes[1]?.executeCommand).not.toHaveBeenCalled();
    expect(test.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "execution_failed",
        failure: "provider_retired",
      }),
    );
  });

  it("retains a retired sandbox with a live channel and evicts it after close", async () => {
    const test = harness();
    const terminals = [{ id: "sandbox-1", name: "Agent command", busy: false }];
    vi.mocked(test.sandbox.listTerminals).mockImplementation(() => [
      ...terminals,
    ]);
    vi.mocked(test.sandbox.closeTerminals).mockImplementation(() => {
      terminals.length = 0;
      return { closed: 1 };
    });
    const closedTerminal = {
      id: "sandbox-1",
      name: "Agent command",
      closedAt: 500,
      is_running: false,
      state: "completed" as const,
      exit_code: 0,
      output: "done",
      output_captured: true,
    };
    vi.mocked(test.sandbox.getRecentlyClosedTerminals).mockReturnValue([
      closedTerminal,
    ]);
    const metadata = vi.fn(() => ({
      complete: true,
      finalized: true,
      total_bytes: 4,
      retained_bytes: 4,
      dropped_bytes: 0,
    }));
    const read = vi.fn(() => ({
      output: "done",
      ...metadata(),
    }));
    const dispose = vi.fn();
    test.sandbox.detachRetainedOutput = vi.fn(() => ({
      metadata,
      read,
      dispose,
    }));
    test.setEnabled(true);
    await test.router.executeCommand({
      owner: undefined,
      command: "pwd",
      cwd: "/workspace",
    });

    test.router.refresh();
    expect(test.sandbox.dispose).not.toHaveBeenCalled();

    expect(
      test.router.closeTerminals({ owner: undefined, names: ["sandbox-1"] }),
    ).toEqual({ closed: 1 });
    expect(test.sandbox.dispose).toHaveBeenCalledTimes(1);
    expect(test.sandbox.detachRetainedOutput).toHaveBeenCalledWith({
      owner: undefined,
      terminalId: "sandbox-1",
    });
    expect(read).not.toHaveBeenCalled();
    expect(
      test.router.getRecentlyClosedTerminals({ owner: undefined }),
    ).toEqual([closedTerminal]);
    expect(
      test.router.getRetainedOutput({
        owner: undefined,
        terminalId: "sandbox-1",
      }),
    ).toEqual({
      output: "done",
      complete: true,
      finalized: true,
      total_bytes: 4,
      retained_bytes: 4,
      dropped_bytes: 0,
    });
    expect(read).toHaveBeenCalledOnce();

    test.router.dispose();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("treats extension-host reload as cleanup-only across active and retired providers", async () => {
    const test = harness();
    vi.mocked(test.sandbox.listTerminals).mockReturnValue([
      { id: "sandbox-1", name: "Retired Sandbox", busy: true },
    ]);
    test.setEnabled(true);
    await test.router.executeCommand({
      owner: undefined,
      command: "sleep 30",
      cwd: "/workspace",
    });

    test.router.refresh();
    await test.router.executeCommand({
      owner: undefined,
      command: "printf active sandbox",
      cwd: "/workspace",
    });
    await (
      await test.router.prepareExecution(
        {
          owner: undefined,
          command: "printf active native",
          cwd: "/workspace",
        },
        nativeAgentRoute,
      )
    ).execute();
    const pending = await test.router.prepareExecution(
      { owner: undefined, command: "printf never launched", cwd: "/workspace" },
      sandboxRoute,
    );

    test.router.dispose();
    test.router.dispose();

    expect(test.sandbox.dispose).toHaveBeenCalledTimes(1);
    expect(test.sandboxes[1]?.dispose).toHaveBeenCalledTimes(1);
    expect(test.nativeAgent.dispose).toHaveBeenCalledTimes(1);
    await expect(pending.execute()).rejects.toThrow("no longer available");
    expect(test.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "preparation_revoked",
        failure: "lease_revoked",
      }),
    );
    expect(() => test.router.listTerminals({ owner: undefined })).toThrow(
      "router is disposed",
    );

    const reloaded = harness();
    expect(reloaded.router.listTerminals({ owner: undefined })).toEqual([]);
    expect(reloaded.createNativeProvider).not.toHaveBeenCalled();
    expect(reloaded.createNativeAgentProvider).not.toHaveBeenCalled();
    expect(reloaded.createSandboxProvider).not.toHaveBeenCalled();
  });

  it("disposes the sandbox provider exactly once", async () => {
    const test = harness();
    test.setEnabled(true);
    await test.router.executeCommand({
      owner: undefined,
      command: "pwd",
      cwd: "/workspace",
    });

    test.router.dispose();
    test.router.dispose();
    expect(test.sandbox.dispose).toHaveBeenCalledTimes(1);
    expect(() => test.router.listTerminals({ owner: undefined })).toThrow(
      "router is disposed",
    );
  });
});
