import { afterEach, describe, expect, it, vi } from "vitest";

import { waitForDiagnosticsQuiescence } from "./diagnosticsQuiescence.js";

interface Harness {
  collect: ReturnType<typeof vi.fn<() => string>>;
  dispose: ReturnType<typeof vi.fn<() => void>>;
  eagerDispose: ReturnType<typeof vi.fn<() => void>>;
  emit(): void;
  wait: Promise<string>;
}

function createHarness(
  options: {
    delayMs?: number;
    hadEvent?: boolean;
    debounceMs?: number;
    firstEventGraceMs?: number;
  } = {},
): Harness {
  let listener: (() => void) | undefined;
  const collect = vi.fn(() => "collected");
  const dispose = vi.fn();
  const eagerDispose = vi.fn();
  const wait = waitForDiagnosticsQuiescence({
    delayMs: options.delayMs ?? 1_000,
    hadEvent: options.hadEvent,
    debounceMs: options.debounceMs,
    firstEventGraceMs: options.firstEventGraceMs,
    subscribe(next) {
      listener = next;
      return { dispose };
    },
    collect,
    eagerDisposables: [{ dispose: eagerDispose }],
  });

  return {
    collect,
    dispose,
    eagerDispose,
    emit() {
      listener?.();
    },
    wait,
  };
}

describe("waitForDiagnosticsQuiescence", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("settles after the first-event grace when no event arrives", async () => {
    vi.useFakeTimers();
    const harness = createHarness();

    await vi.advanceTimersByTimeAsync(499);
    expect(harness.collect).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await expect(harness.wait).resolves.toBe("collected");
    expect(harness.collect).toHaveBeenCalledOnce();
    expect(harness.dispose).toHaveBeenCalledOnce();
    expect(harness.eagerDispose).toHaveBeenCalledOnce();
  });

  it("cancels the grace timer and debounces a relevant event", async () => {
    vi.useFakeTimers();
    const harness = createHarness();

    await vi.advanceTimersByTimeAsync(200);
    harness.emit();
    await vi.advanceTimersByTimeAsync(299);
    expect(harness.collect).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await expect(harness.wait).resolves.toBe("collected");
  });

  it("resets the debounce after each event", async () => {
    vi.useFakeTimers();
    const harness = createHarness();

    harness.emit();
    await vi.advanceTimersByTimeAsync(250);
    harness.emit();
    await vi.advanceTimersByTimeAsync(299);
    expect(harness.collect).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await expect(harness.wait).resolves.toBe("collected");
  });

  it("starts the debounce immediately when an eager event already arrived", async () => {
    vi.useFakeTimers();
    const harness = createHarness({ hadEvent: true });

    await vi.advanceTimersByTimeAsync(299);
    expect(harness.collect).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await expect(harness.wait).resolves.toBe("collected");
  });

  it("debounces an event emitted synchronously while subscribing", async () => {
    vi.useFakeTimers();
    const collect = vi.fn(() => "collected");
    const wait = waitForDiagnosticsQuiescence({
      delayMs: 1_000,
      subscribe(listener) {
        listener();
        return { dispose: vi.fn() };
      },
      collect,
    });

    await vi.advanceTimersByTimeAsync(299);
    expect(collect).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await expect(wait).resolves.toBe("collected");
  });

  it("uses the hard timeout when events keep resetting the debounce", async () => {
    vi.useFakeTimers();
    const harness = createHarness({ delayMs: 1_000 });

    for (let elapsed = 0; elapsed < 900; elapsed += 200) {
      harness.emit();
      await vi.advanceTimersByTimeAsync(200);
    }

    await expect(harness.wait).resolves.toBe("collected");
    expect(harness.collect).toHaveBeenCalledOnce();
  });

  it("settles and disposes exactly once when timers race", async () => {
    vi.useFakeTimers();
    const harness = createHarness({
      delayMs: 300,
      hadEvent: true,
      debounceMs: 300,
    });

    await vi.advanceTimersByTimeAsync(300);
    await expect(harness.wait).resolves.toBe("collected");
    await vi.runAllTimersAsync();

    expect(harness.collect).toHaveBeenCalledOnce();
    expect(harness.dispose).toHaveBeenCalledOnce();
    expect(harness.eagerDispose).toHaveBeenCalledOnce();
  });
});
