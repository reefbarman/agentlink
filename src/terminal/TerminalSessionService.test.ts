import { describe, expect, it, vi } from "vitest";

import type { HostTerminalEvent } from "../core/terminalProtocol.js";
import type { ResolvedHostShellProfile } from "./shellProfileResolver.js";
import {
  TerminalSessionService,
  type HostPty,
  type HostPtyDisposable,
  type HostPtyExitEvent,
  type HostPtySpawnOptions,
} from "./TerminalSessionService.js";

class FakePty implements HostPty {
  readonly writes: string[] = [];
  readonly resizes: Array<[number, number]> = [];
  pauseCount = 0;
  resumeCount = 0;
  killCount = 0;
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(event: HostPtyExitEvent) => void>();

  onData(listener: (data: string) => void): HostPtyDisposable {
    this.dataListeners.add(listener);
    return { dispose: () => this.dataListeners.delete(listener) };
  }

  onExit(listener: (event: HostPtyExitEvent) => void): HostPtyDisposable {
    this.exitListeners.add(listener);
    return { dispose: () => this.exitListeners.delete(listener) };
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
    for (const listener of this.dataListeners) listener(data);
  }

  emitExit(event: HostPtyExitEvent): void {
    for (const listener of this.exitListeners) listener(event);
  }

  get dataListenerCount(): number {
    return this.dataListeners.size;
  }

  get exitListenerCount(): number {
    return this.exitListeners.size;
  }
}

function profile(
  overrides: Partial<ResolvedHostShellProfile> = {},
): ResolvedHostShellProfile {
  return {
    profileName: "zsh",
    provenance: "configured",
    shellPath: "/bin/zsh",
    shellArgs: ["-l"],
    environment: { PATH: "/usr/bin:/bin" },
    cwd: "/workspace",
    ...overrides,
  };
}

function launch(service: TerminalSessionService) {
  return service.create({
    requestId: "request-1",
    title: "zsh",
    profile: profile(),
    dimensions: { columns: 80, rows: 24 },
  });
}

function createHarness(options: { maxOutputBufferBytes?: number } = {}) {
  const ptys: FakePty[] = [];
  const spawnOptions: HostPtySpawnOptions[] = [];
  const service = new TerminalSessionService({
    maxOutputBufferBytes: options.maxOutputBufferBytes,
    ptyFactory: {
      spawn(options) {
        spawnOptions.push(options);
        const pty = new FakePty();
        ptys.push(pty);
        return pty;
      },
    },
  });
  const events: HostTerminalEvent[] = [];
  service.onEvent((event) => {
    events.push(event);
  });
  return { service, ptys, spawnOptions, events };
}

