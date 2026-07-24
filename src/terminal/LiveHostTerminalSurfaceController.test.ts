import type {
  HostShellBootstrapPlan,
  MaterializedHostShellBootstrap,
} from "./hostShellBootstrap.js";
import {
  LiveHostTerminalSurfaceController,
  decideTerminalPaste,
} from "./LiveHostTerminalSurfaceController.js";
import type { NodePtyModule, NodePtyProcess } from "./nodePtyFactory.js";
import type {
  SandboxTerminalChannelEvent,
  SandboxTerminalCoordinator,
} from "./sandbox/SandboxTerminalCoordinator.js";
import { describe, expect, it, vi } from "vitest";

import { SandboxTerminalChannelHub } from "./sandbox/SandboxTerminalChannelHub.js";
import type { SandboxTerminalSessionSnapshot } from "./sandbox/SandboxTerminalSession.js";
import { TERMINAL_SURFACE_PROTOCOL_VERSION } from "./terminalSurfaceProtocol.js";
import type { TerminalSurfaceEvent } from "./terminalSurfaceProtocol.js";
import type { VscodeTerminalConfigurationSnapshot } from "./vscodeTerminalProfileAdapter.js";
import { encodeShellIntegrationValue } from "./shellIntegration.js";

class FakeNodePtyProcess implements NodePtyProcess {
  readonly writes: string[] = [];
  readonly resizes: Array<[number, number]> = [];
  pauseCount = 0;
  resumeCount = 0;
  killCount = 0;
  private dataListener: ((data: string) => void) | undefined;
  private exitListener:
    | ((event: { exitCode: number; signal?: number }) => void)
    | undefined;

  onData(listener: (data: string) => void) {
    this.dataListener = listener;
    return { dispose: () => (this.dataListener = undefined) };
  }

  onExit(listener: (event: { exitCode: number; signal?: number }) => void) {
    this.exitListener = listener;
    return { dispose: () => (this.exitListener = undefined) };
  }

  write(data: string): void {
    this.writes.push(data);
  }

  resize(columns: number, rows: number): void {
    this.resizes.push([columns, rows]);
  }

  kill(): void {
    this.killCount += 1;
  }

  pause(): void {
    this.pauseCount += 1;
  }

  resume(): void {
    this.resumeCount += 1;
  }

  emitData(data: string): void {
    this.dataListener?.(data);
  }

  emitExit(exitCode: number): void {
    this.exitListener?.({ exitCode });
  }
}

function snapshot(
  shellPath = "/bin/sh",
  shellArgs: string[] = [],
): VscodeTerminalConfigurationSnapshot {
  return {
    isWorkspaceTrusted: true,
    platform: "darwin",
    defaultProfile: { globalValue: "Selected" },
    profiles: {
      globalValue: { Selected: { path: shellPath, args: shellArgs } },
    },
    environment: {},
    baseEnvironment: { HOME: "/Users/test", PATH: "/usr/bin:/bin" },
    fallbackShellPath: "/bin/zsh",
    workspaceDirectories: ["/workspace"],
    homeDirectory: "/Users/test",
  };
}

function harness(
  configuration = snapshot(),
  options: {
    runtimeWatermarks?: { high: number; low: number };
    multiLinePasteWarning?: "auto" | "always" | "never";
    ensureRuntimeRoot?: () => Promise<void>;
    materializeBootstrap?: (
      plan: HostShellBootstrapPlan,
    ) => Promise<MaterializedHostShellBootstrap>;
    onLoad?: () => void;
    spawnError?: Error;
    clipboardText?: string;
    clipboardError?: Error;
    clipboardWriteError?: Error;
    readClipboard?: () => Promise<string>;
    sandboxChannelHub?: SandboxTerminalChannelHub;
    requestTerminalViewReveal?: () => void;
    log?: (message: string) => void;
    postSurfaceEvent?: (
      event: TerminalSurfaceEvent,
    ) => PromiseLike<boolean> | boolean;
  } = {},
) {
  let nextId = 1;
  let accepting = true;
  const events: TerminalSurfaceEvent[] = [];
  const processes: FakeNodePtyProcess[] = [];
  const spawn = vi.fn(() => {
    if (options.spawnError) throw options.spawnError;
    const process = new FakeNodePtyProcess();
    processes.push(process);
    return process;
  });
  const nodePty: NodePtyModule = { spawn };
  const load = vi.fn(() => {
    options.onLoad?.();
    return nodePty;
  });
  const getConfigurationSnapshot = vi.fn(() => configuration);
  const openExternal = vi.fn();
  const openNativeTerminal = vi.fn();
  const readClipboard = vi.fn(
    options.readClipboard ??
      (async () => {
        if (options.clipboardError) throw options.clipboardError;
        return options.clipboardText ?? "";
      }),
  );
  const writeClipboard = vi.fn(async () => {
    if (options.clipboardWriteError) throw options.clipboardWriteError;
  });
  const requestTerminalViewReveal = options.requestTerminalViewReveal
    ? vi.fn(options.requestTerminalViewReveal)
    : vi.fn();
  const controller = new LiveHostTerminalSurfaceController({
    host: { platform: "darwin" },
    runtimeRoot: "/runtime/host-terminal",
    nodePtyLoader: { load },
    getConfigurationSnapshot,
    getSurfaceConfiguration: () => ({
      scrollback: 2000,
      multiLinePasteWarning: options.multiLinePasteWarning ?? "auto",
    }),
    isAcceptingRequests: () => accepting,
    createId: () => `identifier_${nextId++}_1234567890`,
    openExternal,
    openNativeTerminal,
    readClipboard,
    writeClipboard,
    sandboxChannelHub: options.sandboxChannelHub,
    requestTerminalViewReveal,
    log: options.log,
    runtimeWatermarks: options.runtimeWatermarks,
    ensureRuntimeRoot: options.ensureRuntimeRoot,
    materializeBootstrap: options.materializeBootstrap,
  });
  const connection = controller.attach(async (event) => {
    events.push(event);
    return (await options.postSurfaceEvent?.(event)) ?? true;
  });
  return {
    controller,
    connection,
    events,
    processes,
    spawn,
    load,
    getConfigurationSnapshot,
    openExternal,
    openNativeTerminal,
    readClipboard,
    writeClipboard,
    requestTerminalViewReveal,
    setAccepting(value: boolean) {
      accepting = value;
    },
  };
}

async function ready(test: ReturnType<typeof harness>): Promise<void> {
  await test.controller.handleRequest(test.connection, {
    type: "terminal-view/ready",
    protocolVersion: TERMINAL_SURFACE_PROTOCOL_VERSION,
  });
}

