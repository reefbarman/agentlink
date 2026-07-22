import { describe, expect, it, vi } from "vitest";

import {
  SandboxHelperClient,
  type SandboxHelperTransport,
} from "./SandboxHelperClient.js";
import {
  SANDBOX_HELPER_PROTOCOL_VERSION,
  type SandboxHelperEventFrame,
  type SandboxHelperLaunchRequest,
} from "./sandboxHelperProtocol.js";

const request: SandboxHelperLaunchRequest = {
  version: SANDBOX_HELPER_PROTOCOL_VERSION,
  type: "launch",
  channelId: "channel-1",
  commandId: "command-1",
  generation: 1,
  command: "npm test",
  cwd: "/workspace",
  shell: "/bin/zsh",
  environment: { HOME: "/private/tmp/home", TMPDIR: "/private/tmp/tmp" },
  filesystem: {
    denyRead: [],
    allowRead: ["/workspace", "/usr"],
    allowWrite: ["/workspace", "/private/tmp"],
    denyWrite: ["/workspace/.git"],
  },
  network: { mode: "blocked" },
  protectedRoots: ["/workspace/.git/config"],
  structurallyProtectedRoots: ["/workspace/.git"],
  dimensions: { columns: 80, rows: 24 },
};

class FakeTransport implements SandboxHelperTransport {
  readonly writes: string[] = [];
  readonly kill = vi.fn();
  readonly dispose = vi.fn();
  acceptWrites = true;

  private readonly lineListeners = new Set<(line: string) => void>();
  private readonly errorListeners = new Set<(error: Error) => void>();
  private readonly closeListeners = new Set<
    (event: { exitCode: number | null; signal: string | null }) => void
  >();

  write(data: string): boolean {
    this.writes.push(data);
    return this.acceptWrites;
  }

  onLine(listener: (line: string) => void) {
    this.lineListeners.add(listener);
    return { dispose: () => this.lineListeners.delete(listener) };
  }

  onError(listener: (error: Error) => void) {
    this.errorListeners.add(listener);
    return { dispose: () => this.errorListeners.delete(listener) };
  }

  onClose(
    listener: (event: {
      exitCode: number | null;
      signal: string | null;
    }) => void,
  ) {
    this.closeListeners.add(listener);
    return { dispose: () => this.closeListeners.delete(listener) };
  }

  emit(event: SandboxHelperEventFrame): void {
    const line = JSON.stringify(event);
    for (const listener of this.lineListeners) listener(line);
  }

  emitLine(line: string): void {
    for (const listener of this.lineListeners) listener(line);
  }

  emitError(error: Error): void {
    for (const listener of this.errorListeners) listener(error);
  }

  emitClose(
    exitCode: number | null,
    signal: string | null,
    stderr?: string,
  ): void {
    for (const listener of this.closeListeners) {
      listener({ exitCode, signal, ...(stderr ? { stderr } : {}) });
    }
  }
}

function harness() {
  const transports: FakeTransport[] = [];
  const client = new SandboxHelperClient({
    create() {
      const transport = new FakeTransport();
      transports.push(transport);
      return transport;
    },
  });
  return { client, transports };
}

function parsedWrites(transport: FakeTransport) {
  return transport.writes.map((write) => JSON.parse(write));
}

function ready(
  transport: FakeTransport,
  overrides: Partial<SandboxHelperEventFrame> = {},
): void {
  transport.emit({
    channelId: request.channelId,
    commandId: request.commandId,
    generation: request.generation,
    type: "ready",
    pid: 123,
    pgid: 123,
    backend: "seatbelt",
    ...overrides,
  } as SandboxHelperEventFrame);
}

