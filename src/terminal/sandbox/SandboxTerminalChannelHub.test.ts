import { describe, expect, it, vi } from "vitest";

import { SandboxTerminalChannelHub } from "./SandboxTerminalChannelHub.js";
import type {
  SandboxTerminalChannelEvent,
  SandboxTerminalCoordinator,
} from "./SandboxTerminalCoordinator.js";
import type { SandboxTerminalSessionSnapshot } from "./SandboxTerminalSession.js";

function snapshot(
  status: SandboxTerminalSessionSnapshot["status"] = "idle",
  channelId = "sandbox-1",
) {
  return {
    channelId,
    title: "Sandbox",
    cwd: "/workspace",
    dimensions: { columns: 80, rows: 24 },
    status,
    nextGeneration: 2,
    replay: "hello",
    replayBytes: 5,
    droppedReplayBytes: 0,
    commands: [],
  } satisfies SandboxTerminalSessionSnapshot;
}

function commandStartedEvent(
  origin: "agent" | "user" | "ai-staged",
  channelId = "sandbox-1",
): SandboxTerminalChannelEvent {
  return {
    event: {
      type: "command-started",
      command: {
        commandId: "command-1",
        generation: 1,
        command: "pwd",
        cwd: "/workspace",
        origin,
        status: "launching",
        startedAt: 1,
        output: "",
        outputBytes: 0,
        droppedOutputBytes: 0,
        violations: [],
      },
    },
    snapshot: {
      ...snapshot("launching", channelId),
      activeCommandId: "command-1",
      commands: [
        {
          commandId: "command-1",
          generation: 1,
          command: "pwd",
          cwd: "/workspace",
          origin,
          status: "launching",
          startedAt: 1,
          output: "",
          outputBytes: 0,
          droppedOutputBytes: 0,
          violations: [],
        },
      ],
    },
  };
}

function coordinator(channelId = "sandbox-1") {
  let listener: ((event: SandboxTerminalChannelEvent) => void) | undefined;
  let disposeListener: (() => void) | undefined;
  const instance = {
    listTerminals: vi.fn(() => [
      { id: channelId, name: "Sandbox", busy: false },
    ]),
    getChannelSnapshot: vi.fn(() => snapshot("idle", channelId)),
    onChannelEvent: vi.fn((next) => {
      listener = next;
      return { dispose: vi.fn() };
    }),
    onDispose: vi.fn((next: () => void) => {
      disposeListener = next;
      return { dispose: vi.fn() };
    }),
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
  return {
    instance: instance as unknown as SandboxTerminalCoordinator,
    emit(event: SandboxTerminalChannelEvent) {
      listener?.(event);
    },
    emitDispose() {
      disposeListener?.();
    },
    mocks: instance,
  };
}

describe("SandboxTerminalChannelHub", () => {
  it("projects coordinator channels and launches user commands with terminal attribution", async () => {
    const test = coordinator();
    const hub = new SandboxTerminalChannelHub();
    const updates = vi.fn();
    hub.subscribe(updates);
    hub.attach(test.instance);

    expect(hub.listSnapshots()).toEqual([snapshot()]);
    test.emit({
      event: { type: "resized", dimensions: { columns: 100, rows: 30 } },
      snapshot: { ...snapshot(), dimensions: { columns: 100, rows: 30 } },
    });
    expect(updates).toHaveBeenCalledTimes(1);
    expect(hub.resize("sandbox-1", { columns: 90, rows: 20 })).toBe(true);
    expect(hub.write("sandbox-1", "input")).toBe(true);
    expect(hub.interrupt("sandbox-1")).toBe(true);

    await hub.executeUserCommand({
      channelId: "sandbox-1",
      command: "git status",
      cwd: "/workspace",
    });
    expect(test.mocks.executeCommand).toHaveBeenCalledWith({
      command: "git status",
      cwd: "/workspace",
      terminal_id: "sandbox-1",
      sandboxSessionId: "terminal-user:sandbox-1",
      background: true,
    });
  });

  it("requests a reveal only when an agent command starts", () => {
    const onAgentCommandStarted = vi.fn();
    const hub = new SandboxTerminalChannelHub({ onAgentCommandStarted });
    const test = coordinator();
    hub.attach(test.instance);

    test.emit(commandStartedEvent("user"));
    test.emit(commandStartedEvent("ai-staged"));
    expect(onAgentCommandStarted).not.toHaveBeenCalled();

    test.emit(commandStartedEvent("agent"));
    expect(onAgentCommandStarted).toHaveBeenCalledOnce();
    expect(onAgentCommandStarted).toHaveBeenCalledWith("sandbox-1");
  });

  it("isolates reveal callback failures and continues delivering events", () => {
    const callbackError = new Error("focus failed");
    const onCallbackError = vi.fn();
    const hub = new SandboxTerminalChannelHub({
      onAgentCommandStarted: () => {
        throw callbackError;
      },
      onCallbackError,
    });
    const updates = vi.fn();
    const test = coordinator();
    hub.subscribe(updates);
    hub.attach(test.instance);

    const update = commandStartedEvent("agent");
    expect(() => test.emit(update)).not.toThrow();
    expect(onCallbackError).toHaveBeenCalledOnce();
    expect(onCallbackError).toHaveBeenCalledWith(callbackError);
    expect(updates).toHaveBeenCalledOnce();
    expect(updates).toHaveBeenCalledWith(update);
  });

  it("detaches from disposed coordinators and fails closed until replacement", async () => {
    const hub = new SandboxTerminalChannelHub();
    const first = coordinator();
    hub.attach(first.instance);

    first.emitDispose();

    expect(hub.listSnapshots()).toEqual([]);
    expect(hub.write("sandbox-1", "stale")).toBe(false);
    await expect(
      hub.executeUserCommand({
        channelId: "sandbox-1",
        command: "pwd",
        cwd: "/workspace",
      }),
    ).rejects.toThrow("sandbox terminal is unavailable");

    const replacement = coordinator("sandbox-2");
    hub.attach(replacement.instance);
    expect(hub.write("sandbox-2", "current")).toBe(true);
    expect(first.mocks.write).not.toHaveBeenCalled();
    expect(replacement.mocks.write).toHaveBeenCalledWith(
      "sandbox-2",
      "current",
    );
  });

  it("keeps retired and replacement channels independently controllable", () => {
    const hub = new SandboxTerminalChannelHub();
    const first = coordinator("sandbox-old");
    const replacement = coordinator("sandbox-new");
    hub.attach(first.instance);
    hub.attach(replacement.instance);

    expect(hub.write("sandbox-old", "old input")).toBe(true);
    expect(hub.write("sandbox-new", "new input")).toBe(true);
    expect(first.mocks.write).toHaveBeenCalledWith("sandbox-old", "old input");
    expect(replacement.mocks.write).toHaveBeenCalledWith(
      "sandbox-new",
      "new input",
    );

    first.emitDispose();
    expect(hub.write("sandbox-old", "stale")).toBe(false);
    expect(hub.write("sandbox-new", "still current")).toBe(true);
  });

  it("removes closed snapshots and fails closed before a coordinator exists", async () => {
    const hub = new SandboxTerminalChannelHub();
    await expect(
      hub.executeUserCommand({
        channelId: "sandbox-1",
        command: "pwd",
        cwd: "/workspace",
      }),
    ).rejects.toThrow("sandbox terminal is unavailable");

    const test = coordinator();
    hub.attach(test.instance);
    test.emit({
      event: { type: "closed" },
      snapshot: snapshot("closed"),
    });
    expect(hub.listSnapshots()).toEqual([]);
  });
});
