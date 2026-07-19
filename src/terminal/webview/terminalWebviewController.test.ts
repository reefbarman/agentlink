/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { HostTerminalTab } from "../../core/terminalProtocol.js";
import {
  TERMINAL_SURFACE_PROTOCOL_VERSION,
  type HostTerminalReplaySnapshot,
  type TerminalSurfaceConfiguration,
  type TerminalSurfaceEvent,
} from "../terminalSurfaceProtocol.js";
import {
  TerminalWebviewController,
  type TerminalRenderer,
  type TerminalRendererCallbacks,
  type TerminalRendererFactory,
} from "./terminalWebviewController.js";

function tab(id = "terminal-1"): HostTerminalTab {
  return {
    id,
    title: `Terminal ${id.at(-1)}`,
    cwd: "/workspace",
    profileName: "zsh",
    dimensions: { columns: 80, rows: 24 },
    status: "running",
  };
}

function replay(
  terminalId = "terminal-1",
  terminalInstanceId = "instance-1",
  data = "",
  sequence = 0,
): HostTerminalReplaySnapshot {
  return {
    terminalId,
    terminalInstanceId,
    sequence,
    data,
    byteLength: data.length,
    droppedBytes: 0,
    replayTruncated: false,
    replayPendingControl: false,
    blocks: {
      blocks: [],
      currentCwd: "/workspace",
      mode: "raw",
      droppedBlocks: 0,
      nextBlockNumber: 1,
      maxBlockOutputBytes: 1024,
      maxBlocks: 20,
    },
    presentation: {
      alternateScreen: false,
      terminalRunning: true,
      blocks: [],
    },
  };
}

function bootstrap(
  tabs: HostTerminalTab[] = [tab()],
  snapshots: HostTerminalReplaySnapshot[] = [replay()],
): TerminalSurfaceEvent {
  return {
    type: "terminal-view/bootstrap",
    protocolVersion: TERMINAL_SURFACE_PROTOCOL_VERSION,
    rendererEpoch: "renderer-1",
    state: { tabs, activeTabId: tabs[0]?.id },
    configuration: { scrollback: 1000 },
    replay: snapshots,
  };
}

class FakeRenderer implements TerminalRenderer {
  readonly open = vi.fn();
  readonly reset = vi.fn();
  readonly focus = vi.fn();
  readonly clearSearch = vi.fn();
  readonly updateConfiguration = vi.fn();
  readonly dispose = vi.fn();
  readonly findNext = vi.fn(() => true);
  readonly findPrevious = vi.fn(() => true);
  readonly registerBlockBoundary = vi.fn(() => true);
  readonly retainBlockAnchors = vi.fn();
  readonly writes: string[] = [];
  readonly pendingWrites: Array<() => void> = [];
  fitDimensions = { columns: 80, rows: 24 };
  deferWrites = false;

  constructor(readonly callbacks: TerminalRendererCallbacks) {}

  write(data: string): Promise<void> {
    this.writes.push(data);
    if (!this.deferWrites) return Promise.resolve();
    return new Promise((resolve) => this.pendingWrites.push(resolve));
  }

  fit() {
    return this.fitDimensions;
  }

  resolveNextWrite(): void {
    this.pendingWrites.shift()?.();
  }
}

function harness() {
  const postMessage = vi.fn();
  const renderers: FakeRenderer[] = [];
  const factory: TerminalRendererFactory = {
    create: vi.fn(
      (
        _configuration: TerminalSurfaceConfiguration,
        callbacks: TerminalRendererCallbacks,
      ) => {
        const renderer = new FakeRenderer(callbacks);
        renderers.push(renderer);
        return renderer;
      },
    ),
  };
  const resizeCallbacks: Array<() => void> = [];
  const disconnect = vi.fn();
  let requestNumber = 0;
  const controller = new TerminalWebviewController({
    vscodeApi: { postMessage },
    rendererFactory: factory,
    createRequestId: () => `unique-${++requestNumber}`,
    createResizeObserver: (callback) => {
      resizeCallbacks.push(callback);
      return { observe: vi.fn(), disconnect };
    },
  });
  return {
    controller,
    disconnect,
    factory,
    postMessage,
    renderers,
    resizeCallbacks,
  };
}

beforeEach(() => vi.restoreAllMocks());

