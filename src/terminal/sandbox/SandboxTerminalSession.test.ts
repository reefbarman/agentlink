import type {
  SandboxCommandDisposable,
  SandboxCommandEvent,
  SandboxCommandExit,
  SandboxCommandProcess,
  SandboxCommandReady,
} from "./SandboxRuntimeProvider.js";
import { describe, expect, it, vi } from "vitest";

import { SandboxTerminalSession } from "./SandboxTerminalSession.js";

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

function session(
  overrides: Partial<
    ConstructorParameters<typeof SandboxTerminalSession>[0]
  > = {},
) {
  let now = 100;
  const instance = new SandboxTerminalSession({
    channelId: "sandbox-1",
    title: "Sandbox",
    initialCwd: "/workspace",
    dimensions: { columns: 80, rows: 24 },
    now: () => now,
    isAllowedCwd: (cwd) => cwd.startsWith("/workspace"),
    ...overrides,
  });
  return {
    session: instance,
    setNow(value: number) {
      now = value;
    },
  };
}

function process(commandId: string, generation: number) {
  return new FakeProcess({
    channelId: "sandbox-1",
    commandId,
    generation,
  });
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("SandboxTerminalSession", () => {
  it("returns to idle while retaining history, output, and remembered cwd", async () => {
    const test = session();
    const first = process("command-1", 1);
    const events = vi.fn();
    test.session.onEvent(events);

    expect(
      test.session.startCommand({
        command: "cd subdir && pwd",
        cwd: "/workspace",
        origin: "agent",
        process: first,
      }),
    ).toMatchObject({ status: "launching", generation: 1 });
    expect(test.session.snapshot()).toMatchObject({
      status: "launching",
      activeCommandId: "command-1",
      nextGeneration: 2,
    });

    test.setNow(110);
    first.readyDeferred.resolve({
      pid: 123,
      pgid: 123,
      backend: "seatbelt",
    });
    await flush();
    first.emit({ type: "data", data: "/workspace/subdir\r\n" });
    first.emit({ type: "cwd", cwd: "/workspace/subdir", nonce: "nonce-1" });
    test.setNow(120);
    first.completionDeferred.resolve({ exitCode: 0, timedOut: false });
    await flush();

    expect(test.session.snapshot()).toMatchObject({
      status: "idle",
      cwd: "/workspace/subdir",
      replay: "$ cd subdir && pwd\r\n/workspace/subdir\r\n",
      commands: [
        {
          commandId: "command-1",
          status: "exited",
          readyAt: 110,
          finishedAt: 120,
          exitCode: 0,
          output: "/workspace/subdir\r\n",
          backend: "seatbelt",
        },
      ],
    });
    expect(events.mock.calls.map(([event]) => event.type)).toEqual([
      "command-started",
      "command-ready",
      "data",
      "cwd",
      "command-exited",
    ]);
  });

  it("requires fresh sequential generations and rejects a busy channel", async () => {
    const test = session();
    const first = process("command-1", 1);
    test.session.startCommand({
      command: "sleep 10",
      cwd: "/workspace",
      origin: "agent",
      process: first,
    });
    expect(() =>
      test.session.startCommand({
        command: "pwd",
        cwd: "/workspace",
        origin: "user",
        process: process("command-2", 2),
      }),
    ).toThrow("channel is busy");

    first.readyDeferred.resolve({ pid: 1, pgid: 1, backend: "seatbelt" });
    first.completionDeferred.resolve({ exitCode: 0, timedOut: false });
    await flush();

    expect(() =>
      test.session.startCommand({
        command: "pwd",
        cwd: "/workspace",
        origin: "user",
        process: process("command-stale", 1),
      }),
    ).toThrow("generation does not match");
    expect(
      test.session.startCommand({
        command: "pwd",
        cwd: "/workspace",
        origin: "user",
        process: process("command-2", 2),
      }),
    ).toMatchObject({ origin: "user", generation: 2 });
  });

  it("routes input and Ctrl+C only to the current running process", async () => {
    const test = session();
    const running = process("command-1", 1);
    test.session.startCommand({
      command: "cat",
      cwd: "/workspace",
      origin: "user",
      process: running,
    });

    expect(test.session.write("before ready")).toBe(false);
    expect(test.session.interrupt()).toBe(false);
    running.readyDeferred.resolve({ pid: 1, pgid: 1, backend: "seatbelt" });
    await flush();

    expect(test.session.write("hello\r")).toBe(true);
    expect(test.session.interrupt()).toBe(true);
    expect(test.session.resize({ columns: 120, rows: 40 })).toBe(true);
    expect(running.write).toHaveBeenCalledWith("hello\r");
    expect(running.interrupt).toHaveBeenCalledTimes(1);
    expect(running.resize).toHaveBeenCalledWith({ columns: 120, rows: 40 });

    running.completionDeferred.resolve({
      exitCode: 130,
      signal: 2,
      timedOut: false,
    });
    await flush();
    expect(test.session.write("after exit")).toBe(false);
    expect(test.session.interrupt()).toBe(false);
  });

  it("ignores disallowed cwd and stale process events", async () => {
    const test = session();
    const first = process("command-1", 1);
    test.session.startCommand({
      command: "pwd",
      cwd: "/workspace",
      origin: "agent",
      process: first,
    });
    first.readyDeferred.resolve({ pid: 1, pgid: 1, backend: "seatbelt" });
    await flush();
    first.emit({ type: "cwd", cwd: "/private/tmp/command", nonce: "nonce" });
    first.completionDeferred.resolve({ exitCode: 0, timedOut: false });
    await flush();

    const second = process("command-2", 2);
    test.session.startCommand({
      command: "pwd",
      cwd: "/workspace",
      origin: "agent",
      process: second,
    });
    first.emit({ type: "data", data: "stale" });
    first.completionDeferred.reject(new Error("late failure"));
    await flush();

    expect(test.session.snapshot()).toMatchObject({
      cwd: "/workspace",
      status: "launching",
      activeCommandId: "command-2",
    });
    expect(test.session.snapshot().replay).not.toContain("stale");
  });

  it("retains UTF-8 tails and evicts old command metadata within bounds", async () => {
    const test = session({ maxReplayBytes: 5, maxCommands: 1 });
    const first = process("command-1", 1);
    test.session.startCommand({
      command: "printf first",
      cwd: "/workspace",
      origin: "agent",
      process: first,
    });
    first.readyDeferred.resolve({ pid: 1, pgid: 1, backend: "seatbelt" });
    await flush();
    first.emit({ type: "data", data: "a€bc" });
    first.completionDeferred.resolve({ exitCode: 0, timedOut: false });
    await flush();

    const second = process("command-2", 2);
    test.session.startCommand({
      command: "printf second",
      cwd: "/workspace",
      origin: "ai-staged",
      process: second,
    });
    second.readyDeferred.resolve({ pid: 2, pgid: 2, backend: "seatbelt" });
    await flush();
    second.emit({ type: "data", data: "€de" });

    const snapshot = test.session.snapshot();
    expect(Buffer.byteLength(snapshot.replay, "utf8")).toBeLessThanOrEqual(5);
    expect(snapshot.replay).not.toContain("�");
    expect(snapshot.droppedReplayBytes).toBeGreaterThan(0);
    expect(snapshot.commands).toHaveLength(1);
    expect(snapshot.commands[0]).toMatchObject({
      commandId: "command-2",
      origin: "ai-staged",
    });
  });

  it("records violations and isolates listener failures", async () => {
    const listenerError = vi.fn();
    const test = session({ onListenerError: listenerError });
    const running = process("command-1", 1);
    const healthyListener = vi.fn();
    test.session.onEvent(() => {
      throw new Error("listener failed");
    });
    test.session.onEvent(healthyListener);
    test.session.startCommand({
      command: "curl localhost",
      cwd: "/workspace",
      origin: "agent",
      process: running,
    });
    running.readyDeferred.resolve({ pid: 1, pgid: 1, backend: "seatbelt" });
    await flush();
    running.emit({
      type: "violation",
      violation: {
        operation: "network-connect",
        target: "127.0.0.1",
        reason: "private target denied",
        occurredAt: 100,
      },
    });

    expect(listenerError).toHaveBeenCalled();
    expect(healthyListener).toHaveBeenCalledWith(
      expect.objectContaining({ type: "violation" }),
    );
    expect(test.session.snapshot().commands[0].violations).toHaveLength(1);
  });

  it("fails the active command once and closes all process authority", async () => {
    const test = session();
    const failing = process("command-1", 1);
    test.session.startCommand({
      command: "false",
      cwd: "/workspace",
      origin: "agent",
      process: failing,
    });
    failing.readyDeferred.reject(new Error("helper failed"));
    failing.completionDeferred.reject(new Error("helper failed"));
    await flush();

    expect(test.session.snapshot().commands[0]).toMatchObject({
      status: "failed",
      error: "helper failed",
    });

    const active = process("command-2", 2);
    test.session.startCommand({
      command: "sleep 10",
      cwd: "/workspace",
      origin: "agent",
      process: active,
    });
    test.session.close();
    expect(active.dispose).toHaveBeenCalledTimes(1);
    expect(test.session.snapshot().status).toBe("closed");
    expect(() =>
      test.session.startCommand({
        command: "pwd",
        cwd: "/workspace",
        origin: "user",
        process: process("command-3", 3),
      }),
    ).toThrow("session is closed");
  });
});
