import type {
  NativeAgentCommandRequest,
  NativeAgentPreparedCommand,
  NativeAgentRuntimeProvider,
} from "./NativeAgentRuntimeProvider.js";
import type {
  SandboxCommandDisposable,
  SandboxCommandEvent,
  SandboxCommandExit,
  SandboxCommandProcess,
  SandboxCommandReady,
} from "../sandbox/SandboxRuntimeProvider.js";
import type {
  TerminalExecutionOwner,
  TerminalExecutionSecuritySummary,
} from "../../core/capabilities/terminal.js";
import { describe, expect, it, vi } from "vitest";

import type { MaterializedHostShellBootstrap } from "../hostShellBootstrap.js";
import { NativeAgentTerminalCoordinator } from "./NativeAgentTerminalCoordinator.js";
import type { NodePtyModuleLoader } from "../deferredNodePtyLoader.js";

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

const security: TerminalExecutionSecuritySummary = {
  auditId: "audit-native",
  route: "native",
  executionSurface: "agentlink-native",
  confinement: "native-unsandboxed",
  routeReason: "verified-local-macos",
  requiredAuthority: "native-agent",
  permissionIntent: "default",
  approvalRequirement: "policy",
  authorityReason: "approval-policy",
  approvalPolicySnapshot: "on-request" as const,
  approvalReviewerSnapshot: "user" as const,
  executionPresetSnapshot: "native-manual" as const,
  commandApprovalPolicySnapshot: "manual",
  executionPolicy: "native-legacy-v1",
  preparedAt: 100,
};

function bootstrap(cwd: string): MaterializedHostShellBootstrap {
  return {
    mode: "integrated",
    shell: "zsh",
    nonce: "native_shell_nonce_1234",
    artifactDirectory: "/runtime/native",
    files: [],
    profile: {
      profileName: "zsh",
      provenance: "configured",
      shellPath: "/bin/zsh",
      shellArgs: ["-l", "-i"],
      cwd,
      environment: { PATH: "/usr/bin:/bin", ZDOTDIR: "/runtime/native" },
    },
    cleanup: vi.fn(async () => undefined),
  };
}

