import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createTerminalMarkerTracker,
  findAndStripTerminalMarker,
  registerTerminalCompletionListeners,
  type TerminalEndEvent,
} from "./terminalCompletion.js";

describe("findAndStripTerminalMarker", () => {
  it("strips an exit marker and parses its exit code", () => {
    expect(
      findAndStripTerminalMarker("output\r\n\x1b]633;D;7\x07prompt", 0),
    ).toEqual({ exitCode: 7, stripped: "output\r\n", source: "exit" });
  });

  it("maps an interrupted prompt marker to exit code 130", () => {
    expect(
      findAndStripTerminalMarker("watching\r\n^C\r\n\x1b]133;A\x07", 0),
    ).toEqual({
      exitCode: 130,
      stripped: "watching\r\n^C\r\n",
      source: "prompt",
    });
  });

  it("chooses the first marker in the buffer", () => {
    expect(
      findAndStripTerminalMarker(
        "first\x1b]633;A\x07second\x1b]633;D;0\x07",
        0,
      ),
    ).toEqual({ exitCode: null, stripped: "first", source: "prompt" });
  });
});

describe("createTerminalMarkerTracker", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("detects a marker split across checks using the overlap", () => {
    vi.useFakeTimers();
    let buffer = `prefix-${"x".repeat(30)}\x1b]633;`;
    const onMarker = vi.fn();
    const tracker = createTerminalMarkerTracker({
      getBuffer: () => buffer,
      setBuffer: (next) => {
        buffer = next;
      },
      isActive: () => true,
      onMarker,
    });

    expect(tracker.check()).toBe(false);
    buffer += "D;0\x07";
    expect(tracker.check()).toBe(true);
    expect(buffer).toBe(`prefix-${"x".repeat(30)}`);
    expect(onMarker).toHaveBeenCalledWith(
      { exitCode: 0, stripped: buffer, source: "exit" },
      "stream",
    );

    tracker.dispose();
  });

  it("polls changed output and reports the poll source", async () => {
    vi.useFakeTimers();
    let buffer = "";
    const onMarker = vi.fn();
    const tracker = createTerminalMarkerTracker({
      getBuffer: () => buffer,
      setBuffer: (next) => {
        buffer = next;
      },
      isActive: () => true,
      onMarker,
      pollIntervalMs: 50,
    });

    buffer = "done\x1b]633;D;0\x07";
    await vi.advanceTimersByTimeAsync(50);

    expect(onMarker).toHaveBeenCalledWith(
      { exitCode: 0, stripped: "done", source: "exit" },
      "poll",
    );
    tracker.dispose();
  });

  it("stops polling when inactive and disposes idempotently", async () => {
    vi.useFakeTimers();
    let active = true;
    let buffer = "";
    const onMarker = vi.fn();
    const tracker = createTerminalMarkerTracker({
      getBuffer: () => buffer,
      setBuffer: (next) => {
        buffer = next;
      },
      isActive: () => active,
      onMarker,
      pollIntervalMs: 50,
    });

    active = false;
    await vi.advanceTimersByTimeAsync(50);
    buffer = "done\x1b]633;D;0\x07";
    await vi.advanceTimersByTimeAsync(100);
    tracker.dispose();
    tracker.dispose();

    expect(onMarker).not.toHaveBeenCalled();
    expect(tracker.check()).toBe(false);
  });
});

describe("registerTerminalCompletionListeners", () => {
  it("matches the exact execution and ignores stale events", () => {
    const terminal = {};
    const execution = {};
    const staleExecution = {};
    let endListener:
      | ((event: TerminalEndEvent<object, object>) => void)
      | undefined;
    let closeListener: ((closed: object) => void) | undefined;
    const onEnd = vi.fn();
    const onClose = vi.fn();

    registerTerminalCompletionListeners({
      terminal,
      getExecution: () => execution,
      subscribeEnd(listener) {
        endListener = listener;
        return { dispose: vi.fn() };
      },
      subscribeClose(listener) {
        closeListener = listener;
        return { dispose: vi.fn() };
      },
      onEnd,
      onClose,
    });

    endListener?.({ terminal, execution: staleExecution, exitCode: 1 });
    endListener?.({ terminal, execution, exitCode: 0 });
    closeListener?.({});
    closeListener?.(terminal);

    expect(onEnd).toHaveBeenCalledOnce();
    expect(onEnd).toHaveBeenCalledWith(0);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("uses terminal fallback only when explicitly enabled and no execution exists", () => {
    const terminal = {};
    let endListener:
      | ((event: TerminalEndEvent<object, object>) => void)
      | undefined;
    const onEnd = vi.fn();

    registerTerminalCompletionListeners<object, object>({
      terminal,
      getExecution: () => undefined,
      allowTerminalFallback: true,
      subscribeEnd(listener) {
        endListener = listener;
        return { dispose: vi.fn() };
      },
      subscribeClose: () => ({ dispose: vi.fn() }),
      onEnd,
      onClose: vi.fn(),
    });

    endListener?.({ terminal: {}, execution: {}, exitCode: 1 });
    endListener?.({ terminal, execution: {}, exitCode: undefined });

    expect(onEnd).toHaveBeenCalledOnce();
    expect(onEnd).toHaveBeenCalledWith(undefined);
  });
});