describe("TerminalWebviewController", () => {
  it("announces readiness and uses unique IDs for explicit requests", () => {
    const test = harness();
    const addEventListener = vi.fn();
    const removeEventListener = vi.fn();

    const unmount = test.controller.mount({
      addEventListener,
      removeEventListener,
    });
    expect(test.postMessage).toHaveBeenCalledWith({
      type: "terminal-view/ready",
      protocolVersion: TERMINAL_SURFACE_PROTOCOL_VERSION,
    });
    expect(
      test.postMessage.mock.calls.some(
        ([message]) => message.type === "host-terminal/create",
      ),
    ).toBe(false);

    test.controller.createTerminal();
    test.controller.createTerminal();
    expect(test.postMessage).toHaveBeenNthCalledWith(2, {
      type: "host-terminal/create",
      requestId: "terminal-create-1-unique-1",
    });
    expect(test.postMessage).toHaveBeenNthCalledWith(3, {
      type: "host-terminal/create",
      requestId: "terminal-create-2-unique-2",
    });

    unmount();
    expect(removeEventListener).toHaveBeenCalledWith(
      "message",
      expect.any(Function),
    );
  });

  it("creates one terminal after the initial empty bootstrap only", async () => {
    const test = harness();

    await test.controller.receive(bootstrap([], []));
    expect(test.postMessage).toHaveBeenCalledWith({
      type: "host-terminal/create",
      requestId: "terminal-create-1-unique-1",
    });
    expect(test.controller.getSnapshot()).toMatchObject({ creating: true });

    await test.controller.receive({
      ...bootstrap([], []),
      rendererEpoch: "renderer-2",
    });
    expect(
      test.postMessage.mock.calls.filter(
        ([message]) => message.type === "host-terminal/create",
      ),
    ).toHaveLength(1);
  });

  it("requests one authoritative replay for a current host resync signal", async () => {
    const test = harness();
    await test.controller.receive(bootstrap());
    test.postMessage.mockClear();

    await test.controller.receive({
      type: "terminal-view/resync-required",
      rendererEpoch: "stale-renderer",
    });
    await test.controller.receive({
      type: "terminal-view/resync-required",
      rendererEpoch: "renderer-1",
    });
    await test.controller.receive({
      type: "terminal-view/resync-required",
      rendererEpoch: "renderer-1",
    });

    expect(test.postMessage).toHaveBeenCalledTimes(1);
    expect(test.postMessage).toHaveBeenCalledWith({
      type: "terminal-view/resync",
      rendererEpoch: "renderer-1",
    });
  });

  it("does not auto-create when the initial bootstrap has a fallback", async () => {
    const test = harness();

    await test.controller.receive({
      ...bootstrap([], []),
      fallback: {
        reason: "native-shell-required",
        message: "Use the native terminal.",
      },
    });

    expect(
      test.postMessage.mock.calls.some(
        ([message]) => message.type === "host-terminal/create",
      ),
    ).toBe(false);
  });

  it("retains one renderer per host tab and targets input, activation, and close", async () => {
    const test = harness();
    await test.controller.receive(
      bootstrap(
        [tab("terminal-1"), tab("terminal-2")],
        [
          replay("terminal-1", "instance-1"),
          replay("terminal-2", "instance-2"),
        ],
      ),
    );
    expect(test.factory.create).toHaveBeenCalledTimes(2);

    test.controller.attachContainer(
      "terminal-1",
      document.createElement("div"),
    );
    test.renderers[0].callbacks.onData("echo hello\r");
    test.controller.selectTerminal("terminal-2");
    test.controller.closeTerminal("terminal-2");

    expect(test.postMessage).toHaveBeenCalledWith({
      type: "host-terminal/write",
      terminalId: "terminal-1",
      terminalInstanceId: "instance-1",
      rendererEpoch: "renderer-1",
      data: "echo hello\r",
    });
    expect(test.postMessage).toHaveBeenCalledWith({
      type: "host-terminal/activate",
      terminalId: "terminal-2",
      terminalInstanceId: "instance-2",
      rendererEpoch: "renderer-1",
    });
    expect(test.postMessage).toHaveBeenCalledWith({
      type: "host-terminal/close-intent",
      terminalId: "terminal-2",
      terminalInstanceId: "instance-2",
      rendererEpoch: "renderer-1",
    });
    expect(test.factory.create).toHaveBeenCalledTimes(2);
    expect(test.renderers[0].dispose).not.toHaveBeenCalled();
  });

  it("routes paste gestures and one-use confirmation responses without webview paste data", async () => {
    const test = harness();
    await test.controller.receive(bootstrap());
    test.postMessage.mockClear();

    test.renderers[0].callbacks.onPaste();
    expect(test.postMessage).toHaveBeenCalledWith({
      type: "host-terminal/paste-intent",
      terminalId: "terminal-1",
      terminalInstanceId: "instance-1",
      rendererEpoch: "renderer-1",
    });

    await test.controller.receive({
      type: "terminal-view/confirmation",
      confirmationId: "confirmation-1",
      terminalId: "terminal-1",
      terminalInstanceId: "instance-1",
      operation: "paste",
      title: "Paste multiple lines?",
      message: "Pasting may run commands.",
      confirmLabel: "Paste",
    });
    expect(test.controller.getSnapshot().confirmation).toMatchObject({
      confirmationId: "confirmation-1",
      operation: "paste",
    });

    await test.controller.receive({
      type: "terminal-view/confirmation-cancelled",
      confirmationId: "another-confirmation",
    });
    expect(test.controller.getSnapshot().confirmation).toBeDefined();

    test.controller.respondToConfirmation(true);
    expect(test.postMessage).toHaveBeenCalledWith({
      type: "terminal-view/confirm",
      terminalId: "terminal-1",
      terminalInstanceId: "instance-1",
      rendererEpoch: "renderer-1",
      confirmationId: "confirmation-1",
      accept: true,
    });
    expect(test.controller.getSnapshot().confirmation).toBeUndefined();
    expect(
      test.postMessage.mock.calls.some(
        ([message]) => "data" in message && message.data.includes("Pasting"),
      ),
    ).toBe(false);
  });

  it("ignores confirmation events for stale terminal identities", async () => {
    const test = harness();
    await test.controller.receive(bootstrap());

    await test.controller.receive({
      type: "terminal-view/confirmation",
      confirmationId: "confirmation-stale",
      terminalId: "terminal-1",
      terminalInstanceId: "stale-instance",
      operation: "close",
      title: "Close?",
      message: "stale",
      confirmLabel: "Close",
    });

    expect(test.controller.getSnapshot().confirmation).toBeUndefined();
  });

  it("retains live renderer state across repeated bootstrap events", async () => {
    const test = harness();
    const event = bootstrap(
      [tab()],
      [replay("terminal-1", "instance-1", "retained output", 3)],
    );

    await test.controller.receive(event);
    expect(test.renderers[0].reset).toHaveBeenCalledOnce();
    expect(test.renderers[0].writes).toEqual(["retained output"]);

    await test.controller.receive({
      ...event,
      replay: [replay("terminal-1", "instance-1", "new bounded replay", 4)],
    });
    expect(test.factory.create).toHaveBeenCalledOnce();
    expect(test.renderers[0].reset).toHaveBeenCalledOnce();
    expect(test.renderers[0].writes).toEqual(["retained output"]);
    expect(test.renderers[0].retainBlockAnchors).toHaveBeenLastCalledWith(
      new Set(),
    );
    expect(test.renderers[0].updateConfiguration).toHaveBeenCalledWith({
      scrollback: 1000,
    });
  });

  it("fits observed containers and sends only changed positive integer dimensions", async () => {
    const test = harness();
    await test.controller.receive(bootstrap());
    test.postMessage.mockClear();

    test.controller.attachContainer(
      "terminal-1",
      document.createElement("div"),
    );
    expect(test.postMessage).not.toHaveBeenCalled();

    test.renderers[0].fitDimensions = { columns: 100, rows: 30 };
    test.resizeCallbacks[0]();
    test.resizeCallbacks[0]();
    test.renderers[0].fitDimensions = { columns: 0, rows: 30 };
    test.resizeCallbacks[0]();
    test.renderers[0].fitDimensions = { columns: 100.5, rows: 30 };
    test.resizeCallbacks[0]();

    expect(test.postMessage).toHaveBeenCalledTimes(1);
    expect(test.postMessage).toHaveBeenCalledWith({
      type: "host-terminal/resize",
      terminalId: "terminal-1",
      terminalInstanceId: "instance-1",
      rendererEpoch: "renderer-1",
      dimensions: { columns: 100, rows: 30 },
    });
  });

  it("acknowledges a render batch only after all xterm writes finish serially", async () => {
    const test = harness();
    await test.controller.receive(bootstrap());
    const renderer = test.renderers[0];
    renderer.deferWrites = true;
    test.postMessage.mockClear();

    const rendered = test.controller.receive({
      type: "terminal-view/render-batch",
      terminalId: "terminal-1",
      terminalInstanceId: "instance-1",
      sequence: 1,
      operations: [
        { type: "write", data: "first" },
        {
          type: "block-boundary",
          boundary: "command-start",
          blockId: "block-1",
        },
        { type: "write", data: "second" },
        {
          type: "presentation",
          alternateScreen: false,
          blocks: [
            {
              blockId: "block-1",
              decoration: "active",
              actions: ["interrupt-command"],
            },
          ],
        },
      ],
      droppedRenderBytes: 0,
      replayTruncated: false,
      replayPendingControl: false,
      suppressedOutputCharacters: 0,
      outputPolicyDecisions: [],
    });

    await Promise.resolve();
    expect(renderer.writes).toEqual(["first"]);
    expect(renderer.registerBlockBoundary).not.toHaveBeenCalled();
    expect(test.postMessage).not.toHaveBeenCalled();

    renderer.resolveNextWrite();
    await Promise.resolve();
    expect(renderer.registerBlockBoundary).toHaveBeenCalledWith(
      "block-1",
      "command-start",
    );
    expect(renderer.writes).toEqual(["first", "second"]);
    expect(test.postMessage).not.toHaveBeenCalled();

    renderer.resolveNextWrite();
    await rendered;
    expect(test.controller.getSnapshot().blockStates["terminal-1"]).toEqual({
      mode: "integrated",
      alternateScreen: false,
      terminalRunning: true,
      blocks: [
        {
          blockId: "block-1",
          kind: "command",
          decoration: "active",
          actions: ["interrupt-command"],
          anchored: true,
        },
      ],
    });
    expect(test.postMessage).toHaveBeenCalledWith({
      type: "terminal-view/output-ack",
      terminalId: "terminal-1",
      terminalInstanceId: "instance-1",
      rendererEpoch: "renderer-1",
      sequence: 1,
    });

    test.postMessage.mockClear();
    test.controller.runBlockAction(
      "terminal-1",
      "block-1",
      "interrupt-command",
    );
    expect(test.postMessage).toHaveBeenCalledWith({
      type: "terminal-view/action",
      terminalId: "terminal-1",
      terminalInstanceId: "instance-1",
      rendererEpoch: "renderer-1",
      blockId: "block-1",
      action: "interrupt-command",
    });
    test.controller.runBlockAction("terminal-1", "block-1", "rerun-command");
    expect(test.postMessage).toHaveBeenCalledTimes(1);
  });

  it("projects replayed raw blocks as detached and routes only advertised actions", async () => {
    const test = harness();
    const base = replay();
    const snapshot: HostTerminalReplaySnapshot = {
      ...base,
      blocks: {
        ...base.blocks,
        blocks: [
          {
            id: "host-block-1",
            kind: "raw",
            cwd: "/workspace",
            output: "retained output",
            outputBytes: 15,
            droppedOutputBytes: 0,
          },
        ],
      },
      presentation: {
        ...base.presentation,
        blocks: [
          {
            blockId: "host-block-1",
            decoration: "undecorated",
            actions: ["copy-output"],
          },
        ],
      },
    };
    await test.controller.receive(bootstrap([tab()], [snapshot]));

    expect(test.controller.getSnapshot().blockStates["terminal-1"]).toEqual({
      mode: "raw",
      alternateScreen: false,
      terminalRunning: true,
      blocks: [
        {
          blockId: "host-block-1",
          kind: "raw",
          decoration: "undecorated",
          actions: ["copy-output"],
          anchored: false,
        },
      ],
    });
    test.postMessage.mockClear();
    test.controller.runBlockAction("terminal-1", "host-block-1", "copy-output");
    test.controller.runBlockAction(
      "terminal-1",
      "host-block-1",
      "rerun-command",
    );
    expect(test.postMessage).toHaveBeenCalledTimes(1);
    expect(test.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "terminal-view/action",
        action: "copy-output",
      }),
    );
  });

  it("suspends all block actions during alternate-screen state and restores only host-advertised actions", async () => {
    const test = harness();
    await test.controller.receive(bootstrap());
    await test.controller.receive({
      type: "terminal-view/render-batch",
      terminalId: "terminal-1",
      terminalInstanceId: "instance-1",
      sequence: 1,
      operations: [
        {
          type: "block-boundary",
          boundary: "command-start",
          blockId: "block-1",
        },
        {
          type: "presentation",
          alternateScreen: false,
          blocks: [
            {
              blockId: "block-1",
              decoration: "active",
              actions: ["interrupt-command"],
            },
          ],
        },
      ],
      droppedRenderBytes: 0,
      replayTruncated: false,
      replayPendingControl: false,
      suppressedOutputCharacters: 0,
      outputPolicyDecisions: [],
    });
    await test.controller.receive({
      type: "terminal-view/render-batch",
      terminalId: "terminal-1",
      terminalInstanceId: "instance-1",
      sequence: 2,
      operations: [
        {
          type: "alternate-screen",
          transition: { type: "enter", modes: [1049] },
        },
      ],
      droppedRenderBytes: 0,
      replayTruncated: false,
      replayPendingControl: false,
      suppressedOutputCharacters: 0,
      outputPolicyDecisions: [],
    });

    expect(
      test.controller.getSnapshot().blockStates["terminal-1"],
    ).toMatchObject({
      alternateScreen: true,
      blocks: [{ decoration: "hidden", actions: [] }],
    });
    test.postMessage.mockClear();
    test.controller.runBlockAction(
      "terminal-1",
      "block-1",
      "interrupt-command",
    );
    expect(test.postMessage).not.toHaveBeenCalled();

    await test.controller.receive({
      type: "terminal-view/render-batch",
      terminalId: "terminal-1",
      terminalInstanceId: "instance-1",
      sequence: 3,
      operations: [
        {
          type: "alternate-screen",
          transition: { type: "exit", modes: [1049] },
        },
        {
          type: "presentation",
          alternateScreen: false,
          blocks: [
            {
              blockId: "block-1",
              decoration: "active",
              actions: ["interrupt-command"],
            },
          ],
        },
      ],
      droppedRenderBytes: 0,
      replayTruncated: false,
      replayPendingControl: false,
      suppressedOutputCharacters: 0,
      outputPolicyDecisions: [],
    });
    expect(
      test.controller.getSnapshot().blockStates["terminal-1"],
    ).toMatchObject({
      alternateScreen: false,
      blocks: [{ decoration: "active", actions: ["interrupt-command"] }],
    });
  });

  it("downgrades evicted marker anchors without removing host block state", async () => {
    const test = harness();
    await test.controller.receive(bootstrap());
    await test.controller.receive({
      type: "terminal-view/render-batch",
      terminalId: "terminal-1",
      terminalInstanceId: "instance-1",
      sequence: 1,
      operations: [
        {
          type: "block-boundary",
          boundary: "command-start",
          blockId: "block-1",
        },
        {
          type: "presentation",
          alternateScreen: false,
          blocks: [
            {
              blockId: "block-1",
              decoration: "active",
              actions: ["interrupt-command"],
            },
          ],
        },
      ],
      droppedRenderBytes: 0,
      replayTruncated: false,
      replayPendingControl: false,
      suppressedOutputCharacters: 0,
      outputPolicyDecisions: [],
    });
    expect(
      test.controller.getSnapshot().blockStates["terminal-1"]?.blocks[0]
        ?.anchored,
    ).toBe(true);

    test.renderers[0].callbacks.onBlockAnchorDisposed("block-1");

    expect(
      test.controller.getSnapshot().blockStates["terminal-1"]?.blocks[0],
    ).toMatchObject({
      blockId: "block-1",
      anchored: false,
      actions: ["interrupt-command"],
    });

    await test.controller.receive({
      type: "terminal-view/render-batch",
      terminalId: "terminal-1",
      terminalInstanceId: "instance-1",
      sequence: 2,
      operations: [
        { type: "presentation", alternateScreen: false, blocks: [] },
      ],
      droppedRenderBytes: 0,
      replayTruncated: false,
      replayPendingControl: false,
      suppressedOutputCharacters: 0,
      outputPolicyDecisions: [],
    });
    expect(test.renderers[0].retainBlockAnchors).toHaveBeenCalledWith(
      new Set(),
    );
    expect(
      test.controller.getSnapshot().blockStates["terminal-1"]?.blocks,
    ).toEqual([]);
  });

  it("requests one resync without writing or acknowledging a sequence gap", async () => {
    const test = harness();
    await test.controller.receive(bootstrap());
    test.postMessage.mockClear();

    const gap = {
      type: "terminal-view/render-batch" as const,
      terminalId: "terminal-1",
      terminalInstanceId: "instance-1",
      sequence: 2,
      operations: [{ type: "write" as const, data: "missing-prefix" }],
      droppedRenderBytes: 0,
      replayTruncated: false,
      replayPendingControl: false,
      suppressedOutputCharacters: 0,
      outputPolicyDecisions: [],
    };
    await test.controller.receive(gap);
    await test.controller.receive(gap);

    expect(test.renderers[0].writes).toEqual([]);
    expect(test.postMessage).toHaveBeenCalledTimes(1);
    expect(test.postMessage).toHaveBeenCalledWith({
      type: "terminal-view/resync",
      rendererEpoch: "renderer-1",
    });
    expect(
      test.postMessage.mock.calls.some(
        ([message]) => message.type === "terminal-view/output-ack",
      ),
    ).toBe(false);
  });

  it("resets and replays retained renderers after a requested resync", async () => {
    const test = harness();
    await test.controller.receive(bootstrap());
    test.renderers[0].reset.mockClear();
    test.renderers[0].writes.length = 0;

    await test.controller.receive({
      type: "terminal-view/render-batch",
      terminalId: "terminal-1",
      terminalInstanceId: "instance-1",
      sequence: 2,
      operations: [{ type: "write", data: "gap" }],
      droppedRenderBytes: 0,
      replayTruncated: false,
      replayPendingControl: false,
      suppressedOutputCharacters: 0,
      outputPolicyDecisions: [],
    });
    await test.controller.receive(
      bootstrap(
        [tab()],
        [replay("terminal-1", "instance-1", "authoritative replay", 2)],
      ),
    );

    expect(test.factory.create).toHaveBeenCalledOnce();
    expect(test.renderers[0].reset).toHaveBeenCalledOnce();
    expect(test.renderers[0].writes).toEqual(["authoritative replay"]);
  });

  it("applies configuration, lifecycle state, local search, and disposal", async () => {
    const test = harness();
    await test.controller.receive(bootstrap());

    await test.controller.receive({
      type: "terminal-view/config",
      configuration: { scrollback: 2000, cursorStyle: "line" },
    });
    await test.controller.receive({
      type: "host-terminal/cwd",
      terminalId: "terminal-1",
      terminalInstanceId: "instance-1",
      cwd: "/workspace/next",
    });
    await test.controller.receive({
      type: "host-terminal/exited",
      terminalId: "terminal-1",
      terminalInstanceId: "instance-1",
      exitCode: 7,
    });

    expect(test.renderers[0].updateConfiguration).toHaveBeenCalledWith({
      scrollback: 2000,
      cursorStyle: "line",
    });
    expect(test.controller.getSnapshot().tabs[0]).toMatchObject({
      cwd: "/workspace/next",
      status: "exited",
      exitCode: 7,
    });
    expect(test.controller.findNext("needle")).toBe(true);
    expect(test.controller.findPrevious("needle")).toBe(true);
    test.controller.clearSearch();
    expect(test.renderers[0].findNext).toHaveBeenCalledWith("needle");
    expect(test.renderers[0].findPrevious).toHaveBeenCalledWith("needle");
    expect(test.renderers[0].clearSearch).toHaveBeenCalled();

    await test.controller.receive({
      type: "host-terminal/closed",
      terminalId: "terminal-1",
      terminalInstanceId: "instance-1",
    });
    expect(test.renderers[0].dispose).toHaveBeenCalledOnce();
    expect(test.controller.getSnapshot().tabs).toEqual([]);
  });

  it("ignores stale lifecycle identities and stale create errors", async () => {
    const test = harness();
    await test.controller.receive(bootstrap());
    test.controller.createTerminal();
    test.controller.createTerminal();

    await test.controller.receive({
      type: "host-terminal/error",
      requestId: "terminal-create-1-unique-1",
      message: "stale",
    });
    await test.controller.receive({
      type: "host-terminal/closed",
      terminalId: "terminal-1",
      terminalInstanceId: "stale-instance",
    });

    expect(test.controller.getSnapshot()).toMatchObject({
      creating: true,
      error: undefined,
    });
    expect(test.renderers[0].dispose).not.toHaveBeenCalled();
  });
});
