/** @vitest-environment jsdom */

import { waitFor } from "@testing-library/preact";
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
    anchors: [],
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
  readonly isBracketedPasteMode = vi.fn(() => false);
  readonly updateConfiguration = vi.fn();
  readonly dispose = vi.fn();
  readonly findNext = vi.fn(() => true);
  readonly findPrevious = vi.fn(() => true);
  readonly registerBlockBoundary = vi.fn(() => true);
  readonly retainBlockAnchors = vi.fn();
  readonly scrollToBlock = vi.fn(() => true);
  readonly writes: Array<{ data: string; source: "live" | "replay" }> = [];
  readonly pendingWrites: Array<() => void> = [];
  fitDimensions = { columns: 80, rows: 24 };
  deferWrites = false;

  constructor(readonly callbacks: TerminalRendererCallbacks) {}

  write(data: string, source: "live" | "replay" = "live"): Promise<void> {
    this.writes.push({ data, source });
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

function mountView(
  controller: TerminalWebviewController,
  { focused }: { focused: boolean },
): { setFocused(focused: boolean): void } {
  const listeners = new Map<string, () => void>();
  controller.mount({
    document: { hasFocus: () => focused },
    addEventListener: (type: string, listener: (...args: never[]) => void) =>
      void listeners.set(type, listener as () => void),
    removeEventListener: (type: string) => void listeners.delete(type),
  });
  return {
    setFocused: (nowFocused) =>
      listeners.get(nowFocused ? "focus" : "blur")?.(),
  };
}

beforeEach(() => vi.restoreAllMocks());

describe("TerminalWebviewController", () => {
  it("announces readiness and uses unique IDs for explicit requests", () => {
    const test = harness();
    const listeners = new Map<string, () => void>();
    const addEventListener = vi.fn((type: string, listener: () => void) =>
      listeners.set(type, listener),
    );
    const removeEventListener = vi.fn((type: string) => listeners.delete(type));

    const unmount = test.controller.mount({
      document: { hasFocus: () => true },
      addEventListener,
      removeEventListener,
    });
    expect(test.postMessage).toHaveBeenCalledWith({
      type: "terminal-view/ready",
      protocolVersion: TERMINAL_SURFACE_PROTOCOL_VERSION,
    });
    expect(test.postMessage).toHaveBeenCalledWith({
      type: "terminal-view/focus-changed",
      focused: true,
    });
    listeners.get("focus")?.();
    listeners.get("blur")?.();
    expect(test.postMessage).toHaveBeenCalledWith({
      type: "terminal-view/focus-changed",
      focused: true,
    });
    expect(test.postMessage).toHaveBeenCalledWith({
      type: "terminal-view/focus-changed",
      focused: false,
    });
    expect(
      test.postMessage.mock.calls.some(
        ([message]) => message.type === "host-terminal/create",
      ),
    ).toBe(false);

    test.controller.createTerminal();
    test.controller.createTerminal();
    expect(
      test.postMessage.mock.calls
        .map(([message]) => message)
        .filter((message) => message.type === "host-terminal/create"),
    ).toEqual([
      {
        type: "host-terminal/create",
        requestId: "terminal-create-1-unique-1",
      },
      {
        type: "host-terminal/create",
        requestId: "terminal-create-2-unique-2",
      },
    ]);

    unmount();
    expect(removeEventListener).toHaveBeenCalledWith(
      "message",
      expect.any(Function),
    );
    expect(removeEventListener).toHaveBeenCalledWith(
      "focus",
      expect.any(Function),
    );
    expect(removeEventListener).toHaveBeenCalledWith(
      "blur",
      expect.any(Function),
    );
  });

  it("retains multiple tabs from sequential New Terminal lifecycles", async () => {
    const test = harness();
    await test.controller.receive(bootstrap([], []));

    await test.controller.receive({
      type: "host-terminal/opened",
      terminalInstanceId: "instance-1",
      terminal: tab("terminal-1"),
    });
    await test.controller.receive({
      type: "host-terminal/opened",
      terminalInstanceId: "instance-2",
      terminal: tab("terminal-2"),
    });

    expect(test.controller.getSnapshot()).toMatchObject({
      tabs: [
        { id: "terminal-1", terminalInstanceId: "instance-1" },
        { id: "terminal-2", terminalInstanceId: "instance-2" },
      ],
      activeTabId: "terminal-2",
      creating: false,
    });
    expect(test.factory.create).toHaveBeenCalledTimes(2);
  });

  it("opens agent terminals quietly and tracks running and unread activity", async () => {
    const test = harness();
    mountView(test.controller, { focused: true });
    await test.controller.receive(
      bootstrap([tab("terminal-1")], [replay("terminal-1", "instance-1")]),
    );
    const initialFocusRequest = test.controller.getSnapshot().focusRequest;
    expect(initialFocusRequest).toBe(1);

    await test.controller.receive({
      type: "host-terminal/opened",
      terminalInstanceId: "agent-instance-1",
      activate: false,
      terminal: {
        ...tab("agent-1"),
        channelKind: "agent-native",
      },
    });
    expect(test.controller.getSnapshot()).toMatchObject({
      activeTabId: "terminal-1",
      focusRequest: initialFocusRequest,
    });

    await test.controller.receive({
      type: "host-terminal/agent-activity",
      terminalId: "agent-1",
      terminalInstanceId: "agent-instance-1",
      activity: "running",
    });
    await test.controller.receive({
      type: "host-terminal/activated",
      terminalId: "agent-1",
      terminalInstanceId: "agent-instance-1",
    });
    expect(test.controller.getSnapshot()).toMatchObject({
      activeTabId: "agent-1",
      focusRequest: initialFocusRequest,
      tabs: [{ id: "terminal-1" }, { id: "agent-1", agentActivity: "running" }],
    });

    await test.controller.receive({
      type: "host-terminal/activated",
      terminalId: "terminal-1",
      terminalInstanceId: "instance-1",
    });
    await test.controller.receive({
      type: "host-terminal/agent-activity",
      terminalId: "agent-1",
      terminalInstanceId: "agent-instance-1",
      activity: "unread",
    });
    expect(test.controller.getSnapshot().tabs).toEqual([
      expect.objectContaining({ id: "terminal-1" }),
      expect.objectContaining({ id: "agent-1", agentActivity: "unread" }),
    ]);

    test.controller.selectTerminal("agent-1");
    await test.controller.receive({
      type: "host-terminal/activated",
      terminalId: "agent-1",
      terminalInstanceId: "agent-instance-1",
    });
    expect(test.controller.getSnapshot()).toMatchObject({
      activeTabId: "agent-1",
      focusRequest: initialFocusRequest + 1,
      tabs: [{ id: "terminal-1" }, { id: "agent-1" }],
    });
  });

  it("never requests focus while the terminal view is unfocused", async () => {
    const test = harness();
    const view = mountView(test.controller, { focused: false });

    await test.controller.receive(
      bootstrap([tab("terminal-1")], [replay("terminal-1", "instance-1")]),
    );
    expect(test.controller.getSnapshot()).toMatchObject({
      activeTabId: "terminal-1",
      focusRequest: 0,
    });

    await test.controller.receive({
      type: "host-terminal/opened",
      terminalInstanceId: "instance-2",
      terminal: tab("terminal-2"),
    });
    expect(test.controller.getSnapshot()).toMatchObject({
      activeTabId: "terminal-2",
      focusRequest: 0,
    });

    view.setFocused(true);
    await test.controller.receive({
      type: "host-terminal/opened",
      terminalInstanceId: "instance-3",
      terminal: tab("terminal-3"),
    });
    expect(test.controller.getSnapshot()).toMatchObject({
      activeTabId: "terminal-3",
      focusRequest: 1,
    });
  });

  it("does not take focus when an agent terminal opens into an empty unfocused view", async () => {
    const test = harness();
    mountView(test.controller, { focused: false });
    await test.controller.receive(bootstrap([], []));

    await test.controller.receive({
      type: "host-terminal/opened",
      terminalInstanceId: "agent-instance-1",
      activate: false,
      terminal: { ...tab("agent-1"), channelKind: "agent-native" },
    });
    expect(test.controller.getSnapshot()).toMatchObject({
      activeTabId: "agent-1",
      focusRequest: 0,
    });
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

    test.renderers[0].callbacks.onPaste(true);
    expect(test.postMessage).toHaveBeenCalledWith({
      type: "host-terminal/paste-intent",
      terminalId: "terminal-1",
      terminalInstanceId: "instance-1",
      rendererEpoch: "renderer-1",
      bracketedPasteMode: true,
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

    test.renderers[0].isBracketedPasteMode.mockReturnValue(false);
    test.controller.respondToConfirmation(true);
    expect(test.postMessage).toHaveBeenCalledWith({
      type: "terminal-view/confirm",
      terminalId: "terminal-1",
      terminalInstanceId: "instance-1",
      rendererEpoch: "renderer-1",
      confirmationId: "confirmation-1",
      accept: true,
      bracketedPasteMode: false,
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
    expect(test.renderers[0].writes).toEqual([
      { data: "retained output", source: "replay" },
    ]);

    await test.controller.receive({
      ...event,
      replay: [replay("terminal-1", "instance-1", "new bounded replay", 4)],
    });
    expect(test.factory.create).toHaveBeenCalledOnce();
    expect(test.renderers[0].reset).toHaveBeenCalledOnce();
    expect(test.renderers[0].writes).toEqual([
      { data: "retained output", source: "replay" },
    ]);
    expect(test.renderers[0].retainBlockAnchors).toHaveBeenLastCalledWith(
      new Set(),
    );
    expect(test.renderers[0].updateConfiguration).toHaveBeenCalledWith({
      scrollback: 1000,
    });
  });

  it("waits until the selected pane is visible before fitting and ignores inactive resizes", async () => {
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
    test.controller.attachContainer(
      "terminal-1",
      document.createElement("div"),
    );
    test.controller.attachContainer(
      "terminal-2",
      document.createElement("div"),
    );
    test.postMessage.mockClear();

    test.renderers[1].fitDimensions = { columns: 7, rows: 2 };
    test.resizeCallbacks[1]();
    test.controller.selectTerminal("terminal-2");

    expect(test.postMessage).toHaveBeenCalledOnce();
    expect(test.postMessage).toHaveBeenLastCalledWith({
      type: "host-terminal/activate",
      terminalId: "terminal-2",
      terminalInstanceId: "instance-2",
      rendererEpoch: "renderer-1",
    });
    expect(test.renderers[1].focus).not.toHaveBeenCalled();

    test.renderers[0].fitDimensions = { columns: 5, rows: 2 };
    test.resizeCallbacks[0]();
    test.renderers[1].fitDimensions = { columns: 120, rows: 40 };
    test.controller.fitActive();

    expect(test.postMessage).toHaveBeenCalledTimes(2);
    expect(test.postMessage).toHaveBeenLastCalledWith({
      type: "host-terminal/resize",
      terminalId: "terminal-2",
      terminalInstanceId: "instance-2",
      rendererEpoch: "renderer-1",
      dimensions: { columns: 120, rows: 40 },
    });
    expect(test.renderers[1].focus).not.toHaveBeenCalled();

    test.controller.focusActive();
    expect(test.renderers[1].focus).toHaveBeenCalledOnce();
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

    await test.controller.receive({
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
    expect(renderer.writes).toEqual([{ data: "first", source: "live" }]);
    expect(renderer.registerBlockBoundary).not.toHaveBeenCalled();
    expect(test.postMessage).not.toHaveBeenCalled();

    renderer.resolveNextWrite();
    await Promise.resolve();
    expect(renderer.registerBlockBoundary).toHaveBeenCalledWith(
      "block-1",
      "command-start",
    );
    expect(renderer.writes).toEqual([
      { data: "first", source: "live" },
      { data: "second", source: "live" },
    ]);
    expect(test.postMessage).not.toHaveBeenCalled();

    renderer.resolveNextWrite();
    await Promise.resolve();
    await Promise.resolve();
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

  it("joins consecutive write operations into a single xterm write", async () => {
    const test = harness();
    await test.controller.receive(bootstrap());
    const renderer = test.renderers[0];
    test.postMessage.mockClear();

    await test.controller.receive({
      type: "terminal-view/render-batch",
      terminalId: "terminal-1",
      terminalInstanceId: "instance-1",
      sequence: 1,
      operations: [
        { type: "write", data: "one " },
        { type: "write", data: "two" },
        {
          type: "block-boundary",
          boundary: "command-start",
          blockId: "block-1",
        },
        { type: "write", data: "three " },
        { type: "write", data: "four" },
      ],
      droppedRenderBytes: 0,
      replayTruncated: false,
      replayPendingControl: false,
      suppressedOutputCharacters: 0,
      outputPolicyDecisions: [],
    });
    await waitFor(() =>
      expect(test.postMessage).toHaveBeenCalledWith({
        type: "terminal-view/output-ack",
        terminalId: "terminal-1",
        terminalInstanceId: "instance-1",
        rendererEpoch: "renderer-1",
        sequence: 1,
      }),
    );

    // One write-callback wait per run of writes, with the block boundary
    // still registered at its position between the runs.
    expect(renderer.writes).toEqual([
      { data: "one two", source: "live" },
      { data: "three four", source: "live" },
    ]);
    expect(renderer.registerBlockBoundary).toHaveBeenCalledWith(
      "block-1",
      "command-start",
    );
  });

  it("drains a terminal render before applying its exit and close lifecycle", async () => {
    const test = harness();
    await test.controller.receive(bootstrap());
    const renderer = test.renderers[0];
    renderer.deferWrites = true;

    await test.controller.receive({
      type: "terminal-view/render-batch",
      terminalId: "terminal-1",
      terminalInstanceId: "instance-1",
      sequence: 1,
      operations: [{ type: "write", data: "final output" }],
      droppedRenderBytes: 0,
      replayTruncated: false,
      replayPendingControl: false,
      suppressedOutputCharacters: 0,
      outputPolicyDecisions: [],
    });
    await test.controller.receive({
      type: "host-terminal/exited",
      terminalId: "terminal-1",
      terminalInstanceId: "instance-1",
      exitCode: 0,
    });
    await test.controller.receive({
      type: "host-terminal/closed",
      terminalId: "terminal-1",
      terminalInstanceId: "instance-1",
    });

    expect(test.controller.getSnapshot().tabs[0].status).toBe("running");
    expect(renderer.dispose).not.toHaveBeenCalled();
    renderer.resolveNextWrite();
    await waitFor(() => expect(renderer.dispose).toHaveBeenCalledOnce());
    expect(test.controller.getSnapshot().tabs).toEqual([]);
  });

  it("does not block another terminal lifecycle behind a slow render", async () => {
    const test = harness();
    await test.controller.receive(bootstrap());
    const renderer = test.renderers[0];
    renderer.deferWrites = true;

    await test.controller.receive({
      type: "terminal-view/render-batch",
      terminalId: "terminal-1",
      terminalInstanceId: "instance-1",
      sequence: 1,
      operations: [{ type: "write", data: "slow echo" }],
      droppedRenderBytes: 0,
      replayTruncated: false,
      replayPendingControl: false,
      suppressedOutputCharacters: 0,
      outputPolicyDecisions: [],
    });
    await Promise.resolve();
    expect(renderer.pendingWrites).toHaveLength(1);

    await test.controller.receive({
      type: "host-terminal/opened",
      terminalInstanceId: "instance-2",
      terminal: tab("terminal-2"),
    });

    expect(test.controller.getSnapshot()).toMatchObject({
      tabs: [{ id: "terminal-1" }, { id: "terminal-2" }],
      activeTabId: "terminal-2",
    });
    renderer.resolveNextWrite();
    await Promise.resolve();
    await Promise.resolve();
  });

  it("does not warn when live output rolls beyond retained replay", async () => {
    const test = harness();
    await test.controller.receive(bootstrap());

    await test.controller.receive({
      type: "terminal-view/render-batch",
      terminalId: "terminal-1",
      terminalInstanceId: "instance-1",
      sequence: 1,
      operations: [{ type: "write", data: "current output" }],
      droppedRenderBytes: 1_229_865,
      replayTruncated: true,
      replayPendingControl: false,
      suppressedOutputCharacters: 0,
      outputPolicyDecisions: [],
    });

    expect(
      test.controller.getSnapshot().replayWarnings["terminal-1"],
    ).toBeUndefined();
  });

  it("does not warn when recovery history exceeds retained scrollback", async () => {
    const test = harness();
    const snapshot = replay("terminal-1", "instance-1", "recent history", 1);
    await test.controller.receive({
      ...bootstrap(
        [tab()],
        [
          {
            ...snapshot,
            droppedBytes: 1_229_865,
            replayTruncated: true,
          },
        ],
      ),
      rendererEpoch: "renderer-2",
    });

    expect(
      test.controller.getSnapshot().replayWarnings["terminal-1"],
    ).toBeUndefined();
  });

  it("warns when recovery ends with an incomplete control sequence", async () => {
    const test = harness();
    const snapshot = replay("terminal-1", "instance-1", "recent history", 1);
    await test.controller.receive({
      ...bootstrap(
        [tab()],
        [
          {
            ...snapshot,
            replayPendingControl: true,
          },
        ],
      ),
      rendererEpoch: "renderer-2",
    });

    expect(test.controller.getSnapshot().replayWarnings["terminal-1"]).toBe(
      "Earlier terminal output could not be restored completely.",
    );
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

  it("projects the renderer's sticky block and reveals it on demand", async () => {
    const test = harness();
    await test.controller.receive(bootstrap());
    const renderer = test.renderers[0];

    renderer.callbacks.onStickyBlockChanged("block-1");
    expect(
      test.controller.getSnapshot().blockStates["terminal-1"]?.stickyBlockId,
    ).toBe("block-1");

    test.controller.revealBlock("terminal-1", "block-1");
    expect(renderer.scrollToBlock).toHaveBeenCalledWith("block-1");

    renderer.callbacks.onStickyBlockChanged(undefined);
    expect(
      test.controller.getSnapshot().blockStates["terminal-1"]?.stickyBlockId,
    ).toBeUndefined();

    test.controller.revealBlock("missing-terminal", "block-1");
    expect(renderer.scrollToBlock).toHaveBeenCalledTimes(1);
  });

  it("re-registers block markers at replay anchors during bootstrap", async () => {
    const test = harness();
    const snapshot = replay("terminal-1", "instance-1", "$ hello\r\n$ ", 3);
    const anchoredSnapshot: typeof snapshot = {
      ...snapshot,
      blocks: {
        ...snapshot.blocks,
        mode: "integrated",
        blocks: [
          {
            id: "host-block-1",
            kind: "prompt",
            cwd: "/workspace",
            status: "closed",
            output: "$ ",
            outputBytes: 2,
            droppedOutputBytes: 0,
          },
          {
            id: "host-block-2",
            kind: "command",
            cwd: "/workspace",
            command: "echo hello",
            status: "exited",
            exitCode: 0,
            output: "hello\r\n",
            outputBytes: 7,
            droppedOutputBytes: 0,
          },
        ],
      },
      presentation: {
        alternateScreen: false,
        terminalRunning: true,
        blocks: [
          { blockId: "host-block-1", decoration: "completed", actions: [] },
          { blockId: "host-block-2", decoration: "completed", actions: [] },
        ],
      },
      anchors: [
        { blockId: "host-block-1", offset: 0 },
        { blockId: "host-block-2", offset: 2 },
        { blockId: "unknown-block", offset: 4 },
        { blockId: "host-block-1", offset: 99 },
      ],
    };
    await test.controller.receive(bootstrap([tab()], [anchoredSnapshot]));
    await waitFor(() =>
      expect(test.renderers[0].writes.length).toBeGreaterThanOrEqual(2),
    );

    expect(test.renderers[0].writes).toEqual([
      { data: "$ ", source: "replay" },
      { data: "hello\r\n$ ", source: "replay" },
    ]);
    expect(test.renderers[0].registerBlockBoundary).toHaveBeenNthCalledWith(
      1,
      "host-block-1",
      "prompt-start",
    );
    expect(test.renderers[0].registerBlockBoundary).toHaveBeenNthCalledWith(
      2,
      "host-block-2",
      "command-start",
    );
    expect(test.renderers[0].registerBlockBoundary).toHaveBeenCalledTimes(2);
    await waitFor(() =>
      expect(
        test.controller
          .getSnapshot()
          .blockStates["terminal-1"]?.blocks.map((block) => block.anchored),
      ).toEqual([true, true]),
    );
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

  it("drops queued stale batches before an authoritative resync replay", async () => {
    const test = harness();
    await test.controller.receive(bootstrap());
    const renderer = test.renderers[0];
    renderer.reset.mockClear();
    renderer.writes.length = 0;
    renderer.deferWrites = true;
    test.postMessage.mockClear();

    const batch = (sequence: number, data: string) => ({
      type: "terminal-view/render-batch" as const,
      terminalId: "terminal-1",
      terminalInstanceId: "instance-1",
      sequence,
      operations: [{ type: "write" as const, data }],
      droppedRenderBytes: 0,
      replayTruncated: false,
      replayPendingControl: false,
      suppressedOutputCharacters: 0,
      outputPolicyDecisions: [],
    });
    await test.controller.receive(batch(1, "parsing stale"));
    await test.controller.receive(batch(2, "queued stale"));
    await Promise.resolve();
    expect(renderer.writes).toEqual([
      { data: "parsing stale", source: "live" },
    ]);

    await test.controller.receive({
      type: "terminal-view/resync-required",
      rendererEpoch: "renderer-1",
    });
    await test.controller.receive(
      bootstrap(
        [tab()],
        [replay("terminal-1", "instance-1", "authoritative replay", 2)],
      ),
    );
    renderer.resolveNextWrite();
    await waitFor(() => expect(renderer.reset).toHaveBeenCalledOnce());
    expect(renderer.writes).toEqual([
      { data: "parsing stale", source: "live" },
      { data: "authoritative replay", source: "replay" },
    ]);
    expect(
      test.postMessage.mock.calls.some(
        ([message]) =>
          message.type === "terminal-view/output-ack" && message.sequence <= 2,
      ),
    ).toBe(false);
    renderer.resolveNextWrite();
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
    expect(test.renderers[0].writes).toEqual([
      { data: "authoritative replay", source: "replay" },
    ]);
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