describe("SandboxHelperClient", () => {
  it("sends launch first and enables controls only after trusted readiness", async () => {
    const test = harness();
    const process = test.client.launch(request);
    const transport = test.transports[0];

    expect(parsedWrites(transport)).toEqual([request]);
    expect(process.write("before ready")).toBe(false);
    expect(process.resize({ columns: 100, rows: 30 })).toBe(false);
    expect(process.interrupt()).toBe(false);

    ready(transport);
    await expect(process.ready).resolves.toEqual({
      pid: 123,
      pgid: 123,
      backend: "seatbelt",
    });

    expect(process.write("hello\r")).toBe(true);
    expect(process.resize({ columns: 100, rows: 30 })).toBe(true);
    expect(process.interrupt()).toBe(true);
    expect(parsedWrites(transport).slice(1)).toEqual([
      { ...process.identity, type: "input", data: "hello\r" },
      {
        ...process.identity,
        type: "resize",
        dimensions: { columns: 100, rows: 30 },
      },
      { ...process.identity, type: "interrupt" },
    ]);
  });

  it("delivers coalesced ready, data, and exit in trusted lifecycle order", async () => {
    const test = harness();
    const process = test.client.launch(request);
    const transport = test.transports[0];
    const order: string[] = [];
    process.ready.then(() => order.push("ready"));
    process.onEvent((event) => order.push(event.type));
    process.completion.then(() => order.push("completion"));

    ready(transport);
    transport.emit({
      ...process.identity,
      type: "data",
      data: "coalesced output",
    });
    transport.emit({
      ...process.identity,
      type: "exit",
      exitCode: 0,
      timedOut: false,
    });
    await Promise.all([process.ready, process.completion]);
    await Promise.resolve();

    expect(order).toEqual(["ready", "data", "completion"]);
  });

  it("replays command events emitted before the first consumer subscribes", async () => {
    const test = harness();
    const process = test.client.launch(request);
    const transport = test.transports[0];
    ready(transport);
    transport.emit({
      ...process.identity,
      type: "data",
      data: "immediate output",
    });
    transport.emit({
      ...process.identity,
      type: "exit",
      exitCode: 0,
      timedOut: false,
    });
    await process.completion;
    const events = vi.fn();

    process.onEvent(events);
    expect(events).not.toHaveBeenCalled();
    await Promise.resolve();

    expect(events).toHaveBeenCalledWith({
      type: "data",
      data: "immediate output",
    });
  });

  it("forwards current events and ignores stale command generations", async () => {
    const test = harness();
    const process = test.client.launch(request);
    const transport = test.transports[0];
    const events = vi.fn();
    process.onEvent(events);
    ready(transport);
    await process.ready;

    transport.emit({
      ...process.identity,
      generation: process.identity.generation + 1,
      type: "data",
      data: "stale",
    });
    transport.emit({ ...process.identity, type: "data", data: "current" });
    transport.emit({
      ...process.identity,
      type: "cwd",
      cwd: "/workspace/subdir",
      nonce: "nonce-1",
    });
    transport.emit({
      ...process.identity,
      type: "violation",
      violation: {
        operation: "network-connect",
        target: "127.0.0.1",
        reason: "private target denied",
        occurredAt: 100,
      },
    });
    await Promise.resolve();

    expect(events.mock.calls.map(([event]) => event)).toEqual([
      { type: "data", data: "current" },
      { type: "cwd", cwd: "/workspace/subdir", nonce: "nonce-1" },
      {
        type: "violation",
        violation: {
          operation: "network-connect",
          target: "127.0.0.1",
          reason: "private target denied",
          occurredAt: 100,
        },
      },
    ]);
  });

  it("completes exactly once when exit and transport close race", async () => {
    const test = harness();
    const process = test.client.launch(request);
    const transport = test.transports[0];
    ready(transport);
    await process.ready;

    transport.emit({
      ...process.identity,
      type: "exit",
      exitCode: 130,
      signal: 2,
      timedOut: false,
    });
    transport.emitClose(1, "SIGKILL");

    await expect(process.completion).resolves.toEqual({
      exitCode: 130,
      signal: 2,
      timedOut: false,
    });
    expect(transport.kill).not.toHaveBeenCalled();
    expect(transport.dispose).toHaveBeenCalledTimes(1);
    expect(process.write("after exit")).toBe(false);
  });

  it("fails closed and kills the helper on invalid protocol output", async () => {
    const test = harness();
    const process = test.client.launch(request);
    const transport = test.transports[0];

    transport.emitLine("not-json");

    await expect(process.ready).rejects.toThrow("malformed JSON");
    await expect(process.completion).rejects.toThrow("malformed JSON");
    expect(transport.kill).toHaveBeenCalledTimes(1);
    expect(transport.dispose).toHaveBeenCalledTimes(1);
  });

  it("fails when data or exit arrives before readiness", async () => {
    const dataTest = harness();
    const dataProcess = dataTest.client.launch(request);
    dataTest.transports[0].emit({
      ...dataProcess.identity,
      type: "data",
      data: "too early",
    });
    await expect(dataProcess.completion).rejects.toThrow("before readiness");

    const exitTest = harness();
    const exitProcess = exitTest.client.launch(request);
    exitTest.transports[0].emit({
      ...exitProcess.identity,
      type: "exit",
      exitCode: 1,
      timedOut: false,
    });
    await expect(exitProcess.completion).rejects.toThrow("before readiness");
  });

  it("fails on transport error or premature close", async () => {
    const errorTest = harness();
    const errorProcess = errorTest.client.launch(request);
    errorTest.transports[0].emitError(new Error("spawn failed"));
    await expect(errorProcess.completion).rejects.toThrow("spawn failed");

    const closeTest = harness();
    const closeProcess = closeTest.client.launch(request);
    closeTest.transports[0].emitClose(1, null, "native helper failed");
    await expect(closeProcess.completion).rejects.toThrow(
      "closed before command completion: code=1 signal=null: native helper failed",
    );
  });

  it("terminates and disposes every active helper on client disposal", async () => {
    const test = harness();
    const first = test.client.launch(request);
    const second = test.client.launch({
      ...request,
      commandId: "command-2",
      generation: 2,
    });
    ready(test.transports[0]);
    ready(test.transports[1], {
      commandId: "command-2",
      generation: 2,
    });
    await Promise.all([first.ready, second.ready]);

    test.client.dispose();

    await expect(first.completion).rejects.toThrow("disposed");
    await expect(second.completion).rejects.toThrow("disposed");
    for (const transport of test.transports) {
      expect(parsedWrites(transport).at(-1)?.type).toBe("terminate");
      expect(transport.kill).toHaveBeenCalledTimes(1);
      expect(transport.dispose).toHaveBeenCalledTimes(1);
    }
    expect(() => test.client.launch(request)).toThrow("client is disposed");
  });
});
