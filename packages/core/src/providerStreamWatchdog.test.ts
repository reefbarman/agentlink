import {
  ProviderStreamActivityMonitor,
  ProviderStreamTimeoutError,
  runWatchedProviderStream,
} from "./providerStreamWatchdog.js";
import { describe, expect, it } from "vitest";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function neverYields<T>(): AsyncIterator<T> {
  return {
    next: () => new Promise<never>(() => undefined),
  };
}

describe("ProviderStreamActivityMonitor", () => {
  it("times out the connection when no transport activity arrives", async () => {
    const controller = new AbortController();
    const monitor = new ProviderStreamActivityMonitor(
      5,
      1_000,
      1_000,
      controller,
    );
    try {
      await expect(monitor.next(neverYields())).rejects.toMatchObject({
        name: "ProviderStreamTimeoutError",
        kind: "connection",
      });
      expect(controller.signal.aborted).toBe(true);
    } finally {
      monitor.dispose();
    }
  });

  it("times out on no progress even while transport activity continues", async () => {
    const controller = new AbortController();
    const monitor = new ProviderStreamActivityMonitor(
      1_000,
      1_000,
      15,
      controller,
    );
    const heartbeat = setInterval(() => {
      monitor.recordActivity({ kind: "body", at: Date.now(), bytes: 1 });
    }, 2);
    try {
      await expect(monitor.next(neverYields())).rejects.toMatchObject({
        name: "ProviderStreamTimeoutError",
        kind: "no_progress",
      });
      expect(controller.signal.aborted).toBe(true);
    } finally {
      clearInterval(heartbeat);
      monitor.dispose();
    }
  });

  it("re-arms the no-progress timer on recorded progress", async () => {
    const controller = new AbortController();
    const monitor = new ProviderStreamActivityMonitor(
      1_000,
      1_000,
      25,
      controller,
    );
    try {
      for (let i = 0; i < 4; i++) {
        await sleep(10);
        monitor.recordProgress();
      }
      expect(controller.signal.aborted).toBe(false);
      expect(monitor.lastProgressAt).toBeDefined();
    } finally {
      monitor.dispose();
    }
  });

  it("allows a longer bounded silence while the provider announces silent work", async () => {
    const controller = new AbortController();
    const monitor = new ProviderStreamActivityMonitor(
      1_000,
      1_000,
      15,
      controller,
      500,
    );
    try {
      monitor.recordProviderEvent({
        type: "provider_progress",
        silentWork: true,
      });
      await sleep(40);
      // Past the ordinary no-progress limit, but reasoning is announced.
      expect(controller.signal.aborted).toBe(false);
      await expect(monitor.next(neverYields())).rejects.toMatchObject({
        name: "ProviderStreamTimeoutError",
        kind: "no_progress",
        message: expect.stringContaining("500ms"),
      });
      expect(controller.signal.aborted).toBe(true);
    } finally {
      monitor.dispose();
    }
  });

  it.each([
    [{ type: "provider_progress", silentWork: false }],
    [{ type: "response_retry", attempt: 1 }],
  ])("returns to the ordinary no-progress limit after %o", async (event) => {
    const controller = new AbortController();
    const monitor = new ProviderStreamActivityMonitor(
      1_000,
      1_000,
      15,
      controller,
      10_000,
    );
    try {
      monitor.recordProviderEvent({
        type: "provider_progress",
        silentWork: true,
      });
      monitor.recordProviderEvent(event);
      expect(monitor.silentWork).toBe(false);
      await expect(monitor.next(neverYields())).rejects.toMatchObject({
        kind: "no_progress",
        message: expect.stringContaining("15ms"),
      });
    } finally {
      monitor.dispose();
    }
  });

  it("stops firing after dispose", async () => {
    const controller = new AbortController();
    const monitor = new ProviderStreamActivityMonitor(5, 5, 5, controller);
    monitor.dispose();
    await sleep(15);
    expect(controller.signal.aborted).toBe(false);
  });
});