async function create(test: ReturnType<typeof harness>): Promise<{
  terminalId: string;
  terminalInstanceId: string;
}> {
  await test.controller.handleRequest(test.connection, {
    type: "host-terminal/create",
    requestId: "request-1",
  });
  const opened = test.events.find(
    (event) => event.type === "host-terminal/opened",
  );
  if (!opened || opened.type !== "host-terminal/opened") {
    throw new Error("expected opened event");
  }
  return {
    terminalId: opened.terminal.id,
    terminalInstanceId: opened.terminalInstanceId,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function materializer(cleanup: () => Promise<void>) {
  return async (
    plan: HostShellBootstrapPlan,
  ): Promise<MaterializedHostShellBootstrap> => {
    if (plan.mode !== "integrated") return plan;
    return { ...plan, cleanup };
  };
}

function shellMarker(
  kind: string,
  payload?: string,
  nonce = "identifier_5_1234567890",
): string {
  return `\x1b]697;AgentLink;${nonce};${kind}${payload === undefined ? "" : `;${payload}`}\x07`;
}

function confirmation(test: ReturnType<typeof harness>) {
  for (let index = test.events.length - 1; index >= 0; index -= 1) {
    const event = test.events[index];
    if (event?.type === "terminal-view/confirmation") return event;
  }
  throw new Error("expected confirmation event");
}

function sandboxSnapshot(
  status: SandboxTerminalSessionSnapshot["status"] = "idle",
): SandboxTerminalSessionSnapshot {
  return {
    channelId: "sandbox-1",
    title: "Sandbox",
    cwd: "/workspace",
    dimensions: { columns: 80, rows: 24 },
    status,
    nextGeneration: 2,
    replay: "",
    replayBytes: 0,
    droppedReplayBytes: 0,
    commands: [],
  };
}

function sandboxHubHarness() {
  let listener: ((event: SandboxTerminalChannelEvent) => void) | undefined;
  const coordinator = {
    listTerminals: vi.fn(() => [
      { id: "sandbox-1", name: "Sandbox", busy: false },
    ]),
    getChannelSnapshot: vi.fn(() => sandboxSnapshot()),
    onChannelEvent: vi.fn((next) => {
      listener = next;
      return { dispose: vi.fn() };
    }),
    onDispose: vi.fn(() => ({ dispose: vi.fn() })),
    write: vi.fn(() => true),
    resize: vi.fn(() => true),
    interruptTerminal: vi.fn(() => true),
    closeTerminals: vi.fn(() => ({ closed: 1 })),
    executeCommand: vi.fn(async () => ({
      exit_code: null,
      output: "",
      output_captured: true,
    })),
  };
  const hub = new SandboxTerminalChannelHub();
  hub.attach(coordinator as unknown as SandboxTerminalCoordinator);
  return {
    coordinator,
    hub,
    emit(update: SandboxTerminalChannelEvent) {
      listener?.(update);
    },
  };
}

function nativeHubHarness() {
  const channel = sandboxSnapshot();
  channel.channelId = "native-agent-1";
  channel.title = "Native Agent";
  let lifecycleListener:
    | ((event: SandboxTerminalChannelEvent) => void)
    | undefined;
  let rawDataListener:
    | ((event: { channelId: string; data: string }) => void)
    | undefined;
  const coordinator = {
    listTerminals: vi.fn(() => [
      { id: channel.channelId, name: channel.title, busy: false },
    ]),
    getChannelSnapshot: vi.fn(() => structuredClone(channel)),
    onChannelEvent: vi.fn((next) => {
      lifecycleListener = next;
      return { dispose: vi.fn() };
    }),
    onRawData: vi.fn((next) => {
      rawDataListener = next;
      return { dispose: vi.fn() };
    }),
    onDispose: vi.fn(() => ({ dispose: vi.fn() })),
    write: vi.fn(() => true),
    resize: vi.fn(() => true),
    interruptTerminal: vi.fn(() => true),
    closeTerminals: vi.fn(() => ({ closed: 1 })),
    executeCommand: vi.fn(async () => ({
      exit_code: null,
      output: "",
      output_captured: true,
    })),
  };
  const hub = new SandboxTerminalChannelHub();
  hub.attach(coordinator as unknown as SandboxTerminalCoordinator, "native");
  return {
    channel,
    coordinator,
    hub,
    emitLifecycle(update: SandboxTerminalChannelEvent) {
      lifecycleListener?.(update);
    },
    emitRaw(data: string) {
      rawDataListener?.({ channelId: channel.channelId, data });
    },
  };
}

function target(
  test: ReturnType<typeof harness>,
  opened: { terminalId: string; terminalInstanceId: string },
) {
  return {
    ...opened,
    rendererEpoch: test.connection.rendererEpoch,
  };
}

describe("decideTerminalPaste", () => {
  it("matches VS Code auto, always, and never warning behavior", () => {
    expect(decideTerminalPaste("one\ntwo\n", "auto", true)).toEqual({
      action: "paste",
      data: "one\ntwo\n",
    });
    expect(decideTerminalPaste("one\ntwo\n", "auto", false)).toEqual({
      action: "confirm",
      data: "one\ntwo\n",
    });
    expect(decideTerminalPaste("one\ntwo\n", "always", true)).toEqual({
      action: "confirm",
      data: "one\ntwo\n",
    });
    expect(decideTerminalPaste("one\ntwo\n", "never", false)).toEqual({
      action: "paste",
      data: "one\ntwo\n",
    });
  });

  it("removes one trailing newline in auto mode without bracketed paste", () => {
    expect(decideTerminalPaste("echo ready\n", "auto", false)).toEqual({
      action: "paste",
      data: "echo ready",
    });
    expect(decideTerminalPaste("echo ready", "always", false)).toEqual({
      action: "paste",
      data: "echo ready",
    });
  });
});

describe("LiveHostTerminalSurfaceController", () => {
  it("retains multiple user terminals created from sequential New Terminal requests", async () => {
    const test = harness();
    await ready(test);
    test.events.length = 0;

    await test.controller.handleRequest(test.connection, {
      type: "host-terminal/create",
      requestId: "request-1",
    });
    await test.controller.handleRequest(test.connection, {
      type: "host-terminal/create",
      requestId: "request-2",
    });

    const opened = test.events.filter(
      (event) => event.type === "host-terminal/opened",
    );
    expect(opened).toHaveLength(2);
    expect(new Set(opened.map((event) => event.terminal.id)).size).toBe(2);
    expect(test.processes).toHaveLength(2);
    expect(test.processes.map((process) => process.killCount)).toEqual([0, 0]);

    test.events.length = 0;
    await ready(test);
    expect(test.events).toHaveLength(1);
    expect(test.events[0]).toMatchObject({
      type: "terminal-view/bootstrap",
      state: {
        tabs: [{ id: opened[0]?.terminal.id }, { id: opened[1]?.terminal.id }],
        activeTabId: opened[1]?.terminal.id,
      },
    });
  });

  it("keeps an active user command selected and marks agent activity for later", async () => {
    const native = nativeHubHarness();
    const test = harness(snapshot("/bin/zsh", ["-l"]), {
      sandboxChannelHub: native.hub,
      ensureRuntimeRoot: async () => {},
      materializeBootstrap: materializer(vi.fn(async () => {})),
    });
    await ready(test);
    const userOpened = await create(test);
    await test.controller.handleRequest(test.connection, {
      type: "terminal-view/focus-changed",
      focused: true,
    });
    const userTerminalId = userOpened.terminalId;
    const userNonce = "identifier_6_1234567890";
    test.processes[0].emitData(
      `${shellMarker("B", undefined, userNonce)}${shellMarker(
        "C",
        encodeShellIntegrationValue("sleep 10"),
        userNonce,
      )}`,
    );
    await Promise.resolve();
    test.events.length = 0;

    const command = {
      commandId: "native-command-1",
      generation: 1,
      command: "npm test",
      cwd: "/workspace",
      origin: "agent" as const,
      status: "running" as const,
      startedAt: 1,
      output: "",
      outputBytes: 0,
      droppedOutputBytes: 0,
      violations: [],
    };
    const runningSnapshot = {
      ...native.channel,
      status: "running" as const,
      activeCommandId: command.commandId,
      commands: [command],
    };
    native.emitLifecycle({
      event: { type: "command-started", command },
      snapshot: runningSnapshot,
    });

    expect(test.events).toContainEqual(
      expect.objectContaining({
        type: "host-terminal/agent-activity",
        terminalId: "native-agent-1",
        activity: "running",
      }),
    );
    expect(test.events).not.toContainEqual(
      expect.objectContaining({
        type: "host-terminal/activated",
        terminalId: "native-agent-1",
      }),
    );
    expect(test.requestTerminalViewReveal).not.toHaveBeenCalled();

    test.events.length = 0;
    native.emitLifecycle({
      event: {
        type: "command-exited",
        commandId: command.commandId,
        generation: 1,
        exit: { exitCode: 0, timedOut: false },
      },
      snapshot: {
        ...native.channel,
        commands: [{ ...command, status: "exited" as const, exitCode: 0 }],
      },
    });
    expect(test.events).toContainEqual(
      expect.objectContaining({
        type: "host-terminal/agent-activity",
        terminalId: "native-agent-1",
        activity: "unread",
      }),
    );

    test.events.length = 0;
    await ready(test);
    expect(test.events[0]).toMatchObject({
      type: "terminal-view/bootstrap",
      state: {
        activeTabId: userTerminalId,
        tabs: expect.arrayContaining([
          expect.objectContaining({
            id: "native-agent-1",
            agentActivity: "unread",
          }),
        ]),
      },
    });
  });

  it("renders the real Native Agent prompt and forwards idle input directly", async () => {
    const native = nativeHubHarness();
    const test = harness(snapshot(), { sandboxChannelHub: native.hub });

    await ready(test);
    const bootstrap = test.events[0];
    expect(bootstrap).toMatchObject({
      type: "terminal-view/bootstrap",
      state: {
        tabs: [
          {
            id: "native-agent-1",
            channelKind: "agent-native",
            profileName: "AgentLink Native",
          },
        ],
      },
      replay: [expect.objectContaining({ data: "" })],
    });
    if (bootstrap?.type !== "terminal-view/bootstrap") {
      throw new Error("expected bootstrap");
    }
    const nativeTarget = {
      terminalId: "native-agent-1",
      terminalInstanceId: bootstrap.replay[0].terminalInstanceId,
      rendererEpoch: test.connection.rendererEpoch,
    };

    native.emitRaw("➜  agentlink ");
    await Promise.resolve();
    await Promise.resolve();
    expect(test.events).toContainEqual(
      expect.objectContaining({
        type: "terminal-view/render-batch",
        terminalId: "native-agent-1",
        operations: expect.arrayContaining([
          { type: "write", data: "➜  agentlink " },
        ]),
      }),
    );

    await test.controller.handleRequest(test.connection, {
      type: "host-terminal/write",
      ...nativeTarget,
      data: "pwd\r",
    });
    expect(native.coordinator.write).toHaveBeenCalledWith(
      "native-agent-1",
      "pwd\r",
    );
    expect(native.coordinator.executeCommand).not.toHaveBeenCalled();

    native.channel.cwd = "/other";
    native.emitRaw("");
    await Promise.resolve();
    await Promise.resolve();
    expect(test.events).toContainEqual(
      expect.objectContaining({
        type: "host-terminal/cwd",
        terminalId: "native-agent-1",
        cwd: "/other",
      }),
    );
  });

  it("confirms Native Agent multiline paste and writes it once in the active shell mode", async () => {
    const native = nativeHubHarness();
    const test = harness(snapshot(), {
      sandboxChannelHub: native.hub,
      clipboardText: "printf one\nprintf two\n",
      multiLinePasteWarning: "always",
    });
    await ready(test);
    const bootstrap = test.events[0];
    if (bootstrap?.type !== "terminal-view/bootstrap") {
      throw new Error("expected bootstrap");
    }
    const nativeTarget = {
      terminalId: "native-agent-1",
      terminalInstanceId: bootstrap.replay[0].terminalInstanceId,
      rendererEpoch: test.connection.rendererEpoch,
    };

    await test.controller.handleRequest(test.connection, {
      type: "host-terminal/paste-intent",
      ...nativeTarget,
      bracketedPasteMode: true,
    });
    const cancelled = confirmation(test);
    expect(native.coordinator.write).not.toHaveBeenCalled();
    await test.controller.handleRequest(test.connection, {
      type: "terminal-view/confirm",
      ...nativeTarget,
      confirmationId: cancelled.confirmationId,
      accept: false,
    });
    expect(native.coordinator.write).not.toHaveBeenCalled();

    await test.controller.handleRequest(test.connection, {
      type: "host-terminal/paste-intent",
      ...nativeTarget,
      bracketedPasteMode: true,
    });
    const accepted = confirmation(test);
    await test.controller.handleRequest(test.connection, {
      type: "terminal-view/confirm",
      ...nativeTarget,
      confirmationId: accepted.confirmationId,
      accept: true,
      bracketedPasteMode: false,
    });
    expect(native.coordinator.write).toHaveBeenCalledTimes(1);
    expect(native.coordinator.write).toHaveBeenCalledWith(
      "native-agent-1",
      "printf one\rprintf two\r",
    );

    await test.controller.handleRequest(test.connection, {
      type: "terminal-view/confirm",
      ...nativeTarget,
      confirmationId: accepted.confirmationId,
      accept: true,
    });
    expect(native.coordinator.write).toHaveBeenCalledTimes(1);
  });

  it("invalidates a Native Agent paste confirmation when the user types", async () => {
    const native = nativeHubHarness();
    const test = harness(snapshot(), {
      sandboxChannelHub: native.hub,
      clipboardText: "printf one\nprintf two\n",
      multiLinePasteWarning: "always",
    });
    await ready(test);
    const bootstrap = test.events[0];
    if (bootstrap?.type !== "terminal-view/bootstrap") {
      throw new Error("expected bootstrap");
    }
    const nativeTarget = {
      terminalId: "native-agent-1",
      terminalInstanceId: bootstrap.replay[0].terminalInstanceId,
      rendererEpoch: test.connection.rendererEpoch,
    };

    await test.controller.handleRequest(test.connection, {
      type: "host-terminal/paste-intent",
      ...nativeTarget,
      bracketedPasteMode: true,
    });
    const requested = confirmation(test);
    await test.controller.handleRequest(test.connection, {
      type: "host-terminal/write",
      ...nativeTarget,
      data: "x",
    });
    expect(test.events).toContainEqual({
      type: "terminal-view/confirmation-cancelled",
      confirmationId: requested.confirmationId,
    });
    expect(native.coordinator.write).toHaveBeenCalledWith(
      "native-agent-1",
      "x",
    );

    await test.controller.handleRequest(test.connection, {
      type: "terminal-view/confirm",
      ...nativeTarget,
      confirmationId: requested.confirmationId,
      accept: true,
      bracketedPasteMode: true,
    });
    expect(native.coordinator.write).toHaveBeenCalledTimes(1);
  });

  it("selects the agent terminal when the active user terminal is provably idle", async () => {
    const native = nativeHubHarness();
    const test = harness(snapshot("/bin/zsh", ["-l"]), {
      sandboxChannelHub: native.hub,
      ensureRuntimeRoot: async () => {},
      materializeBootstrap: materializer(vi.fn(async () => {})),
    });
    await ready(test);
    await create(test);
    test.processes[0].emitData(
      `${shellMarker("A", undefined, "identifier_6_1234567890")}$ `,
    );
    await Promise.resolve();
    test.events.length = 0;

    const command = {
      commandId: "native-command-1",
      generation: 1,
      command: "printf native",
      cwd: "/workspace",
      origin: "agent" as const,
      status: "running" as const,
      startedAt: 1,
      output: "",
      outputBytes: 0,
      droppedOutputBytes: 0,
      violations: [],
    };
    native.emitLifecycle({
      event: { type: "command-started", command },
      snapshot: {
        ...native.channel,
        status: "running",
        activeCommandId: command.commandId,
        commands: [command],
      },
    });

    expect(test.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "host-terminal/agent-activity",
          terminalId: "native-agent-1",
          activity: "running",
        }),
        expect.objectContaining({
          type: "host-terminal/activated",
          terminalId: "native-agent-1",
        }),
      ]),
    );
    expect(test.requestTerminalViewReveal).toHaveBeenCalledOnce();
  });

  it("keeps a focused uncertain raw user terminal selected but switches after terminal focus leaves", async () => {
    const native = nativeHubHarness();
    const test = harness(snapshot(), { sandboxChannelHub: native.hub });
    await ready(test);
    const userOpened = await create(test);
    await test.controller.handleRequest(test.connection, {
      type: "terminal-view/focus-changed",
      focused: true,
    });
    test.events.length = 0;

    const command = {
      commandId: "native-command-raw-user",
      generation: 1,
      command: "printf native",
      cwd: "/workspace",
      origin: "agent" as const,
      status: "running" as const,
      startedAt: 1,
      output: "",
      outputBytes: 0,
      droppedOutputBytes: 0,
      violations: [],
    };
    native.emitLifecycle({
      event: { type: "command-started", command },
      snapshot: {
        ...native.channel,
        status: "running",
        activeCommandId: command.commandId,
        commands: [command],
      },
    });

    expect(test.events).not.toContainEqual(
      expect.objectContaining({
        type: "host-terminal/activated",
        terminalId: "native-agent-1",
      }),
    );
    expect(test.requestTerminalViewReveal).not.toHaveBeenCalled();

    await test.controller.handleRequest(test.connection, {
      type: "terminal-view/focus-changed",
      focused: false,
    });
    test.events.length = 0;
    native.emitLifecycle({
      event: {
        type: "command-started",
        command: {
          ...command,
          commandId: "native-command-2",
          generation: 2,
        },
      },
      snapshot: {
        ...native.channel,
        status: "running",
        activeCommandId: "native-command-2",
        commands: [
          { ...command, commandId: "native-command-2", generation: 2 },
        ],
      },
    });

    expect(test.events).toContainEqual(
      expect.objectContaining({
        type: "host-terminal/activated",
        terminalId: "native-agent-1",
      }),
    );
    expect(test.requestTerminalViewReveal).toHaveBeenCalledOnce();
    expect(userOpened.terminalId).not.toBe("native-agent-1");
  });

  it("explicitly reveals the exact custom terminal without changing reveal policy", async () => {
    const native = nativeHubHarness();
    const test = harness(snapshot(), { sandboxChannelHub: native.hub });
    await ready(test);
    native.emitLifecycle({
      event: {
        type: "command-started",
        command: {
          commandId: "native-command-1",
          generation: 1,
          command: "printf native",
          cwd: "/workspace",
          origin: "agent",
          status: "running",
          startedAt: 1,
          output: "",
          outputBytes: 0,
          droppedOutputBytes: 0,
          violations: [],
        },
      },
      snapshot: {
        ...native.channel,
        status: "running",
        activeCommandId: "native-command-1",
      },
    });
    test.events.length = 0;
    test.requestTerminalViewReveal.mockClear();

    expect(test.controller.revealTerminal("native-agent-1")).toBe(true);
    expect(test.controller.revealTerminal("missing-agent")).toBe(false);
    expect(test.events).toContainEqual(
      expect.objectContaining({
        type: "host-terminal/activated",
        terminalId: "native-agent-1",
      }),
    );
    expect(test.requestTerminalViewReveal).toHaveBeenCalledOnce();
  });

  it("isolates terminal view reveal failures after selecting the agent terminal", async () => {
    const native = nativeHubHarness();
    const log = vi.fn();
    const test = harness(snapshot(), {
      sandboxChannelHub: native.hub,
      requestTerminalViewReveal: () => {
        throw new Error("focus failed");
      },
      log,
    });
    await ready(test);
    test.events.length = 0;

    const command = {
      commandId: "native-command-1",
      generation: 1,
      command: "printf native",
      cwd: "/workspace",
      origin: "agent" as const,
      status: "running" as const,
      startedAt: 1,
      output: "",
      outputBytes: 0,
      droppedOutputBytes: 0,
      violations: [],
    };
    expect(() =>
      native.emitLifecycle({
        event: { type: "command-started", command },
        snapshot: {
          ...native.channel,
          status: "running",
          activeCommandId: command.commandId,
          commands: [command],
        },
      }),
    ).not.toThrow();

    expect(test.events).toContainEqual(
      expect.objectContaining({
        type: "host-terminal/activated",
        terminalId: "native-agent-1",
      }),
    );
    expect(log).toHaveBeenCalledWith(
      "Unable to reveal AgentLink Terminal: focus failed",
    );
  });

  it("does not synthesize or duplicate Native Agent command output", async () => {
    const native = nativeHubHarness();
    const test = harness(snapshot(), { sandboxChannelHub: native.hub });
    await ready(test);
    test.events.length = 0;

    const command = {
      commandId: "native-command-1",
      generation: 1,
      command: "printf native",
      cwd: "/workspace",
      origin: "agent" as const,
      status: "running" as const,
      startedAt: 1,
      output: "",
      outputBytes: 0,
      droppedOutputBytes: 0,
      violations: [],
    };
    native.emitLifecycle({
      event: { type: "command-started", command },
      snapshot: {
        ...native.channel,
        status: "running",
        activeCommandId: command.commandId,
        commands: [command],
      },
    });
    native.emitRaw("printf native\r\nnative\r\n➜  agentlink ");
    native.emitLifecycle({
      event: {
        type: "data",
        commandId: command.commandId,
        generation: 1,
        data: "native\r\n",
      },
      snapshot: {
        ...native.channel,
        status: "running",
        activeCommandId: command.commandId,
        commands: [{ ...command, output: "native\r\n" }],
      },
    });
    await Promise.resolve();
    await Promise.resolve();

    const writes = test.events.flatMap((event) =>
      event.type === "terminal-view/render-batch"
        ? event.operations.flatMap((operation) =>
            operation.type === "write" ? [operation.data] : [],
          )
        : [],
    );
    expect(writes).toEqual(["printf native\r\nnative\r\n➜  agentlink "]);
  });

  it("renders sandbox channels and launches idle user input as a fresh command", async () => {
    const sandbox = sandboxHubHarness();
    const test = harness(snapshot(), { sandboxChannelHub: sandbox.hub });

    await ready(test);
    const bootstrap = test.events[0];
    expect(bootstrap).toMatchObject({
      type: "terminal-view/bootstrap",
      state: {
        tabs: [
          {
            id: "sandbox-1",
            channelKind: "agent-sandbox",
            cwd: "/workspace",
            status: "running",
          },
        ],
      },
      replay: [expect.objectContaining({ data: "$ " })],
    });
    if (bootstrap?.type !== "terminal-view/bootstrap") {
      throw new Error("expected bootstrap");
    }
    const terminalInstanceId = bootstrap.replay[0].terminalInstanceId;
    const sandboxTarget = {
      terminalId: "sandbox-1",
      terminalInstanceId,
      rendererEpoch: test.connection.rendererEpoch,
    };

    await test.controller.handleRequest(test.connection, {
      type: "host-terminal/write",
      ...sandboxTarget,
      data: "pwd\r",
    });
    await Promise.resolve();
    expect(sandbox.coordinator.executeCommand).toHaveBeenCalledWith({
      command: "pwd",
      cwd: "/workspace",
      terminal_id: "sandbox-1",
      sandboxSessionId: "terminal-user:sandbox-1",
      background: true,
    });
    expect(sandbox.coordinator.write).not.toHaveBeenCalled();
  });

  it("recovers idle input when a launch resolves without a matching channel event", async () => {
    const sandbox = sandboxHubHarness();
    const test = harness(snapshot(), { sandboxChannelHub: sandbox.hub });
    await ready(test);
    const bootstrap = test.events[0];
    if (bootstrap?.type !== "terminal-view/bootstrap") {
      throw new Error("expected bootstrap");
    }
    const sandboxTarget = {
      terminalId: "sandbox-1",
      terminalInstanceId: bootstrap.replay[0].terminalInstanceId,
      rendererEpoch: test.connection.rendererEpoch,
    };

    await test.controller.handleRequest(test.connection, {
      type: "host-terminal/write",
      ...sandboxTarget,
      data: "first\r",
    });
    await Promise.resolve();
    await Promise.resolve();
    await test.controller.handleRequest(test.connection, {
      type: "host-terminal/write",
      ...sandboxTarget,
      data: "second\r",
    });
    await Promise.resolve();

    expect(sandbox.coordinator.executeCommand).toHaveBeenCalledTimes(2);
    expect(sandbox.coordinator.executeCommand).toHaveBeenLastCalledWith(
      expect.objectContaining({ command: "second" }),
    );
  });

  it("reads sandbox paste in the host and rejects multiline command injection", async () => {
    const sandbox = sandboxHubHarness();
    const test = harness(snapshot(), {
      sandboxChannelHub: sandbox.hub,
      clipboardText: "git status\npwd",
    });
    await ready(test);
    const bootstrap = test.events[0];
    if (bootstrap?.type !== "terminal-view/bootstrap") {
      throw new Error("expected bootstrap");
    }

    await test.controller.handleRequest(test.connection, {
      type: "host-terminal/paste-intent",
      terminalId: "sandbox-1",
      terminalInstanceId: bootstrap.replay[0].terminalInstanceId,
      rendererEpoch: test.connection.rendererEpoch,
    });

    expect(test.readClipboard).toHaveBeenCalledTimes(1);
    expect(sandbox.coordinator.executeCommand).not.toHaveBeenCalled();
    expect(sandbox.coordinator.write).not.toHaveBeenCalled();
    expect(test.events).toContainEqual(
      expect.objectContaining({
        type: "host-terminal/error",
        terminalId: "sandbox-1",
        message: expect.stringContaining("one command at a time"),
      }),
    );
  });

  it("forwards active sandbox input and Ctrl+C without touching host PTYs", async () => {
    const sandbox = sandboxHubHarness();
    const test = harness(snapshot(), { sandboxChannelHub: sandbox.hub });
    await ready(test);
    const bootstrap = test.events[0];
    if (bootstrap?.type !== "terminal-view/bootstrap") {
      throw new Error("expected bootstrap");
    }
    const terminalInstanceId = bootstrap.replay[0].terminalInstanceId;
    const sandboxTarget = {
      terminalId: "sandbox-1",
      terminalInstanceId,
      rendererEpoch: test.connection.rendererEpoch,
    };
    sandbox.emit({
      event: {
        type: "command-started",
        command: {
          commandId: "command-2",
          generation: 2,
          command: "cat",
          cwd: "/workspace",
          origin: "agent",
          status: "launching",
          startedAt: 1,
          output: "",
          outputBytes: 0,
          droppedOutputBytes: 0,
          violations: [],
        },
      },
      snapshot: {
        ...sandboxSnapshot("running"),
        activeCommandId: "command-2",
      },
    });

    await test.controller.handleRequest(test.connection, {
      type: "host-terminal/write",
      ...sandboxTarget,
      data: "hello",
    });
    await test.controller.handleRequest(test.connection, {
      type: "host-terminal/write",
      ...sandboxTarget,
      data: "\x03",
    });

    expect(sandbox.coordinator.write).toHaveBeenCalledWith(
      "sandbox-1",
      "hello",
    );
    expect(sandbox.coordinator.interruptTerminal).toHaveBeenCalledWith({
      owner: undefined,
      terminalId: "sandbox-1",
    });
    expect(test.processes).toEqual([]);
  });

  it("resyncs sandbox replay after acknowledged byte pressure drains", async () => {
    const sandbox = sandboxHubHarness();
    const test = harness(snapshot(), {
      sandboxChannelHub: sandbox.hub,
      runtimeWatermarks: { high: 4, low: 2 },
    });
    await ready(test);
    const bootstrap = test.events[0];
    if (bootstrap?.type !== "terminal-view/bootstrap") {
      throw new Error("expected bootstrap");
    }
    const terminalInstanceId = bootstrap.replay[0].terminalInstanceId;
    sandbox.emit({
      event: {
        type: "data",
        commandId: "command-2",
        generation: 2,
        data: "1234",
      },
      snapshot: {
        ...sandboxSnapshot("running"),
        activeCommandId: "command-2",
      },
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    const batch = test.events.find(
      (event) => event.type === "terminal-view/render-batch",
    );
    if (!batch || batch.type !== "terminal-view/render-batch") {
      throw new Error("expected render batch");
    }

    sandbox.emit({
      event: {
        type: "data",
        commandId: "command-2",
        generation: 2,
        data: "retained while paused",
      },
      snapshot: {
        ...sandboxSnapshot("running"),
        activeCommandId: "command-2",
      },
    });
    await test.controller.handleRequest(test.connection, {
      type: "terminal-view/output-ack",
      terminalId: "sandbox-1",
      terminalInstanceId,
      rendererEpoch: test.connection.rendererEpoch,
      sequence: batch.sequence,
    });

    expect(test.events).toContainEqual({
      type: "terminal-view/resync-required",
      rendererEpoch: test.connection.rendererEpoch,
    });
  });

  it("bounds queued sandbox render batches and requests authoritative replay", async () => {
    const sandbox = sandboxHubHarness();
    let blockRender = false;
    const blocked = deferred<boolean>();
    const test = harness(snapshot(), {
      sandboxChannelHub: sandbox.hub,
      postSurfaceEvent: (event) =>
        blockRender && event.type === "terminal-view/render-batch"
          ? blocked.promise
          : true,
    });
    await ready(test);
    blockRender = true;

    for (let index = 0; index < 300; index += 1) {
      sandbox.emit({
        event: {
          type: "data",
          commandId: "command-2",
          generation: 2,
          data: `${index}\n`,
        },
        snapshot: {
          ...sandboxSnapshot("running"),
          activeCommandId: "command-2",
        },
      });
    }
    await Promise.resolve();

    expect(
      test.events.filter(
        (event) => event.type === "terminal-view/resync-required",
      ),
    ).toHaveLength(1);
    expect(
      test.events.filter(
        (event) => event.type === "terminal-view/render-batch",
      ),
    ).toHaveLength(0);
    blocked.resolve(true);
  });

  it("renders agent sandbox output, rejects stale renderer identity, and closes only the sandbox channel", async () => {
    const sandbox = sandboxHubHarness();
    const test = harness(snapshot(), { sandboxChannelHub: sandbox.hub });
    await ready(test);
    const bootstrap = test.events[0];
    if (bootstrap?.type !== "terminal-view/bootstrap") {
      throw new Error("expected bootstrap");
    }
    const terminalInstanceId = bootstrap.replay[0].terminalInstanceId;
    sandbox.emit({
      event: {
        type: "data",
        commandId: "command-2",
        generation: 2,
        data: "agent output\r\n",
      },
      snapshot: {
        ...sandboxSnapshot("running"),
        activeCommandId: "command-2",
      },
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(test.events).toContainEqual(
      expect.objectContaining({
        type: "terminal-view/render-batch",
        terminalId: "sandbox-1",
        operations: expect.arrayContaining([
          { type: "write", data: "agent output\r\n" },
        ]),
      }),
    );

    await test.controller.handleRequest(test.connection, {
      type: "host-terminal/write",
      terminalId: "sandbox-1",
      terminalInstanceId: "stale-instance",
      rendererEpoch: test.connection.rendererEpoch,
      data: "nope",
    });
    expect(sandbox.coordinator.write).not.toHaveBeenCalled();

    await test.controller.handleRequest(test.connection, {
      type: "host-terminal/close-intent",
      terminalId: "sandbox-1",
      terminalInstanceId,
      rendererEpoch: test.connection.rendererEpoch,
    });
    expect(sandbox.coordinator.closeTerminals).toHaveBeenCalledWith({
      owner: undefined,
      names: ["sandbox-1"],
    });
    expect(test.processes).toEqual([]);
  });
  it("uses the resolved shell executable as the user terminal title", async () => {
    const test = harness(snapshot("/bin/zsh"), {
      ensureRuntimeRoot: vi.fn(async () => {}),
      materializeBootstrap: materializer(vi.fn(async () => {})),
    });
    await ready(test);

    await test.controller.handleRequest(test.connection, {
      type: "host-terminal/create",
      requestId: "zsh-request",
    });
    await vi.waitFor(() =>
      expect(
        test.events.some((event) => event.type === "host-terminal/opened"),
      ).toBe(true),
    );

    const opened = test.events.find(
      (event) => event.type === "host-terminal/opened",
    );
    expect(opened).toMatchObject({
      type: "host-terminal/opened",
      terminal: {
        title: "zsh",
        profileName: "Selected",
      },
    });
  });

  it("keeps profile and native loading cold until an explicit create request", async () => {
    const test = harness();

    await ready(test);

    expect(test.events).toEqual([
      {
        type: "terminal-view/bootstrap",
        protocolVersion: TERMINAL_SURFACE_PROTOCOL_VERSION,
        rendererEpoch: test.connection.rendererEpoch,
        state: { tabs: [] },
        configuration: {
          scrollback: 2000,
          multiLinePasteWarning: "auto",
        },
        replay: [],
      },
    ]);
    expect(test.getConfigurationSnapshot).not.toHaveBeenCalled();
    expect(test.load).not.toHaveBeenCalled();
    expect(test.spawn).not.toHaveBeenCalled();
  });

  it("blocks untrusted workspace creation before bootstrap or native loading", async () => {
    const untrusted = { ...snapshot("/bin/zsh"), isWorkspaceTrusted: false };
    const ensureRuntimeRoot = vi.fn(async () => {});
    const materializeBootstrap = vi.fn(materializer(vi.fn(async () => {})));
    const test = harness(untrusted, {
      ensureRuntimeRoot,
      materializeBootstrap,
    });
    await ready(test);

    await test.controller.handleRequest(test.connection, {
      type: "host-terminal/create",
      requestId: "untrusted-request",
    });

    expect(test.events.at(-1)).toMatchObject({
      type: "terminal-view/fallback",
      fallback: { reason: "workspace-untrusted" },
    });
    expect(ensureRuntimeRoot).not.toHaveBeenCalled();
    expect(materializeBootstrap).not.toHaveBeenCalled();
    expect(test.load).not.toHaveBeenCalled();
    expect(test.spawn).not.toHaveBeenCalled();
  });

  it("publishes native fallback without loading node-pty", async () => {
    const test = harness(snapshot("/opt/homebrew/bin/fish"));
    await ready(test);

    await test.controller.handleRequest(test.connection, {
      type: "host-terminal/create",
      requestId: "fish-request",
    });

    expect(test.events.at(-1)).toMatchObject({
      type: "terminal-view/fallback",
      fallback: {
        reason: "native-shell-required",
        profileName: "Selected",
        executable: "/opt/homebrew/bin/fish",
      },
    });
    expect(test.load).not.toHaveBeenCalled();
    expect(test.spawn).not.toHaveBeenCalled();
  });

  it("opens native fallback only for a current explicit renderer gesture", async () => {
    const test = harness(snapshot("/opt/homebrew/bin/fish"));
    await ready(test);
    await test.controller.handleRequest(test.connection, {
      type: "host-terminal/create",
      requestId: "fish-request",
    });

    await test.controller.handleRequest(test.connection, {
      type: "terminal-view/open-native-fallback",
      rendererEpoch: "stale-renderer",
    });
    expect(test.openNativeTerminal).not.toHaveBeenCalled();

    await test.controller.handleRequest(test.connection, {
      type: "terminal-view/open-native-fallback",
      rendererEpoch: test.connection.rendererEpoch,
    });
    expect(test.openNativeTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "native-shell-required" }),
    );
  });

  it("opens only http links from a current explicit renderer gesture", async () => {
    const test = harness();
    await ready(test);

    for (const url of [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "not a url",
    ]) {
      await test.controller.handleRequest(test.connection, {
        type: "terminal-view/open-link",
        rendererEpoch: test.connection.rendererEpoch,
        url,
      });
    }
    await test.controller.handleRequest(test.connection, {
      type: "terminal-view/open-link",
      rendererEpoch: "stale-renderer",
      url: "https://example.com/stale",
    });
    expect(test.openExternal).not.toHaveBeenCalled();

    await test.controller.handleRequest(test.connection, {
      type: "terminal-view/open-link",
      rendererEpoch: test.connection.rendererEpoch,
      url: "https://example.com/path?q=1",
    });
    expect(test.openExternal).toHaveBeenCalledWith(
      "https://example.com/path?q=1",
    );
  });

  it("creates a raw terminal and routes input, resize, exit, and close", async () => {
    const test = harness();
    await ready(test);
    const opened = await create(test);
    const process = test.processes[0];

    expect(test.load).toHaveBeenCalledTimes(1);
    expect(test.spawn).toHaveBeenCalledWith(
      "/bin/sh",
      [],
      expect.objectContaining({
        cwd: "/workspace",
        cols: 80,
        rows: 24,
      }),
    );

    await test.controller.handleRequest(test.connection, {
      type: "host-terminal/write",
      ...target(test, opened),
      data: "echo hello\r",
    });
    await test.controller.handleRequest(test.connection, {
      type: "host-terminal/resize",
      ...target(test, opened),
      dimensions: { columns: 120, rows: 40 },
    });
    expect(process.writes).toEqual(["echo hello\r"]);
    expect(process.resizes).toEqual([[120, 40]]);

    process.emitData("hello\r\n");
    await Promise.resolve();
    await Promise.resolve();
    const batch = test.events.find(
      (event) => event.type === "terminal-view/render-batch",
    );
    expect(batch).toMatchObject({
      type: "terminal-view/render-batch",
      terminalId: opened.terminalId,
    });
    if (!batch || batch.type !== "terminal-view/render-batch") {
      throw new Error("expected render batch");
    }
    expect(batch.operations).toContainEqual({
      type: "write",
      data: "hello\r\n",
    });

    process.emitExit(0);
    await vi.waitFor(() => {
      expect(
        test.events.some(
          (event) =>
            event.type === "host-terminal/exited" &&
            event.terminalId === opened.terminalId &&
            event.exitCode === 0,
        ),
      ).toBe(true);
    });
    await test.controller.handleRequest(test.connection, {
      type: "host-terminal/close-intent",
      ...target(test, opened),
    });
    expect(
      test.events.some(
        (event) =>
          event.type === "host-terminal/closed" &&
          event.terminalId === opened.terminalId,
      ),
    ).toBe(true);
  });

  it("requires a one-use confirmation before closing a running raw terminal", async () => {
    const test = harness();
    await ready(test);
    const opened = await create(test);

    await test.controller.handleRequest(test.connection, {
      type: "host-terminal/close-intent",
      ...target(test, opened),
    });
    const requested = confirmation(test);
    expect(requested).toMatchObject({
      operation: "close",
      terminalId: opened.terminalId,
      terminalInstanceId: opened.terminalInstanceId,
    });
    expect(test.processes[0].killCount).toBe(0);

    await test.controller.handleRequest(test.connection, {
      type: "terminal-view/confirm",
      ...target(test, opened),
      confirmationId: requested.confirmationId,
      accept: false,
    });
    expect(test.processes[0].killCount).toBe(0);
    await test.controller.handleRequest(test.connection, {
      type: "terminal-view/confirm",
      ...target(test, opened),
      confirmationId: requested.confirmationId,
      accept: true,
    });
    expect(test.processes[0].killCount).toBe(0);

    await test.controller.handleRequest(test.connection, {
      type: "host-terminal/close-intent",
      ...target(test, opened),
    });
    const accepted = confirmation(test);
    await test.controller.handleRequest(test.connection, {
      type: "terminal-view/confirm",
      ...target(test, opened),
      confirmationId: accepted.confirmationId,
      accept: true,
    });
    expect(test.processes[0].killCount).toBe(1);
  });

  it("invalidates close confirmation after terminal activity", async () => {
    const test = harness();
    await ready(test);
    const opened = await create(test);

    await test.controller.handleRequest(test.connection, {
      type: "host-terminal/close-intent",
      ...target(test, opened),
    });
    const requested = confirmation(test);
    test.processes[0].emitData("changed");
    expect(test.events.at(-1)).toEqual({
      type: "terminal-view/confirmation-cancelled",
      confirmationId: requested.confirmationId,
    });
    await test.controller.handleRequest(test.connection, {
      type: "terminal-view/confirm",
      ...target(test, opened),
      confirmationId: requested.confirmationId,
      accept: true,
    });

    expect(test.processes[0].killCount).toBe(0);
  });

  it("invalidates close confirmation across renderer resync", async () => {
    const test = harness();
    await ready(test);
    const opened = await create(test);

    await test.controller.handleRequest(test.connection, {
      type: "host-terminal/close-intent",
      ...target(test, opened),
    });
    const requested = confirmation(test);
    await test.controller.handleRequest(test.connection, {
      type: "terminal-view/resync",
      rendererEpoch: test.connection.rendererEpoch,
    });
    await test.controller.handleRequest(test.connection, {
      type: "terminal-view/confirm",
      ...target(test, opened),
      confirmationId: requested.confirmationId,
      accept: true,
    });

    expect(test.processes[0].killCount).toBe(0);
  });

  it("invalidates host-retained paste data when its renderer detaches", async () => {
    const test = harness(snapshot(), { clipboardText: "echo one\necho two\n" });
    await ready(test);
    const opened = await create(test);

    await test.controller.handleRequest(test.connection, {
      type: "host-terminal/paste-intent",
      ...target(test, opened),
    });
    const requested = confirmation(test);
    test.controller.detach(test.connection);

    const replacement = test.controller.attach(async (event) => {
      test.events.push(event);
      return true;
    });
    await test.controller.handleRequest(replacement, {
      type: "terminal-view/ready",
      protocolVersion: TERMINAL_SURFACE_PROTOCOL_VERSION,
    });
    await test.controller.handleRequest(replacement, {
      type: "terminal-view/confirm",
      ...opened,
      rendererEpoch: replacement.rendererEpoch,
      confirmationId: requested.confirmationId,
      accept: true,
    });

    expect(test.processes[0].writes).toEqual([]);
  });

  it("pastes single-line clipboard text immediately after an explicit intent", async () => {
    const test = harness(snapshot(), { clipboardText: "echo hello" });
    await ready(test);
    const opened = await create(test);
    expect(test.readClipboard).not.toHaveBeenCalled();

    await test.controller.handleRequest(test.connection, {
      type: "host-terminal/paste-intent",
      ...target(test, opened),
    });

    expect(test.readClipboard).toHaveBeenCalledTimes(1);
    expect(test.processes[0].writes).toEqual(["echo hello"]);
    expect(
      test.events.some((event) => event.type === "terminal-view/confirmation"),
    ).toBe(false);
  });

  it("keeps multiline clipboard text host-side until one-use confirmation", async () => {
    const test = harness(snapshot(), {
      clipboardText: "echo one\necho two\n",
      multiLinePasteWarning: "always",
    });
    await ready(test);
    const opened = await create(test);

    await test.controller.handleRequest(test.connection, {
      type: "host-terminal/paste-intent",
      ...target(test, opened),
      bracketedPasteMode: true,
    });
    const requested = confirmation(test);
    expect(requested).toMatchObject({
      operation: "paste",
      message: expect.not.stringContaining("echo one"),
    });
    expect(test.processes[0].writes).toEqual([]);

    await test.controller.handleRequest(test.connection, {
      type: "terminal-view/confirm",
      ...target(test, opened),
      confirmationId: requested.confirmationId,
      accept: true,
    });
    expect(test.processes[0].writes).toEqual([
      "\x1b[200~echo one\recho two\r\x1b[201~",
    ]);
    await test.controller.handleRequest(test.connection, {
      type: "terminal-view/confirm",
      ...target(test, opened),
      confirmationId: requested.confirmationId,
      accept: true,
    });
    expect(test.processes[0].writes).toEqual([
      "\x1b[200~echo one\recho two\r\x1b[201~",
    ]);
  });

  it("ignores an older clipboard read when a newer paste intent wins", async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const reads = [first.promise, second.promise];
    const test = harness(snapshot(), {
      readClipboard: () => reads.shift()!,
    });
    await ready(test);
    const opened = await create(test);

    const older = test.controller.handleRequest(test.connection, {
      type: "host-terminal/paste-intent",
      ...target(test, opened),
    });
    const newer = test.controller.handleRequest(test.connection, {
      type: "host-terminal/paste-intent",
      ...target(test, opened),
    });
    second.resolve("newer");
    await newer;
    first.resolve("older");
    await older;

    expect(test.processes[0].writes).toEqual(["newer"]);
  });

  it("reports clipboard read failures without writing terminal input", async () => {
    const test = harness(snapshot(), {
      clipboardError: new Error("clipboard unavailable"),
    });
    await ready(test);
    const opened = await create(test);

    await test.controller.handleRequest(test.connection, {
      type: "host-terminal/paste-intent",
      ...target(test, opened),
    });

    expect(test.processes[0].writes).toEqual([]);
    expect(test.events.at(-1)).toMatchObject({
      type: "host-terminal/error",
      terminalId: opened.terminalId,
      message: "Unable to read the clipboard: clipboard unavailable",
    });
  });

  it("rejects stale renderer paste intents and oversized clipboard text", async () => {
    const oversized = "🙂".repeat(20_000);
    const test = harness(snapshot(), { clipboardText: oversized });
    await ready(test);
    const opened = await create(test);

    await test.controller.handleRequest(test.connection, {
      type: "host-terminal/paste-intent",
      ...target(test, opened),
      rendererEpoch: "stale-renderer",
    });
    expect(test.readClipboard).not.toHaveBeenCalled();

    await test.controller.handleRequest(test.connection, {
      type: "host-terminal/paste-intent",
      ...target(test, opened),
    });
    expect(test.readClipboard).toHaveBeenCalledTimes(1);
    expect(test.processes[0].writes).toEqual([]);
    expect(test.events.at(-1)).toMatchObject({
      type: "host-terminal/error",
      terminalId: opened.terminalId,
      message: expect.stringContaining("paste limit"),
    });
  });

  it("invalidates pending close confirmation on every current block action", async () => {
    const test = harness();
    await ready(test);
    const opened = await create(test);
    test.processes[0].emitData("copyable");

    await test.controller.handleRequest(test.connection, {
      type: "host-terminal/close-intent",
      ...target(test, opened),
    });
    const requested = confirmation(test);
    await test.controller.handleRequest(test.connection, {
      type: "terminal-view/action",
      ...target(test, opened),
      blockId: "host-block-1",
      action: "copy-output",
    });
    expect(test.events).toContainEqual({
      type: "terminal-view/confirmation-cancelled",
      confirmationId: requested.confirmationId,
    });
    await test.controller.handleRequest(test.connection, {
      type: "terminal-view/confirm",
      ...target(test, opened),
      confirmationId: requested.confirmationId,
      accept: true,
    });

    expect(test.writeClipboard).toHaveBeenCalledWith("copyable");
    expect(test.processes[0].killCount).toBe(0);
  });

  it("dispatches sanitized copy and one-shot rerun through host authorization", async () => {
    const test = harness(snapshot("/bin/zsh"), {
      ensureRuntimeRoot: async () => {},
      materializeBootstrap: materializer(vi.fn(async () => {})),
    });
    await ready(test);
    const opened = await create(test);
    const process = test.processes[0];

    process.emitData(
      [
        shellMarker("C", encodeShellIntegrationValue("printf hello")),
        "\x1b[31mhello\x1b[0m\r\n",
        shellMarker("D", "0"),
        shellMarker("A"),
        "$ ",
      ].join(""),
    );
    await Promise.resolve();

    await test.controller.handleRequest(test.connection, {
      type: "terminal-view/action",
      ...target(test, opened),
      blockId: "host-block-1",
      action: "copy-command-and-output",
    });
    expect(test.writeClipboard).toHaveBeenCalledWith("printf hello\nhello\r\n");

    await test.controller.handleRequest(test.connection, {
      type: "terminal-view/action",
      ...target(test, opened),
      blockId: "host-block-1",
      action: "rerun-command",
    });
    await test.controller.handleRequest(test.connection, {
      type: "terminal-view/action",
      ...target(test, opened),
      blockId: "host-block-1",
      action: "rerun-command",
    });
    expect(process.writes).toEqual(["printf hello\r"]);
  });

  it("rejects rerun after a newer command starts before dispatch", async () => {
    const test = harness(snapshot("/bin/zsh"), {
      ensureRuntimeRoot: async () => {},
      materializeBootstrap: materializer(vi.fn(async () => {})),
    });
    await ready(test);
    const opened = await create(test);
    const process = test.processes[0];

    process.emitData(
      [
        shellMarker("C", encodeShellIntegrationValue("first")),
        shellMarker("D", "0"),
        shellMarker("A"),
        shellMarker("B"),
        shellMarker("C", encodeShellIntegrationValue("second")),
      ].join(""),
    );
    await test.controller.handleRequest(test.connection, {
      type: "terminal-view/action",
      ...target(test, opened),
      blockId: "host-block-1",
      action: "rerun-command",
    });

    expect(process.writes).toEqual([]);
  });

  it("authorizes interrupt only for the current active integrated command", async () => {
    const test = harness(snapshot("/bin/zsh"), {
      ensureRuntimeRoot: async () => {},
      materializeBootstrap: materializer(vi.fn(async () => {})),
    });
    await ready(test);
    const opened = await create(test);
    const process = test.processes[0];

    process.emitData(shellMarker("C", encodeShellIntegrationValue("sleep 10")));
    await test.controller.handleRequest(test.connection, {
      type: "terminal-view/action",
      ...target(test, opened),
      blockId: "host-block-1",
      action: "interrupt-command",
    });
    process.emitData(`${shellMarker("D", "130")}${shellMarker("A")}$ `);
    await test.controller.handleRequest(test.connection, {
      type: "terminal-view/action",
      ...target(test, opened),
      blockId: "host-block-1",
      action: "interrupt-command",
    });

    expect(process.writes).toEqual(["\x03"]);
  });

  it("rejects stale, raw, and alternate-screen action requests", async () => {
    const raw = harness();
    await ready(raw);
    const rawOpened = await create(raw);
    raw.processes[0].emitData("raw output");
    await raw.controller.handleRequest(raw.connection, {
      type: "terminal-view/action",
      ...target(raw, rawOpened),
      blockId: "host-block-1",
      action: "rerun-command",
    });
    await raw.controller.handleRequest(raw.connection, {
      type: "terminal-view/action",
      ...target(raw, rawOpened),
      rendererEpoch: "stale-renderer",
      blockId: "host-block-1",
      action: "copy-output",
    });
    expect(raw.processes[0].writes).toEqual([]);
    expect(raw.writeClipboard).not.toHaveBeenCalled();

    const integrated = harness(snapshot("/bin/zsh"), {
      ensureRuntimeRoot: async () => {},
      materializeBootstrap: materializer(vi.fn(async () => {})),
    });
    await ready(integrated);
    const integratedOpened = await create(integrated);
    integrated.processes[0].emitData(
      `${shellMarker("C", encodeShellIntegrationValue("vim file"))}\x1b[?1049h`,
    );
    await integrated.controller.handleRequest(integrated.connection, {
      type: "terminal-view/action",
      ...target(integrated, integratedOpened),
      blockId: "host-block-1",
      action: "interrupt-command",
    });
    expect(integrated.processes[0].writes).toEqual([]);
  });

  it("reports truncated output without copying or exposing retained content", async () => {
    const test = harness();
    await ready(test);
    const opened = await create(test);
    test.processes[0].emitData(`secret-prefix${"x".repeat(256 * 1024)}`);

    await test.controller.handleRequest(test.connection, {
      type: "terminal-view/action",
      ...target(test, opened),
      blockId: "host-block-1",
      action: "copy-output",
    });

    expect(test.writeClipboard).not.toHaveBeenCalled();
    const error = test.events.find(
      (event) =>
        event.type === "host-terminal/error" &&
        event.terminalId === opened.terminalId,
    );
    expect(error).toMatchObject({
      type: "host-terminal/error",
      message:
        "The retained command output is incomplete and cannot be copied safely.",
    });
    expect(error).not.toMatchObject({
      message: expect.stringContaining("secret-prefix"),
    });
  });

  it("reports clipboard write failure without exposing copied text", async () => {
    const test = harness(snapshot(), {
      clipboardWriteError: new Error("clipboard unavailable"),
    });
    await ready(test);
    const opened = await create(test);
    test.processes[0].emitData("safe output");

    await test.controller.handleRequest(test.connection, {
      type: "terminal-view/action",
      ...target(test, opened),
      blockId: "host-block-1",
      action: "copy-output",
    });

    expect(test.events.at(-1)).toMatchObject({
      type: "host-terminal/error",
      terminalId: opened.terminalId,
      message: "Unable to write to the clipboard: clipboard unavailable",
    });
    expect(test.events.at(-1)).not.toMatchObject({
      message: expect.stringContaining("safe output"),
    });
  });

  it("rejects stale targets and stale connections", async () => {
    const test = harness();
    await ready(test);
    const opened = await create(test);
    const process = test.processes[0];

    await test.controller.handleRequest(test.connection, {
      type: "host-terminal/write",
      ...target(test, opened),
      rendererEpoch: "stale-renderer",
      data: "blocked",
    });
    test.controller.detach(test.connection);
    await test.controller.handleRequest(test.connection, {
      type: "host-terminal/write",
      ...target(test, opened),
      data: "also blocked",
    });

    expect(process.writes).toEqual([]);
  });

  it("stops before materialization when runtime-root setup makes the request stale", async () => {
    let test!: ReturnType<typeof harness>;
    const materializeBootstrap = vi.fn(materializer(vi.fn(async () => {})));
    test = harness(snapshot("/bin/zsh"), {
      ensureRuntimeRoot: async () => test.controller.detach(test.connection),
      materializeBootstrap,
    });
    await ready(test);

    await test.controller.handleRequest(test.connection, {
      type: "host-terminal/create",
      requestId: "stale-root-request",
    });

    expect(materializeBootstrap).not.toHaveBeenCalled();
    expect(test.load).not.toHaveBeenCalled();
    expect(test.spawn).not.toHaveBeenCalled();
  });

  it("cleans materialized bootstrap artifacts when the request becomes stale", async () => {
    let test!: ReturnType<typeof harness>;
    const cleanup = vi.fn(async () => {});
    test = harness(snapshot("/bin/zsh"), {
      ensureRuntimeRoot: async () => {},
      materializeBootstrap: async (plan) => {
        const materialized = await materializer(cleanup)(plan);
        test.controller.detach(test.connection);
        return materialized;
      },
    });
    await ready(test);

    await test.controller.handleRequest(test.connection, {
      type: "host-terminal/create",
      requestId: "stale-materialization-request",
    });

    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(test.load).not.toHaveBeenCalled();
    expect(test.spawn).not.toHaveBeenCalled();
  });

  it("cleans materialized bootstrap artifacts when native loading makes the request stale", async () => {
    let test!: ReturnType<typeof harness>;
    const cleanup = vi.fn(async () => {});
    test = harness(snapshot("/bin/zsh"), {
      ensureRuntimeRoot: async () => {},
      materializeBootstrap: materializer(cleanup),
      onLoad: () => test.controller.detach(test.connection),
    });
    await ready(test);

    await test.controller.handleRequest(test.connection, {
      type: "host-terminal/create",
      requestId: "stale-load-request",
    });

    expect(test.load).toHaveBeenCalledTimes(1);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(test.spawn).not.toHaveBeenCalled();
  });

  it("cleans materialized bootstrap artifacts after spawn failure", async () => {
    const cleanup = vi.fn(async () => {});
    const test = harness(snapshot("/bin/zsh"), {
      ensureRuntimeRoot: async () => {},
      materializeBootstrap: materializer(cleanup),
      spawnError: new Error("spawn failed"),
    });
    await ready(test);

    await test.controller.handleRequest(test.connection, {
      type: "host-terminal/create",
      requestId: "failed-spawn-request",
    });

    await vi.waitFor(() => expect(cleanup).toHaveBeenCalledTimes(1));
    expect(test.processes).toEqual([]);
  });

  it.each(["exit", "close"] as const)(
    "cleans materialized bootstrap artifacts once on %s",
    async (transition) => {
      const cleanup = vi.fn(async () => {});
      const test = harness(snapshot("/bin/zsh"), {
        ensureRuntimeRoot: async () => {},
        materializeBootstrap: materializer(cleanup),
      });
      await ready(test);
      const opened = await create(test);

      if (transition === "exit") {
        test.processes[0].emitExit(0);
      } else {
        await test.controller.handleRequest(test.connection, {
          type: "host-terminal/close-intent",
          ...target(test, opened),
        });
        const requested = confirmation(test);
        await test.controller.handleRequest(test.connection, {
          type: "terminal-view/confirm",
          ...target(test, opened),
          confirmationId: requested.confirmationId,
          accept: true,
        });
      }

      await vi.waitFor(() => expect(cleanup).toHaveBeenCalledTimes(1));
      test.controller.dispose();
      await Promise.resolve();
      expect(cleanup).toHaveBeenCalledTimes(1);
    },
  );

  it("revokes ready state after failed delivery and replays only after resync", async () => {
    const test = harness();
    await ready(test);
    const opened = await create(test);
    let rejectNextBatch = true;
    test.connection.postMessage = vi.fn(async (event) => {
      if (event.type === "terminal-view/render-batch" && rejectNextBatch) {
        rejectNextBatch = false;
        return false;
      }
      test.events.push(event);
      return true;
    });

    test.processes[0].emitData("first");
    await vi.waitFor(() =>
      expect(test.connection.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: "terminal-view/render-batch" }),
      ),
    );
    test.processes[0].emitData("second");
    await Promise.resolve();
    await Promise.resolve();
    expect(
      test.events.some(
        (event) =>
          event.type === "terminal-view/render-batch" &&
          event.operations.some(
            (operation) =>
              operation.type === "write" && operation.data === "second",
          ),
      ),
    ).toBe(false);

    await test.controller.handleRequest(test.connection, {
      type: "terminal-view/ready",
      protocolVersion: TERMINAL_SURFACE_PROTOCOL_VERSION,
    });
    expect(test.events.at(-1)).toMatchObject({
      type: "terminal-view/bootstrap",
      replay: [
        {
          terminalId: opened.terminalId,
          data: "firstsecond",
        },
      ],
    });
  });

  it("drains the PTY and resyncs once after renderer pressure is acknowledged", async () => {
    const test = harness(snapshot(), {
      runtimeWatermarks: { high: 5, low: 2 },
    });
    await ready(test);
    const opened = await create(test);
    const process = test.processes[0];

    process.emitData("123456");
    await vi.waitFor(() =>
      expect(
        test.events.filter(
          (event) => event.type === "terminal-view/render-batch",
        ),
      ).toHaveLength(1),
    );
    expect(process.pauseCount).toBe(0);
    expect(
      test.events.filter(
        (event) => event.type === "terminal-view/resync-required",
      ),
    ).toHaveLength(0);

    const batch = test.events.find(
      (event) => event.type === "terminal-view/render-batch",
    );
    if (!batch || batch.type !== "terminal-view/render-batch") {
      throw new Error("expected render batch");
    }
    process.emitData("more");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(process.pauseCount).toBe(0);
    expect(
      test.events.filter(
        (event) => event.type === "terminal-view/render-batch",
      ),
    ).toHaveLength(1);
    expect(
      test.events.filter(
        (event) => event.type === "terminal-view/resync-required",
      ),
    ).toHaveLength(0);

    await test.controller.handleRequest(test.connection, {
      type: "terminal-view/output-ack",
      ...target(test, opened),
      sequence: batch.sequence,
    });
    expect(
      test.events.filter(
        (event) => event.type === "terminal-view/resync-required",
      ),
    ).toHaveLength(1);

    await test.controller.handleRequest(test.connection, {
      type: "terminal-view/resync",
      rendererEpoch: test.connection.rendererEpoch,
    });
    const bootstrap = test.events
      .filter((event) => event.type === "terminal-view/bootstrap")
      .at(-1);
    if (!bootstrap || bootstrap.type !== "terminal-view/bootstrap") {
      throw new Error("expected bootstrap event");
    }
    expect(bootstrap.replay).toMatchObject([
      { terminalId: opened.terminalId, data: "123456more" },
    ]);

    process.emitData("!");
    await vi.waitFor(() =>
      expect(
        test.events.filter(
          (event) => event.type === "terminal-view/render-batch",
        ).length,
      ).toBeGreaterThan(1),
    );
  });

  it("drops already queued host batches after the high-water batch is delivered", async () => {
    const firstRender = deferred<boolean>();
    let blockFirstRender = true;
    const test = harness(snapshot(), {
      runtimeWatermarks: { high: 4, low: 2 },
      postSurfaceEvent: (event) => {
        if (blockFirstRender && event.type === "terminal-view/render-batch") {
          blockFirstRender = false;
          return firstRender.promise;
        }
        return true;
      },
    });
    await ready(test);
    const opened = await create(test);
    const process = test.processes[0];

    process.emitData("1234");
    process.emitData("queued-one");
    process.emitData("queued-two");
    await vi.waitFor(() =>
      expect(
        test.events.filter(
          (event) => event.type === "terminal-view/render-batch",
        ),
      ).toHaveLength(1),
    );

    firstRender.resolve(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      test.events.filter(
        (event) => event.type === "terminal-view/render-batch",
      ),
    ).toHaveLength(1);
    expect(process.pauseCount).toBe(0);
    expect(
      test.events.filter(
        (event) => event.type === "terminal-view/resync-required",
      ),
    ).toHaveLength(0);

    const batch = test.events.find(
      (event) => event.type === "terminal-view/render-batch",
    );
    if (!batch || batch.type !== "terminal-view/render-batch") {
      throw new Error("expected render batch");
    }
    await test.controller.handleRequest(test.connection, {
      type: "terminal-view/output-ack",
      ...target(test, opened),
      sequence: batch.sequence,
    });

    expect(test.events.at(-1)).toEqual({
      type: "terminal-view/resync-required",
      rendererEpoch: test.connection.rendererEpoch,
    });
  });

  it("replays retained output on renderer reattach and accepts acknowledgments", async () => {
    const test = harness();
    await ready(test);
    const opened = await create(test);
    test.processes[0].emitData("retained output");
    await Promise.resolve();
    await Promise.resolve();
    const batch = test.events.find(
      (event) => event.type === "terminal-view/render-batch",
    );
    if (!batch || batch.type !== "terminal-view/render-batch") {
      throw new Error("expected render batch");
    }
    await test.controller.handleRequest(test.connection, {
      type: "terminal-view/output-ack",
      ...target(test, opened),
      sequence: batch.sequence,
    });

    test.controller.detach(test.connection);
    const replayEvents: TerminalSurfaceEvent[] = [];
    const replacement = test.controller.attach(async (event) => {
      replayEvents.push(event);
      return true;
    });
    await test.controller.handleRequest(replacement, {
      type: "terminal-view/ready",
      protocolVersion: TERMINAL_SURFACE_PROTOCOL_VERSION,
    });

    expect(replayEvents[0]).toMatchObject({
      type: "terminal-view/bootstrap",
      replay: [
        {
          terminalId: opened.terminalId,
          data: "retained output",
        },
      ],
    });
  });

  it("disposes running PTYs and rejects in-flight work after disable", async () => {
    const test = harness();
    await ready(test);
    await create(test);

    test.setAccepting(false);
    test.controller.dispose();

    expect(test.processes[0].killCount).toBe(1);
    expect(test.processes[0].writes).toEqual([]);
  });
});
