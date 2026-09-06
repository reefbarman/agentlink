import type {
  ComposeRuntimeOptions,
  ComposeToolResult,
} from "./composeRuntime.js";
import { describe, expect, it, vi } from "vitest";

import { ComposeRuntimeLimiter } from "./composeRuntimeLimiter.js";

function options(signal = new AbortController().signal): ComposeRuntimeOptions {
  return {
    params: { script: "return null;" },
    scope: {
      canExecuteChild: () => false,
      preflightChild: () => undefined,
      reserveChildren: () => undefined,
      executeChild: async () => {
        throw new Error("unexpected child");
      },
    },
    signal,
    wasmPath: "/tmp/compose.wasm",
  };
}

function success(label: string): ComposeToolResult {
  return {
    content: [{ type: "text", text: label }],
    data: label,
    isError: false,
    uiMeta: {
      composeTrace: {
        status: "completed",
        totalChildren: 0,
        completedChildren: 0,
        children: [],
      },
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("ComposeRuntimeLimiter", () => {
  it("runs queued calls FIFO and releases slots after completion", async () => {
    const limiter = new ComposeRuntimeLimiter({ maxActive: 1, maxWaiters: 2 });
    const first = deferred<ComposeToolResult>();
    const order: string[] = [];
    const p1 = limiter.run(options(), async () => {
      order.push("first");
      return first.promise;
    });
    const p2 = limiter.run(options(), async () => {
      order.push("second");
      return success("second");
    });
    const p3 = limiter.run(options(), async () => {
      order.push("third");
      return success("third");
    });

    await vi.waitFor(() => expect(order).toEqual(["first"]));
    first.resolve(success("first"));
    await expect(Promise.all([p1, p2, p3])).resolves.toHaveLength(3);
    expect(order).toEqual(["first", "second", "third"]);
  });

  it("rejects overflow and expiry without dispatch", async () => {
    vi.useFakeTimers();
    try {
      const limiter = new ComposeRuntimeLimiter({
        maxActive: 1,
        maxWaiters: 1,
        admissionTimeoutMs: 5_000,
      });
      const first = deferred<ComposeToolResult>();
      void limiter.run(options(), () => first.promise);
      const queued = vi.fn(async () => success("queued"));
      const queuedResult = limiter.run(options(), queued);
      const overflow = vi.fn(async () => success("overflow"));
      await expect(limiter.run(options(), overflow)).resolves.toMatchObject({
        data: { code: "compose_runtime_busy" },
      });
      expect(overflow).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(5_000);
      await expect(queuedResult).resolves.toMatchObject({
        data: { code: "compose_runtime_busy" },
        uiMeta: { composeTrace: { queueWaitBucket: "5s_plus" } },
      });
      expect(queued).not.toHaveBeenCalled();
      first.resolve(success("first"));
    } finally {
      vi.useRealTimers();
    }
  });

  it("removes an aborted waiter immediately", async () => {
    const limiter = new ComposeRuntimeLimiter({ maxActive: 1, maxWaiters: 1 });
    const first = deferred<ComposeToolResult>();
    void limiter.run(options(), () => first.promise);
    const controller = new AbortController();
    const queued = vi.fn(async () => success("queued"));
    const result = limiter.run(options(controller.signal), queued);
    controller.abort();

    await expect(result).resolves.toMatchObject({
      data: { code: "aborted" },
      uiMeta: { composeTrace: { status: "cancelled" } },
    });
    expect(queued).not.toHaveBeenCalled();
    first.resolve(success("first"));
  });
});
