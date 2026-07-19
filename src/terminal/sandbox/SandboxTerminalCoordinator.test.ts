import {
  CURRENT_SANDBOX_POLICY_VERSION,
  type SandboxExecutionMetadata,
} from "../../core/sandboxPolicy.js";
import { describe, expect, it, vi } from "vitest";

import type {
  SandboxCommandDisposable,
  SandboxCommandEvent,
  SandboxCommandExit,
  SandboxCommandProcess,
  SandboxCommandReady,
  SandboxRuntimeProvider,
} from "./SandboxRuntimeProvider.js";
import {
  SandboxTerminalCoordinator,
  type AuthorizedSandboxLaunch,
  type SandboxLaunchAuthorizer,
} from "./SandboxTerminalCoordinator.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class FakeProcess implements SandboxCommandProcess {
  readonly readyDeferred = deferred<SandboxCommandReady>();
  readonly completionDeferred = deferred<SandboxCommandExit>();
  readonly ready = this.readyDeferred.promise;
  readonly completion = this.completionDeferred.promise;
  readonly write = vi.fn(() => true);
  readonly resize = vi.fn(() => true);
  readonly interrupt = vi.fn(() => true);
  readonly terminate = vi.fn(() => true);
  readonly dispose = vi.fn();
  private readonly listeners = new Set<(event: SandboxCommandEvent) => void>();

  constructor(
    readonly identity: {
      channelId: string;
      commandId: string;
      generation: number;
    },
  ) {}

  onEvent(
    listener: (event: SandboxCommandEvent) => void,
  ): SandboxCommandDisposable {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  emit(event: SandboxCommandEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

const metadata: SandboxExecutionMetadata = {
  policyVersion: CURRENT_SANDBOX_POLICY_VERSION,
  profileId: "workspace-write",
  backend: "seatbelt",
  capabilities: {
    backend: "seatbelt",
    processTree: true,
    filesystemRead: "policy-denied",
    filesystemWrite: "strict",
    network: "blocked",
    privateHome: true,
    privateTmp: true,
    hostIpcBlocked: true,
    resourceLimits: "partial",
    warnings: [],
  },
};

function harness() {
  const processes: FakeProcess[] = [];
  const authorizedFinalizer = vi.fn();
  const runtime: SandboxRuntimeProvider = {
    launch: vi.fn((request) => {
      const process = new FakeProcess({
        channelId: request.channelId,
        commandId: request.commandId,
        generation: request.generation,
      });
      processes.push(process);
      return process;
    }),
    dispose: vi.fn(),
  };
  const authorizer: SandboxLaunchAuthorizer = {
    authorize: vi.fn(
      async ({
        options,
        channelId,
        commandId,
        generation,
        dimensions,
      }): Promise<AuthorizedSandboxLaunch> => ({
        authorization: {
          bindingDigest: "binding",
          policy: {
            version: CURRENT_SANDBOX_POLICY_VERSION,
            profileId: "workspace-write",
            readableRoots: ["/workspace"],
            writableRoots: ["/workspace"],
            deniedRoots: [],
            protectedReadOnlyRoots: [],
            network: { mode: "blocked" },
            environment: { inheritHost: false, values: {} },
            allowedUnixSockets: [],
          },
        },
        helperRequest: {
          version: 1,
          type: "launch",
          channelId,
          commandId,
          generation,
          command: options.command,
          cwd: options.cwd,
          shell: "/bin/zsh",
          environment: {},
          filesystem: {
            denyRead: [],
            allowRead: ["/workspace"],
            allowWrite: ["/workspace"],
            denyWrite: [],
          },
          network: { mode: "blocked" },
          protectedRoots: [],
          dimensions,
        },
        metadata,
        finalize: authorizedFinalizer,
      }),
    ),
  };
  let channel = 1;
  let command = 1;
  let now = 100;
  const coordinator = new SandboxTerminalCoordinator({
    runtime,
    authorizer,
    initialCwd: "/workspace",
    createChannelId: () => `sandbox-${channel++}`,
    createCommandId: () => `command-${command++}`,
    now: () => now,
    isAllowedCwd: (cwd) => cwd.startsWith("/workspace"),
  });
  return {
    authorizer,
    authorizedFinalizer,
    coordinator,
    processes,
    runtime,
    setNow(value: number) {
      now = value;
    },
  };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function finish(process: FakeProcess, output = "ok\r\n", exitCode = 0) {
  process.readyDeferred.resolve({ pid: 1, pgid: 1, backend: "seatbelt" });
  await flush();
  process.emit({ type: "data", data: output });
  process.completionDeferred.resolve({ exitCode, timedOut: false });
  await flush();
}

describe("SandboxTerminalCoordinator", () => {
  it("preauthorizes without launching and transfers cleanup on consume", async () => {
    const test = harness();
    const prepared = await test.coordinator.prepareConfinementExecution(
      {
        command: "pwd",
        cwd: "/workspace",
        sandboxSessionId: "session-1",
      },
      {
        auditId: "audit-1",
        route: "sandbox",
        confinement: "verified-baseline",
        routeReason: "verified-local-macos",
        approvalPolicy: "sandbox-baseline-v1",
        preparedAt: 100,
        sandbox: {
          attestationId: "attestation-1",
          attestationVersion: "v1",
          policyVersion: CURRENT_SANDBOX_POLICY_VERSION,
          profileId: "workspace-write",
          backend: "seatbelt",
          architecture: "arm64",
          capabilities: metadata.capabilities,
        },
      },
    );

    expect(test.authorizer.authorize).toHaveBeenCalledTimes(1);
    expect(test.runtime.launch).not.toHaveBeenCalled();
    expect(test.authorizedFinalizer).not.toHaveBeenCalled();

    const resultPromise = prepared.execute();
    expect(test.runtime.launch).toHaveBeenCalledTimes(1);
    await finish(test.processes[0] as FakeProcess);
    await expect(resultPromise).resolves.toMatchObject({
      security: { auditId: "audit-1", route: "sandbox" },
    });
    expect(test.authorizedFinalizer).toHaveBeenCalledTimes(1);
    await expect(prepared.execute()).rejects.toThrow("no longer available");
  });

  it("disposes rejected preauthorization without launching", async () => {
    const test = harness();
    const prepared = await test.coordinator.prepareConfinementExecution(
      {
        command: "pwd",
        cwd: "/workspace",
        sandboxSessionId: "session-1",
      },
      {
        auditId: "audit-1",
        route: "sandbox",
        confinement: "verified-baseline",
        routeReason: "verified-local-macos",
        approvalPolicy: "sandbox-baseline-v1",
        preparedAt: 100,
      },
    );

    prepared.dispose();
    prepared.dispose();

    expect(test.runtime.launch).not.toHaveBeenCalled();
    expect(test.authorizedFinalizer).toHaveBeenCalledTimes(1);
    await expect(prepared.execute()).rejects.toThrow("no longer available");
  });

  it("publishes disposal after synchronous channel closure", async () => {
    const test = harness();
    const order: string[] = [];
    test.coordinator.onChannelEvent(({ event }) => order.push(event.type));
    test.coordinator.onDispose(() => order.push("disposed"));
    await test.coordinator.executeCommand({
      command: "sleep 10",
      cwd: "/workspace",
      sandboxSessionId: "agent-session",
      background: true,
    });

    test.coordinator.dispose();

    expect(order).toEqual(["command-started", "closed", "disposed"]);
  });

  it("publishes identity-bound channel lifecycle snapshots", async () => {
    const test = harness();
    const updates: Array<{
      type: string;
      channelId: string;
      status: string;
      generation?: number;
    }> = [];
    const subscription = test.coordinator.onChannelEvent(
      ({ event, snapshot }) => {
        updates.push({
          type: event.type,
          channelId: snapshot.channelId,
          status: snapshot.status,
          ...(event.type === "data" ? { generation: event.generation } : {}),
        });
      },
    );

    const pending = test.coordinator.executeCommand({
      command: "printf hello",
      cwd: "/workspace",
      sandboxSessionId: "agent-session",
    });
    await flush();
    const process = test.processes[0];
    await finish(process, "hello");
    await pending;

    expect(updates).toEqual([
      { type: "command-started", channelId: "sandbox-1", status: "launching" },
      { type: "command-ready", channelId: "sandbox-1", status: "running" },
      {
        type: "data",
        channelId: "sandbox-1",
        status: "running",
        generation: 1,
      },
      { type: "command-exited", channelId: "sandbox-1", status: "idle" },
    ]);

    subscription.dispose();
    await test.coordinator.executeCommand({
      command: "true",
      cwd: "/workspace",
      terminal_id: "sandbox-1",
      sandboxSessionId: "agent-session",
      background: true,
    });
    expect(updates).toHaveLength(4);
  });
  it("executes in a fresh process and reuses idle channel history/cwd", async () => {
    const test = harness();
    const firstPromise = test.coordinator.executeCommand({
      command: "pwd",
      cwd: "/workspace",
      sandboxSessionId: "agent-session",
    });
    await flush();
    expect(test.processes).toHaveLength(1);
    await finish(test.processes[0], "/workspace\r\n");
    await expect(firstPromise).resolves.toMatchObject({
      exit_code: 0,
      output: "/workspace",
      terminal_id: "sandbox-1",
      terminal_name: "Agent command",
      execution_mode: "sandbox_pty",
      sandbox: metadata,
    });

    const secondPromise = test.coordinator.executeCommand({
      command: "echo next",
      cwd: "/workspace",
      sandboxSessionId: "agent-session",
    });
    await flush();
    expect(test.processes[1].identity).toEqual({
      channelId: "sandbox-1",
      commandId: "command-2",
      generation: 2,
    });
    await finish(test.processes[1], "next\r\n");
    await secondPromise;

    expect(test.coordinator.getChannelSnapshot("sandbox-1")).toMatchObject({
      title: "Agent command",
      status: "idle",
      commands: [
        { commandId: "command-1", command: "pwd" },
        { commandId: "command-2", command: "echo next" },
      ],
    });
  });

  it("supports named and split Sandbox channels without exposing foreign IDs", async () => {
    const test = harness();
    const named = test.coordinator.executeCommand({
      command: "sleep 1",
      cwd: "/workspace",
      terminal_name: "Server",
      background: true,
      sandboxSessionId: "agent-session",
    });
    await flush();
    await expect(named).resolves.toMatchObject({
      terminal_id: "sandbox-1",
      terminal_name: "Server",
      backgrounded: true,
    });

    const split = test.coordinator.executeCommand({
      command: "pwd",
      cwd: "/workspace",
      split_from: "sandbox-1",
      background: true,
      sandboxSessionId: "agent-session",
    });
    await flush();
    await expect(split).resolves.toMatchObject({
      terminal_id: "sandbox-2",
      terminal_name: "Agent command",
    });
    await expect(
      test.coordinator.executeCommand({
        command: "pwd",
        cwd: "/workspace",
        terminal_id: "host-terminal-1",
        sandboxSessionId: "agent-session",
      }),
    ).rejects.toThrow("Sandbox terminal not found");
  });

  it("keeps unnamed sandbox titles stable without exposing command text", async () => {
    const test = harness();
    const result = test.coordinator.executeCommand({
      command: "curl https://example.test?token=secret",
      cwd: "/workspace",
      background: true,
      sandboxSessionId: "agent-session",
    });
    await flush();

    await expect(result).resolves.toMatchObject({
      terminal_name: "Agent command",
    });
    expect(test.coordinator.listTerminals()).toContainEqual({
      id: "sandbox-1",
      name: "Agent command",
      busy: true,
    });
  });

  it("provides background output, UI input, resize, and Ctrl+C", async () => {
    const test = harness();
    const result = test.coordinator.executeCommand({
      command: "cat",
      cwd: "/workspace",
      background: true,
      sandboxSessionId: "agent-session",
    });
    await flush();
    await result;
    const process = test.processes[0];
    process.readyDeferred.resolve({ pid: 1, pgid: 1, backend: "seatbelt" });
    await flush();
    process.emit({ type: "data", data: "waiting\r\n" });

    expect(test.coordinator.write("sandbox-1", "hello\r")).toBe(true);
    expect(
      test.coordinator.resize("sandbox-1", { columns: 120, rows: 40 }),
    ).toBe(true);
    expect(test.coordinator.interruptTerminal("sandbox-1")).toBe(true);
    expect(process.write).toHaveBeenCalledWith("hello\r");
    expect(process.interrupt).toHaveBeenCalledTimes(1);
    expect(test.coordinator.getBackgroundState("sandbox-1")).toMatchObject({
      is_running: true,
      state: "running",
      output: "waiting",
      output_captured: true,
    });

    process.completionDeferred.resolve({
      exitCode: 130,
      signal: 2,
      timedOut: false,
    });
    await flush();
    expect(test.coordinator.getBackgroundState("sandbox-1")).toMatchObject({
      is_running: false,
      state: "completed",
      exit_code: 130,
    });
  });

  it("detaches on timeout and finalizes inline files exactly once", async () => {
    vi.useFakeTimers();
    try {
      const test = harness();
      const deferred = vi.fn();
      const finalized = vi.fn();
      const resultPromise = test.coordinator.executeCommand({
        command: "sleep 10",
        cwd: "/workspace",
        timeout: 100,
        sandboxSessionId: "agent-session",
        onCommandFinalizationDeferred: deferred,
        onCommandFinalized: finalized,
      });
      await flush();
      await vi.advanceTimersByTimeAsync(100);
      await expect(resultPromise).resolves.toMatchObject({
        timed_out: true,
        backgrounded: true,
        is_running: true,
      });
      expect(deferred).toHaveBeenCalledTimes(1);
      expect(finalized).not.toHaveBeenCalled();

      const process = test.processes[0];
      process.readyDeferred.resolve({ pid: 1, pgid: 1, backend: "seatbelt" });
      process.completionDeferred.resolve({ exitCode: 0, timedOut: false });
      await flush();
      expect(finalized).toHaveBeenCalledTimes(1);
      test.coordinator.closeTerminals();
      expect(finalized).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes only Sandbox channels and records recovery metadata", async () => {
    const test = harness();
    await test.coordinator.executeCommand({
      command: "sleep 10",
      cwd: "/workspace",
      terminal_name: "Server",
      background: true,
      sandboxSessionId: "agent-session",
    });
    await test.coordinator.executeCommand({
      command: "sleep 10",
      cwd: "/workspace",
      terminal_name: "Tests",
      background: true,
      sandboxSessionId: "agent-session",
    });
    test.setNow(500);

    expect(test.coordinator.closeTerminals(["Server", "Missing"])).toEqual({
      closed: 1,
      not_found: ["Missing"],
    });
    expect(test.processes[0].dispose).toHaveBeenCalledTimes(1);
    expect(test.coordinator.listTerminals()).toEqual([
      { id: "sandbox-2", name: "Tests", busy: true },
    ]);
    expect(test.coordinator.getRecentlyClosedTerminals()).toEqual([
      {
        id: "sandbox-1",
        name: "Server",
        closedAt: 500,
        is_running: false,
        state: "unknown_termination",
        exit_code: null,
        output: "",
        output_captured: true,
        terminal_raw_output: "",
      },
    ]);
  });

  it("fails before launch for missing sessions or mismatched authorization identity", async () => {
    const test = harness();
    await expect(
      test.coordinator.executeCommand({ command: "pwd", cwd: "/workspace" }),
    ).rejects.toThrow("owning AgentLink session ID");
    const authorize = vi
      .mocked(test.authorizer.authorize)
      .getMockImplementation()!;
    vi.mocked(test.authorizer.authorize).mockImplementationOnce(
      async (input) => {
        const authorized = await authorize(input);
        return {
          ...authorized,
          helperRequest: { ...authorized.helperRequest, commandId: "wrong" },
        };
      },
    );
    await expect(
      test.coordinator.executeCommand({
        command: "pwd",
        cwd: "/workspace",
        sandboxSessionId: "agent-session",
      }),
    ).rejects.toThrow("mismatched command identity");
    expect(test.runtime.launch).not.toHaveBeenCalled();
    expect(test.authorizedFinalizer).toHaveBeenCalledTimes(1);
  });

  it("finalizes authorization when runtime launch fails synchronously", async () => {
    const test = harness();
    vi.mocked(test.runtime.launch).mockImplementationOnce(() => {
      throw new Error("helper unavailable");
    });

    await expect(
      test.coordinator.executeCommand({
        command: "pwd",
        cwd: "/workspace",
        sandboxSessionId: "agent-session",
      }),
    ).rejects.toThrow("helper unavailable");
    expect(test.authorizedFinalizer).toHaveBeenCalledTimes(1);
  });

  it("disposes runtime and active commands exactly once", async () => {
    const test = harness();
    await test.coordinator.executeCommand({
      command: "sleep 10",
      cwd: "/workspace",
      background: true,
      sandboxSessionId: "agent-session",
    });
    test.coordinator.dispose();
    test.coordinator.dispose();
    expect(test.processes[0].dispose).toHaveBeenCalledTimes(1);
    expect(test.runtime.dispose).toHaveBeenCalledTimes(1);
    await expect(
      test.coordinator.executeCommand({
        command: "pwd",
        cwd: "/workspace",
        sandboxSessionId: "agent-session",
      }),
    ).rejects.toThrow("coordinator is disposed");
  });
});
