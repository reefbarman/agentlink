import type {
  HostShellBootstrapPlan,
  MaterializedHostShellBootstrap,
} from "./hostShellBootstrap.js";
import type { NodePtyModule, NodePtyProcess } from "./nodePtyFactory.js";
import type {
  SandboxTerminalChannelEvent,
  SandboxTerminalCoordinator,
} from "./sandbox/SandboxTerminalCoordinator.js";
import { describe, expect, it, vi } from "vitest";

import { LiveHostTerminalSurfaceController } from "./LiveHostTerminalSurfaceController.js";
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
  const controller = new LiveHostTerminalSurfaceController({
    host: { platform: "darwin" },
    runtimeRoot: "/runtime/host-terminal",
    nodePtyLoader: { load },
    getConfigurationSnapshot,
    getSurfaceConfiguration: () => ({ scrollback: 2000 }),
    isAcceptingRequests: () => accepting,
    createId: () => `identifier_${nextId++}_1234567890`,
    openExternal,
    openNativeTerminal,
    readClipboard,
    writeClipboard,
    sandboxChannelHub: options.sandboxChannelHub,
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

function shellMarker(kind: string, payload?: string): string {
  const nonce = "identifier_5_1234567890";
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

function target(
  test: ReturnType<typeof harness>,
  opened: { terminalId: string; terminalInstanceId: string },
) {
  return {
    ...opened,
    rendererEpoch: test.connection.rendererEpoch,
  };
}

describe("LiveHostTerminalSurfaceController", () => {
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
    expect(sandbox.coordinator.interruptTerminal).toHaveBeenCalledWith(
      "sandbox-1",
    );
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
    expect(sandbox.coordinator.closeTerminals).toHaveBeenCalledWith([
      "sandbox-1",
    ]);
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
        configuration: { scrollback: 2000 },
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
    const test = harness(snapshot(), { clipboardText: "echo one\necho two\n" });
    await ready(test);
    const opened = await create(test);

    await test.controller.handleRequest(test.connection, {
      type: "host-terminal/paste-intent",
      ...target(test, opened),
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
    expect(test.processes[0].writes).toEqual(["echo one\necho two\n"]);
    await test.controller.handleRequest(test.connection, {
      type: "terminal-view/confirm",
      ...target(test, opened),
      confirmationId: requested.confirmationId,
      accept: true,
    });
    expect(test.processes[0].writes).toEqual(["echo one\necho two\n"]);
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

  it("pauses at the render high-water mark and resumes after acknowledgment", async () => {
    const test = harness(snapshot(), {
      runtimeWatermarks: { high: 5, low: 2 },
    });
    await ready(test);
    const opened = await create(test);
    const process = test.processes[0];

    process.emitData("123456");
    await vi.waitFor(() => expect(process.pauseCount).toBe(1));
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

    expect(process.resumeCount).toBe(1);
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
