import {
  ProviderStreamActivityMonitor,
  ProviderStreamTimeoutError,
  runWatchedProviderStream,
} from "@agentlink/core/provider-stream-watchdog";
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