function harness() {
  const processes: FakeProcess[] = [];
  const commands: NativeAgentCommandRequest[] = [];
  const channelRequests: Parameters<
    NativeAgentRuntimeProvider["prepareChannel"]
  >[0][] = [];
  const starts: Array<ReturnType<typeof vi.fn>> = [];
  const liveChannels = new Set<string>();
  const runtime: NativeAgentRuntimeProvider = {
    hasChannel: vi.fn((channelId) => liveChannels.has(channelId)),
    prepareChannel: vi.fn(async (request) => {
      channelRequests.push(request);
      liveChannels.add(request.channelId);
    }),
    createCommand: vi.fn((request): NativeAgentPreparedCommand => {
      commands.push(request);
      const process = new FakeProcess({
        channelId: request.channelId,
        commandId: request.commandId,
        generation: request.generation,
      });
      const start = vi.fn();
      starts.push(start);
      processes.push(process);
      return { process, start };
    }),
    write: vi.fn((channelId) => liveChannels.has(channelId)),
    resize: vi.fn((channelId) => liveChannels.has(channelId)),
    interrupt: vi.fn((channelId) => liveChannels.has(channelId)),
    closeChannel: vi.fn((channelId) => liveChannels.delete(channelId)),
    dispose: vi.fn(),
  };
  const loader: NodePtyModuleLoader = { load: vi.fn() };
  const prepareShell = vi.fn(async ({ cwd }: { cwd: string }) =>
    bootstrap(cwd),
  );
  let channel = 1;
  let command = 1;
  const coordinator = new NativeAgentTerminalCoordinator({
    nodePtyLoader: loader,
    initialCwd: "/workspace",
    prepareShell,
    createChannelId: () => `native-agent-${channel++}`,
    createCommandId: () => `native-command-${command++}`,
    createRuntime: () => runtime,
    now: () => 100,
  });
  return {
    channelRequests,
    commands,
    coordinator,
    liveChannels,
    loader,
    prepareShell,
    processes,
    runtime,
    starts,
  };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function finish(process: FakeProcess, output = "ok\r\n", exitCode = 0) {
  process.readyDeferred.resolve({ pid: 1, pgid: 1, backend: "native-pty" });
  await flush();
  process.emit({ type: "data", data: output });
  process.completionDeferred.resolve({ exitCode, timedOut: false });
  await flush();
}

describe("NativeAgentTerminalCoordinator", () => {
  it("reserves before approval and starts one interactive shell only when consumed", async () => {
    const test = harness();
    const assigned = vi.fn();
    const prepared = await test.coordinator.prepareNativeExecution(
      {
        owner: undefined,
        command: "printf native",
        cwd: "/workspace",
        env: { EXACT: "value" },
        onTerminalAssigned: assigned,
      },
      security,
    );

    expect(test.prepareShell).not.toHaveBeenCalled();
    expect(test.runtime.prepareChannel).not.toHaveBeenCalled();
    expect(test.coordinator.listTerminals({ owner: undefined })).toEqual([
      { id: "native-agent-1", name: "AgentLink", busy: false },
    ]);

    const completion = prepared.execute();
    await flush();
    expect(test.prepareShell).toHaveBeenCalledWith({
      channelId: "native-agent-1",
      cwd: "/workspace",
      env: expect.objectContaining({
        AGENTLINK: "1",
        GIT_TERMINAL_PROMPT: "0",
        EXACT: "value",
      }),
    });
    expect(test.runtime.prepareChannel).toHaveBeenCalledOnce();
    expect(test.commands[0]).toEqual({
      channelId: "native-agent-1",
      commandId: "native-command-1",
      generation: 1,
      command: "printf native",
    });
    expect(test.starts[0]).toHaveBeenCalledOnce();
    expect(assigned).toHaveBeenCalledWith("native-agent-1");

    await finish(test.processes[0], "native\r\n", 0);
    await expect(completion).resolves.toMatchObject({
      exit_code: 0,
      output: "native",
      terminal_id: "native-agent-1",
      execution_mode: "native_pty",
      security,
    });
  });

  it("cancels startup when the channel closes during shell preparation", async () => {
    const test = harness();
    const preparation = deferred<MaterializedHostShellBootstrap>();
    const preparedBootstrap = bootstrap("/workspace");
    test.prepareShell.mockImplementationOnce(() => preparation.promise);

    const result = test.coordinator.executeCommand({
      owner: undefined,
      command: "printf closed",
      cwd: "/workspace",
    });
    await flush();
    expect(test.coordinator.closeTerminals({ owner: undefined })).toEqual({
      closed: 1,
    });
    preparation.resolve(preparedBootstrap);

    await expect(result).rejects.toThrow(
      "Native Agent terminal target changed during startup",
    );
    expect(preparedBootstrap.mode).toBe("integrated");
    if (preparedBootstrap.mode === "integrated") {
      expect(preparedBootstrap.cleanup).toHaveBeenCalledOnce();
    }
    expect(test.runtime.prepareChannel).not.toHaveBeenCalled();
    expect(test.runtime.createCommand).not.toHaveBeenCalled();
    expect(test.liveChannels).toEqual(new Set());
  });

  it("closes a runtime channel created after its terminal closes during preparation", async () => {
    const test = harness();
    const channelPreparation = deferred<void>();
    vi.mocked(test.runtime.prepareChannel).mockImplementationOnce(
      async (request) => {
        test.channelRequests.push(request);
        test.liveChannels.add(request.channelId);
        await channelPreparation.promise;
      },
    );

    const result = test.coordinator.executeCommand({
      owner: undefined,
      command: "printf closed",
      cwd: "/workspace",
    });
    await flush();
    expect(test.liveChannels).toEqual(new Set(["native-agent-1"]));
    expect(test.coordinator.closeTerminals({ owner: undefined })).toEqual({
      closed: 1,
    });
    channelPreparation.resolve();

    await expect(result).rejects.toThrow(
      "Native Agent terminal target changed during startup",
    );
    expect(test.runtime.closeChannel).toHaveBeenCalledWith("native-agent-1");
    expect(test.runtime.createCommand).not.toHaveBeenCalled();
    expect(test.liveChannels).toEqual(new Set());
  });

  it("reserves separate terminals for parallel prepared executions", async () => {
    const test = harness();
    const firstPrepared = await test.coordinator.prepareNativeExecution(
      { owner: undefined, command: "printf first", cwd: "/workspace" },
      security,
    );
    const secondPrepared = await test.coordinator.prepareNativeExecution(
      { owner: undefined, command: "printf second", cwd: "/workspace" },
      security,
    );

    expect(test.coordinator.listTerminals({ owner: undefined })).toEqual([
      { id: "native-agent-1", name: "AgentLink", busy: false },
      { id: "native-agent-2", name: "AgentLink", busy: false },
    ]);

    const first = firstPrepared.execute();
    const second = secondPrepared.execute();
    await flush();
    expect(test.processes.map((process) => process.identity.channelId)).toEqual(
      ["native-agent-1", "native-agent-2"],
    );

    await finish(test.processes[0], "first\r\n");
    await finish(test.processes[1], "second\r\n");
    await expect(first).resolves.toMatchObject({
      terminal_id: "native-agent-1",
      output: "first",
    });
    await expect(second).resolves.toMatchObject({
      terminal_id: "native-agent-2",
      output: "second",
    });
  });

  it("reserves separate terminals for parallel direct executions", async () => {
    const test = harness();
    const first = test.coordinator.executeCommand({
      owner: undefined,
      command: "printf first",
      cwd: "/workspace",
    });
    const second = test.coordinator.executeCommand({
      owner: undefined,
      command: "printf second",
      cwd: "/workspace",
    });
    await flush();

    expect(test.processes.map((process) => process.identity.channelId)).toEqual(
      ["native-agent-1", "native-agent-2"],
    );
    await finish(test.processes[0], "first\r\n");
    await finish(test.processes[1], "second\r\n");
    await expect(first).resolves.toMatchObject({
      terminal_id: "native-agent-1",
    });
    await expect(second).resolves.toMatchObject({
      terminal_id: "native-agent-2",
    });
  });

  it("bounds implicit channels and reclaims the oldest idle channel", async () => {
    const test = harness();
    const running = Array.from({ length: 4 }, (_, index) =>
      test.coordinator.executeCommand({
        owner: undefined,
        command: `printf ${index}`,
        cwd: `/workspace/${index}`,
        background: true,
      }),
    );
    await flush();
    await Promise.all(running);

    await expect(
      test.coordinator.executeCommand({
        owner: undefined,
        command: "printf exhausted",
        cwd: "/workspace/exhausted",
      }),
    ).rejects.toThrow("Native Agent terminal pool exhausted");
    expect(test.coordinator.listTerminals({ owner: undefined })).toHaveLength(
      4,
    );

    await finish(test.processes[0], "zero\r\n");
    const replacement = test.coordinator.executeCommand({
      owner: undefined,
      command: "printf replacement",
      cwd: "/workspace/replacement",
      background: true,
    });
    await flush();
    await expect(replacement).resolves.toMatchObject({
      terminal_id: "native-agent-5",
    });
    expect(test.runtime.closeChannel).toHaveBeenCalledWith("native-agent-1");
    expect(test.coordinator.listTerminals({ owner: undefined })).toHaveLength(
      4,
    );
  });

  it("preserves an explicit terminal name instead of the AgentLink default", async () => {
    const test = harness();
    const pending = test.coordinator.executeCommand({
      owner: undefined,
      command: "printf named",
      cwd: "/workspace",
      terminal_name: "Server",
    });
    await flush();

    expect(test.coordinator.listTerminals({ owner: undefined })).toEqual([
      { id: "native-agent-1", name: "Server", busy: true },
    ]);
    await finish(test.processes[0], "named\r\n", 0);
    await expect(pending).resolves.toMatchObject({ terminal_name: "Server" });
  });

  it("reuses one persistent shell for compatible commands", async () => {
    const test = harness();
    const first = test.coordinator.executeCommand({
      owner: undefined,
      command: "typeset -g NATIVE_STATE=ready",
      cwd: "/workspace",
    });
    await flush();
    await finish(test.processes[0], "", 0);
    await first;

    const second = test.coordinator.executeCommand({
      owner: undefined,
      command: "printf $NATIVE_STATE",
      cwd: "/workspace",
    });
    await flush();
    await finish(test.processes[1], "ready\r\n", 0);
    await expect(second).resolves.toMatchObject({
      terminal_id: "native-agent-1",
      output: "ready",
    });

    expect(test.prepareShell).toHaveBeenCalledOnce();
    expect(test.runtime.prepareChannel).toHaveBeenCalledOnce();
    expect(test.runtime.createCommand).toHaveBeenCalledTimes(2);
  });

  it("creates another shell for incompatible implicit cwd or environment", async () => {
    const test = harness();
    const first = test.coordinator.executeCommand({
      owner: undefined,
      command: "pwd",
      cwd: "/workspace",
      env: { A: "one" },
    });
    await flush();
    await finish(test.processes[0], "/workspace\r\n");
    await first;

    const second = test.coordinator.executeCommand({
      owner: undefined,
      command: "pwd",
      cwd: "/other",
      env: { A: "two" },
    });
    await flush();
    await finish(test.processes[1], "/other\r\n");
    await expect(second).resolves.toMatchObject({
      terminal_id: "native-agent-2",
    });
    expect(test.prepareShell).toHaveBeenCalledTimes(2);
  });

  it("reuses within an owner generation, refreshes attribution, and rejects the next generation", async () => {
    const test = harness();
    const rootOwner: TerminalExecutionOwner = {
      scopeId: "tab-1",
      displayLabel: "T1",
      generation: 1,
      authoritySessionId: "root-session",
    };
    const childOwner = { ...rootOwner, authoritySessionId: "child-session" };
    const nextGeneration = {
      ...rootOwner,
      generation: 2,
      authoritySessionId: "replacement-session",
    };

    const first = test.coordinator.executeCommand({
      owner: rootOwner,
      command: "pwd",
      cwd: "/workspace",
    });
    await flush();
    await finish(test.processes[0], "/workspace\r\n");
    const firstResult = await first;

    const second = test.coordinator.executeCommand({
      owner: childOwner,
      command: "pwd",
      cwd: "/workspace",
    });
    await flush();
    await finish(test.processes[1], "/workspace\r\n");
    const secondResult = await second;

    expect(secondResult.terminal_id).toBe(firstResult.terminal_id);
    expect(test.coordinator.listTerminals({ owner: childOwner })).toEqual([
      expect.objectContaining({
        id: firstResult.terminal_id,
        owner: childOwner,
      }),
    ]);
    expect(test.coordinator.listTerminals({ owner: nextGeneration })).toEqual(
      [],
    );
    expect(
      test.coordinator.getBackgroundState({
        owner: nextGeneration,
        terminalId: firstResult.terminal_id,
      }),
    ).toBeUndefined();
    expect(
      test.coordinator.interruptTerminal({
        owner: nextGeneration,
        terminalId: firstResult.terminal_id,
      }),
    ).toBe(false);
    await expect(
      test.coordinator.executeCommand({
        owner: nextGeneration,
        command: "pwd",
        cwd: "/workspace",
        terminal_id: firstResult.terminal_id,
      }),
    ).rejects.toThrow("terminal not found");
  });

  it("supports background output, interrupt, and deferred cleanup", async () => {
    const test = harness();
    const deferredFinalization = vi.fn();
    const finalized = vi.fn();
    const resultPromise = test.coordinator.executeCommand({
      owner: undefined,
      command: "sleep 10",
      cwd: "/workspace",
      background: true,
      onCommandFinalizationDeferred: deferredFinalization,
      onCommandFinalized: finalized,
    });
    await flush();
    const result = await resultPromise;

    expect(result).toMatchObject({
      exit_code: null,
      backgrounded: true,
      is_running: true,
      execution_mode: "native_pty",
    });
    expect(deferredFinalization).toHaveBeenCalledOnce();
    expect(
      test.coordinator.interruptTerminal({
        owner: undefined,
        terminalId: result.terminal_id,
      }),
    ).toBe(true);
    expect(test.runtime.interrupt).toHaveBeenCalledWith(result.terminal_id);

    test.processes[0].readyDeferred.resolve({
      pid: 2,
      pgid: 2,
      backend: "native-pty",
    });
    await flush();
    test.processes[0].emit({ type: "data", data: "partial\r\n" });
    test.processes[0].completionDeferred.resolve({
      exitCode: 130,
      timedOut: false,
    });
    await flush();

    expect(finalized).toHaveBeenCalledOnce();
    expect(
      test.coordinator.getBackgroundState({
        owner: undefined,
        terminalId: result.terminal_id,
      }),
    ).toMatchObject({
      is_running: false,
      state: "completed",
      exit_code: 130,
      output: "partial",
    });
  });

  it("returns timed-out commands as running and finalizes when they exit", async () => {
    vi.useFakeTimers();
    try {
      const test = harness();
      const finalized = vi.fn();
      const resultPromise = test.coordinator.executeCommand({
        owner: undefined,
        command: "sleep 10",
        cwd: "/workspace",
        timeout: 25,
        onCommandFinalized: finalized,
      });
      await flush();
      test.processes[0].readyDeferred.resolve({
        pid: 3,
        pgid: 3,
        backend: "native-pty",
      });
      await vi.advanceTimersByTimeAsync(25);
      await expect(resultPromise).resolves.toMatchObject({
        timed_out: true,
        is_running: true,
        execution_mode: "native_pty",
      });
      expect(finalized).not.toHaveBeenCalled();

      test.processes[0].completionDeferred.resolve({
        exitCode: 0,
        timedOut: false,
      });
      await flush();
      expect(finalized).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes the logical channel when its persistent shell exits unexpectedly", async () => {
    const test = harness();
    const result = await test.coordinator.executeCommand({
      owner: undefined,
      command: "pwd",
      cwd: "/workspace",
      background: true,
    });
    expect(test.coordinator.listTerminals({ owner: undefined })).toHaveLength(
      1,
    );

    test.channelRequests[0].onClosed();

    expect(test.coordinator.listTerminals({ owner: undefined })).toEqual([]);
    expect(
      test.coordinator.getRecentlyClosedTerminals({ owner: undefined }),
    ).toEqual([
      expect.objectContaining({
        id: result.terminal_id,
        state: "unknown_termination",
      }),
    ]);
    expect(test.processes[0].dispose).toHaveBeenCalledOnce();
  });

  it("closes only Native Agent shells and records recent state", async () => {
    const test = harness();
    const result = await test.coordinator.executeCommand({
      owner: undefined,
      command: "watch",
      cwd: "/workspace",
      background: true,
    });

    expect(
      test.coordinator.closeTerminals({
        owner: undefined,
        names: ["host-terminal-1"],
      }),
    ).toEqual({
      closed: 0,
      not_found: ["host-terminal-1"],
    });
    expect(test.runtime.closeChannel).not.toHaveBeenCalled();
    expect(
      test.coordinator.closeTerminals({
        owner: undefined,
        names: [result.terminal_id],
      }),
    ).toEqual({
      closed: 1,
    });
    expect(test.runtime.closeChannel).toHaveBeenCalledWith(result.terminal_id);
    expect(
      test.coordinator.getRecentlyClosedTerminals({ owner: undefined }),
    ).toEqual([
      expect.objectContaining({
        id: result.terminal_id,
        state: "unknown_termination",
      }),
    ]);
  });

  it("invalidates a prepared execution when its terminal closes", async () => {
    const test = harness();
    const prepared = await test.coordinator.prepareNativeExecution(
      { owner: undefined, command: "pwd", cwd: "/workspace" },
      security,
    );

    expect(
      test.coordinator.closeTerminals({
        owner: undefined,
        names: ["native-agent-1"],
      }),
    ).toEqual({
      closed: 1,
    });
    await expect(prepared.execute()).rejects.toThrow("reservation is stale");
    expect(test.prepareShell).not.toHaveBeenCalled();
    expect(test.runtime.prepareChannel).not.toHaveBeenCalled();
    expect(test.runtime.createCommand).not.toHaveBeenCalled();
  });

  it("releases an unconsumed reservation without materializing a shell", async () => {
    const test = harness();
    const prepared = await test.coordinator.prepareNativeExecution(
      { owner: undefined, command: "pwd", cwd: "/workspace" },
      security,
    );
    prepared.dispose();

    expect(test.prepareShell).not.toHaveBeenCalled();
    expect(test.runtime.prepareChannel).not.toHaveBeenCalled();
  });
});
