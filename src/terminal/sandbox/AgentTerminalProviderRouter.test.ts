import { describe, expect, it, vi } from "vitest";

import { AgentTerminalProviderRouter } from "./AgentTerminalProviderRouter.js";
import type { ConfinementPreparingTerminalProvider } from "../../core/capabilities/terminal.js";

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

function harness() {
  let enabled = false;
  let sandboxAvailable = true;
  let host = {
    platform: "darwin" as NodeJS.Platform,
    remoteName: undefined as string | undefined,
    workspaceTrusted: true,
  };
  const native = provider("native");
  const sandbox = provider("sandbox");
  const sandboxes = [sandbox];
  const createNativeProvider = vi.fn(() => native);
  const createSandboxProvider = vi.fn(() => {
    if (createSandboxProvider.mock.calls.length === 1) return sandbox;
    const generation = provider(`sandbox-${sandboxes.length + 1}`);
    sandboxes.push(generation);
    return generation;
  });
  const log = vi.fn();
  const audit = vi.fn();
  const router = new AgentTerminalProviderRouter({
    isEnabled: () => enabled,
    getHost: () => host,
    createNativeProvider,
    createSandboxProvider,
    getSandboxAvailability: async () =>
      sandboxAvailable
        ? {
            status: "verified" as const,
            attestation: {
              attestationId: "attestation-1",
              attestationVersion: "sandbox-behavior-v1",
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
                privateTmp: true,
                hostIpcBlocked: true,
                resourceLimits: "partial" as const,
                warnings: [],
              },
            },
          }
        : { status: "runtime-unavailable" as const },
    recordExecutionAudit: audit,
    log,
  });
  return {
    router,
    native,
    sandbox,
    sandboxes,
    createNativeProvider,
    createSandboxProvider,
    log,
    audit,
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

  it("uses and reuses the native provider when disabled", async () => {
    const test = harness();

    await expect(
      test.router.executeCommand({ command: "pwd", cwd: "/workspace" }),
    ).resolves.toMatchObject({ output: "native", terminal_id: "native-1" });
    test.router.listTerminals();

    expect(test.createNativeProvider).toHaveBeenCalledTimes(1);
    expect(test.createSandboxProvider).not.toHaveBeenCalled();
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
        test.router.executeCommand({ command: "pwd", cwd: "/workspace" }),
      ).resolves.toMatchObject({ output: "native" });
      expect(test.createSandboxProvider).not.toHaveBeenCalled();
    },
  );

  it("prepares sandbox authority without executing and consumes it once", async () => {
    const test = harness();
    test.setEnabled(true);

    const prepared = await test.router.prepareExecution({
      command: "pwd",
      cwd: "/workspace",
    });

    expect(test.sandbox.executeCommand).not.toHaveBeenCalled();
    expect(prepared.security).toMatchObject({
      route: "sandbox",
      confinement: "verified-baseline",
      approvalPolicy: "sandbox-baseline-v1",
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
      test.router.executeCommand({ command: "pwd", cwd: "/workspace" }),
    ).resolves.toMatchObject({ output: "sandbox" });
    test.router.getBackgroundState("sandbox-1");
    test.router.closeTerminals();

    expect(test.createSandboxProvider).toHaveBeenCalledTimes(1);
    expect(test.createNativeProvider).not.toHaveBeenCalled();
  });

  it("uses the native provider when the sandbox runtime is unavailable", async () => {
    const test = harness();
    test.setEnabled(true);
    test.setSandboxAvailable(false);

    await expect(
      test.router.executeCommand({ command: "pwd", cwd: "/workspace" }),
    ).resolves.toMatchObject({ output: "native", terminal_id: "native-1" });
    expect(test.createNativeProvider).toHaveBeenCalledTimes(1);
    expect(test.createSandboxProvider).not.toHaveBeenCalled();
  });

  it("fails closed when runtime availability is lost after sandbox selection", async () => {
    const test = harness();
    test.setEnabled(true);
    await test.router.executeCommand({ command: "pwd", cwd: "/workspace" });

    test.setSandboxAvailable(false);
    await expect(
      test.router.executeCommand({
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
      test.router.executeCommand({ command: "pwd", cwd: "/workspace" }),
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
      test.router.executeCommand({ command: "pwd", cwd: "/workspace" }),
    ).rejects.toThrow("failed closed: helper missing");
    await expect(
      test.router.executeCommand({ command: "echo again", cwd: "/workspace" }),
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
    await test.router.executeCommand({ command: "pwd", cwd: "/workspace" });

    test.setEnabled(false);
    test.router.listTerminals();

    expect(test.sandbox.listTerminals).toHaveBeenCalledTimes(1);
    expect(test.sandbox.dispose).not.toHaveBeenCalled();
    expect(test.createNativeProvider).not.toHaveBeenCalled();
  });

  it("keeps existing sandbox channels while routing new work native after disable", async () => {
    const test = harness();
    test.setEnabled(true);
    await test.router.executeCommand({ command: "pwd", cwd: "/workspace" });

    test.setEnabled(false);
    await expect(
      test.router.executeCommand({ command: "echo native", cwd: "/workspace" }),
    ).resolves.toMatchObject({ output: "native" });

    expect(test.sandbox.dispose).not.toHaveBeenCalled();
    expect(test.createNativeProvider).toHaveBeenCalledTimes(1);
  });

  it("retains a logger assigned before lazy provider creation", async () => {
    const test = harness();
    const assignedLog = vi.fn();
    test.router.log = assignedLog;
    test.setEnabled(true);

    await test.router.executeCommand({ command: "pwd", cwd: "/workspace" });

    expect(test.router.log).toBe(assignedLog);
    expect(test.sandbox.log).toBe(assignedLog);
  });

  it("disposes an empty retired sandbox and creates a new generation", async () => {
    const test = harness();
    test.setEnabled(true);
    await test.router.executeCommand({ command: "pwd", cwd: "/workspace" });

    test.router.refresh();
    expect(test.sandbox.dispose).toHaveBeenCalledTimes(1);
    await test.router.executeCommand({ command: "pwd", cwd: "/workspace" });
    expect(test.createSandboxProvider).toHaveBeenCalledTimes(2);
    test.router.dispose();
    expect(test.sandbox.dispose).toHaveBeenCalledTimes(1);
    expect(test.sandboxes[1]?.dispose).toHaveBeenCalledTimes(1);
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
    vi.mocked(test.sandbox.getRecentlyClosedTerminals).mockReturnValue([
      { id: "sandbox-1", name: "Agent command", closedAt: 500 },
    ]);
    test.setEnabled(true);
    await test.router.executeCommand({ command: "pwd", cwd: "/workspace" });

    test.router.refresh();
    expect(test.sandbox.dispose).not.toHaveBeenCalled();

    expect(test.router.closeTerminals(["sandbox-1"])).toEqual({ closed: 1 });
    expect(test.sandbox.dispose).toHaveBeenCalledTimes(1);
    expect(test.router.getRecentlyClosedTerminals()).toEqual([
      { id: "sandbox-1", name: "Agent command", closedAt: 500 },
    ]);
  });

  it("disposes the sandbox provider exactly once", async () => {
    const test = harness();
    test.setEnabled(true);
    await test.router.executeCommand({ command: "pwd", cwd: "/workspace" });

    test.router.dispose();
    test.router.dispose();
    expect(test.sandbox.dispose).toHaveBeenCalledTimes(1);
    expect(() => test.router.listTerminals()).toThrow("router is disposed");
  });
});