describe("runWatchedProviderStream", () => {
  it("passes events through to completion", async () => {
    const events: string[] = [];
    const stream = runWatchedProviderStream<string>({
      start: ({ onTransportActivity }) => {
        return (async function* () {
          onTransportActivity({ kind: "headers", at: Date.now() });
          yield "a";
          yield "b";
        })();
      },
    });
    for await (const event of stream) {
      events.push(event);
    }
    expect(events).toEqual(["a", "b"]);
  });

  it("aborts a stream that is transport-active but never yields", async () => {
    let underlyingSignal: AbortSignal | undefined;
    const stream = runWatchedProviderStream<string>({
      noProgressTimeoutMs: 15,
      start: ({ signal, onTransportActivity }) => {
        underlyingSignal = signal;
        return (async function* () {
          const heartbeat = setInterval(() => {
            onTransportActivity({ kind: "body", at: Date.now(), bytes: 1 });
          }, 2);
          try {
            await new Promise((_, reject) => {
              signal.addEventListener(
                "abort",
                () => reject(new Error("aborted")),
                { once: true },
              );
            });
          } finally {
            clearInterval(heartbeat);
          }
          yield "never";
        })();
      },
    });

    await expect(async () => {
      for await (const event of stream) void event;
    }).rejects.toBeInstanceOf(ProviderStreamTimeoutError);
    expect(underlyingSignal?.aborted).toBe(true);
  });

  it("keeps silently reasoning streams alive past the ordinary no-progress limit", async () => {
    const events: string[] = [];
    const stream = runWatchedProviderStream<{
      type: string;
      silentWork?: boolean;
    }>({
      noProgressTimeoutMs: 15,
      silentWorkTimeoutMs: 1_000,
      start: () =>
        (async function* () {
          yield { type: "provider_progress", silentWork: true };
          await sleep(50);
          yield { type: "provider_progress", silentWork: false };
          yield { type: "text_delta" };
        })(),
    });
    for await (const event of stream) events.push(event.type);
    expect(events).toEqual([
      "provider_progress",
      "provider_progress",
      "text_delta",
    ]);
  });

  it("keeps websocket watchdog timeouts retryable for the owning recovery loop", async () => {
    let capturedAttempt:
      | {
          model: string;
          dispatchEvidence?: {
            transport: "http" | "websocket";
            phase:
              | "not_sent"
              | "sent_unacknowledged"
              | "response_started"
              | "terminal";
          };
        }
      | undefined;
    const attempt = {
      model: "gpt-test",
      dispatchEvidence: {
        transport: "websocket" as const,
        phase: "sent_unacknowledged" as const,
      },
    };
    const stream = runWatchedProviderStream<string>({
      connectionTimeoutMs: 15,
      start: ({ onProviderRequestAttempt }) => {
        onProviderRequestAttempt(attempt);
        capturedAttempt = attempt;
        return { [Symbol.asyncIterator]: () => neverYields<string>() };
      },
    });
    await expect(async () => {
      for await (const event of stream) void event;
    }).rejects.toMatchObject({
      name: "ProviderStreamTimeoutError",
      retryable: true,
    });
    expect(capturedAttempt?.dispatchEvidence).toMatchObject({
      transport: "websocket",
      phase: "sent_unacknowledged",
    });
  });

  it("forwards an external abort to the underlying request", async () => {
    const external = new AbortController();
    let underlyingSignal: AbortSignal | undefined;
    const stream = runWatchedProviderStream<string>({
      signal: external.signal,
      start: ({ signal }) => {
        underlyingSignal = signal;
        return (async function* () {
          yield "first";
          await new Promise((_, reject) => {
            const fail = () => reject(new Error("request aborted"));
            if (signal.aborted) return fail();
            signal.addEventListener("abort", fail, { once: true });
          });
          yield "never";
        })();
      },
    });

    const iterator = stream[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toBe("first");
    external.abort();
    await expect(iterator.next()).rejects.toThrow("request aborted");
    expect(underlyingSignal?.aborted).toBe(true);
  });
});