describe("TerminalSessionService", () => {
  it("spawns through the injected factory and emits an opened tab", () => {
    const { service, ptys, spawnOptions, events } = createHarness();

    const tab = launch(service);

    expect(tab).toEqual({
      id: "host-terminal-1",
      title: "zsh",
      cwd: "/workspace",
      profileName: "zsh",
      dimensions: { columns: 80, rows: 24 },
      status: "running",
    });
    expect(spawnOptions).toEqual([
      {
        shellPath: "/bin/zsh",
        shellArgs: ["-l"],
        cwd: "/workspace",
        environment: { PATH: "/usr/bin:/bin" },
        dimensions: { columns: 80, rows: 24 },
      },
    ]);
    expect(ptys[0].dataListenerCount).toBe(1);
    expect(ptys[0].exitListenerCount).toBe(1);
    expect(events).toEqual([{ type: "host-terminal/opened", terminal: tab }]);

    tab.dimensions.columns = 1;
    const opened = events[0];
    if (opened.type !== "host-terminal/opened") {
      throw new Error("Expected an opened event");
    }
    opened.terminal.dimensions.rows = 1;
    expect(service.getTerminal(tab.id)?.dimensions).toEqual({
      columns: 80,
      rows: 24,
    });
  });

  it("writes and resizes only running sessions", () => {
    const { service, ptys, events } = createHarness();
    const tab = launch(service);

    expect(service.write(tab.id, "echo hello\r")).toBe(true);
    expect(service.resize(tab.id, { columns: 120, rows: 40 })).toBe(true);
    expect(service.resize(tab.id, { columns: 0, rows: 40 })).toBe(false);
    expect(service.write("missing", "ignored")).toBe(false);

    expect(ptys[0].writes).toEqual(["echo hello\r"]);
    expect(ptys[0].resizes).toEqual([[120, 40]]);
    expect(service.getTerminal(tab.id)?.dimensions).toEqual({
      columns: 120,
      rows: 40,
    });
    expect(events.at(-1)).toEqual({
      type: "host-terminal/resized",
      terminalId: tab.id,
      dimensions: { columns: 120, rows: 40 },
    });
  });

  it("retains a byte-bounded complete UTF-8 tail and reports dropped bytes", () => {
    const { service, ptys, events } = createHarness({
      maxOutputBufferBytes: 7,
    });
    const tab = launch(service);

    ptys[0].emitData("abc");
    ptys[0].emitData("🙂def");

    expect(service.getOutput(tab.id)).toEqual({
      data: "🙂def",
      byteLength: 7,
      droppedBytes: 3,
      paused: false,
    });
    expect(events.slice(-2)).toEqual([
      { type: "host-terminal/data", terminalId: tab.id, data: "abc" },
      { type: "host-terminal/data", terminalId: tab.id, data: "🙂def" },
    ]);
  });

  it("pauses once on consumer backpressure and resumes explicitly", () => {
    const { service, ptys } = createHarness();
    const tab = launch(service);
    const received: string[] = [];
    const subscription = service.onEvent((event) => {
      if (event.type !== "host-terminal/data") return;
      received.push(event.data);
      return false;
    });

    ptys[0].emitData("one");
    ptys[0].emitData("two");

    expect(received).toEqual(["one", "two"]);
    expect(ptys[0].pauseCount).toBe(1);
    expect(service.getOutput(tab.id)?.paused).toBe(true);
    expect(service.resumeOutput(tab.id)).toBe(true);
    expect(service.resumeOutput(tab.id)).toBe(false);
    expect(ptys[0].resumeCount).toBe(1);

    subscription.dispose();
    ptys[0].emitData("three");
    expect(received).toEqual(["one", "two"]);
  });

  it("keeps exited output inspectable and rejects further mutation", () => {
    const { service, ptys, events } = createHarness();
    const tab = launch(service);
    ptys[0].emitData("finished");

    ptys[0].emitExit({ exitCode: 130, signal: 2 });

    expect(service.getTerminal(tab.id)).toMatchObject({
      status: "exited",
      exitCode: 130,
      signal: 2,
    });
    expect(service.getOutput(tab.id)?.data).toBe("finished");
    expect(service.write(tab.id, "ignored")).toBe(false);
    expect(service.resize(tab.id, { columns: 100, rows: 30 })).toBe(false);
    expect(service.resumeOutput(tab.id)).toBe(false);
    expect(ptys[0].dataListenerCount).toBe(0);
    expect(ptys[0].exitListenerCount).toBe(0);
    expect(events.at(-1)).toEqual({
      type: "host-terminal/exited",
      terminalId: tab.id,
      exitCode: 130,
      signal: 2,
    });
  });

  it("closes running and exited sessions idempotently", () => {
    const { service, ptys, events } = createHarness();
    const running = launch(service);
    const exited = launch(service);
    ptys[1].emitExit({ exitCode: 0 });

    expect(service.close(running.id)).toBe(true);
    expect(service.close(running.id)).toBe(false);
    expect(service.close(exited.id)).toBe(true);

    expect(ptys[0].killCount).toBe(1);
    expect(ptys[1].killCount).toBe(0);
    expect(ptys.every((pty) => pty.dataListenerCount === 0)).toBe(true);
    expect(ptys.every((pty) => pty.exitListenerCount === 0)).toBe(true);
    expect(service.getTerminals()).toEqual([]);
    expect(events.slice(-2)).toEqual([
      { type: "host-terminal/closed", terminalId: running.id },
      { type: "host-terminal/closed", terminalId: exited.id },
    ]);
  });

  it("disposes every session and prevents new listeners or launches", () => {
    const { service, ptys } = createHarness();
    launch(service);
    launch(service);

    service.dispose();
    service.dispose();

    expect(ptys.map((pty) => pty.killCount)).toEqual([1, 1]);
    expect(service.getTerminals()).toEqual([]);
    expect(() => launch(service)).toThrow("TerminalSessionService is disposed");
    expect(() => service.onEvent(() => undefined)).toThrow(
      "TerminalSessionService is disposed",
    );
  });

  it("isolates listener failures so disposal still cleans up every PTY", () => {
    const ptys: FakePty[] = [];
    const listenerError = new Error("listener failed");
    const onListenerError = vi.fn(() => {
      throw new Error("reporter failed");
    });
    const service = new TerminalSessionService({
      ptyFactory: {
        spawn() {
          const pty = new FakePty();
          ptys.push(pty);
          return pty;
        },
      },
      onListenerError,
    });
    service.onEvent((event) => {
      if (event.type === "host-terminal/closed") throw listenerError;
    });
    launch(service);
    launch(service);

    expect(() => service.dispose()).not.toThrow();

    expect(onListenerError).toHaveBeenCalledTimes(2);
    expect(onListenerError).toHaveBeenNthCalledWith(1, listenerError);
    expect(ptys.map((pty) => pty.killCount)).toEqual([1, 1]);
    expect(service.getTerminals()).toEqual([]);
  });

  it("emits request-scoped errors when spawning fails", () => {
    const spawnError = new Error("pty unavailable");
    const spawn = vi.fn((_options: HostPtySpawnOptions): HostPty => {
      throw spawnError;
    });
    const service = new TerminalSessionService({
      ptyFactory: { spawn },
    });
    const events: HostTerminalEvent[] = [];
    service.onEvent((event) => {
      events.push(event);
    });

    expect(() => launch(service)).toThrow(spawnError);
    expect(spawn).toHaveBeenCalledOnce();
    expect(events).toEqual([
      {
        type: "host-terminal/error",
        requestId: "request-1",
        message: "pty unavailable",
      },
    ]);
    expect(service.getTerminals()).toEqual([]);
  });

  it("cleans up a spawned PTY when listener registration fails", () => {
    const pty = new FakePty();
    const dataSubscription = pty.onData(() => undefined);
    const disposeData = vi.spyOn(dataSubscription, "dispose");
    pty.onData = vi.fn(() => dataSubscription);
    pty.onExit = vi.fn(() => {
      throw new Error("exit listener unavailable");
    });
    const service = new TerminalSessionService({
      ptyFactory: { spawn: () => pty },
    });
    const events: HostTerminalEvent[] = [];
    service.onEvent((event) => {
      events.push(event);
    });

    expect(() => launch(service)).toThrow("exit listener unavailable");
    expect(disposeData).toHaveBeenCalledOnce();
    expect(pty.killCount).toBe(1);
    expect(service.getTerminals()).toEqual([]);
    expect(events).toEqual([
      {
        type: "host-terminal/error",
        requestId: "request-1",
        message: "exit listener unavailable",
      },
    ]);
  });

  it("rejects invalid construction, dimensions, and generated IDs", () => {
    const factory = { spawn: vi.fn(() => new FakePty()) };
    expect(
      () =>
        new TerminalSessionService({
          ptyFactory: factory,
          maxOutputBufferBytes: 0,
        }),
    ).toThrow("maxOutputBufferBytes must be a positive safe integer");

    const invalidDimensions = new TerminalSessionService({
      ptyFactory: factory,
    });
    expect(() =>
      invalidDimensions.create({
        requestId: "request",
        title: "zsh",
        profile: profile(),
        dimensions: { columns: 0, rows: 24 },
      }),
    ).toThrow("Terminal dimensions must be positive integers");

    const duplicateId = new TerminalSessionService({
      ptyFactory: factory,
      createTerminalId: () => "duplicate",
    });
    launch(duplicateId);
    expect(() => launch(duplicateId)).toThrow(
      "createTerminalId must return a unique, non-empty ID",
    );
  });
});
