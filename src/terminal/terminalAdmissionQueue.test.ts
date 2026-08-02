import {
  TerminalAdmissionCancelledError,
  TerminalAdmissionQueue,
} from "./terminalAdmissionQueue.js";
import { describe, expect, it, vi } from "vitest";

function request(
  key: string,
  canAdmit: () => boolean,
  overrides: Partial<{
    signal: AbortSignal;
    timeoutMs: number;
    maxWaiters: number;
  }> = {},
) {
  return {
    key,
    canAdmit,
    timeoutError: () => new Error("terminal pool exhausted"),
    timeoutMs: 30_000,
    maxWaiters: 16,
    ...overrides,
  };
}

describe("TerminalAdmissionQueue", () => {
  it("grants tickets in FIFO order", async () => {
    const queue = new TerminalAdmissionQueue();
    let available = false;
    const first = queue.wait(request("owner", () => available));
    const second = queue.wait(request("owner", () => available));

    available = true;
    queue.notify("owner");
    const firstTicket = await first;
    expect(queue.waitingFor("owner")).toBe(2);

    let secondGranted = false;
    void second.then(() => {
      secondGranted = true;
    });
    await Promise.resolve();
    expect(secondGranted).toBe(false);

    firstTicket.consume();
    const secondTicket = await second;
    secondTicket.consume();
    expect(queue.waiting).toBe(0);
  });

  it("rejects an aborted waiter and admits the next waiter", async () => {
    const queue = new TerminalAdmissionQueue();
    let available = false;
    const controller = new AbortController();
    const first = queue.wait(
      request("owner", () => available, { signal: controller.signal }),
    );
    const second = queue.wait(request("owner", () => available));

    controller.abort();
    await expect(first).rejects.toBeInstanceOf(TerminalAdmissionCancelledError);

    available = true;
    queue.notify("owner");
    const ticket = await second;
    ticket.consume();
  });

  it("rejects a waiter on timeout", async () => {
    vi.useFakeTimers();
    try {
      const queue = new TerminalAdmissionQueue();
      const pending = queue.wait(
        request("owner", () => false, { timeoutMs: 10 }),
      );
      const rejected = expect(pending).rejects.toThrow(
        "terminal pool exhausted",
      );

      await vi.advanceTimersByTimeAsync(10);
      await rejected;
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds queued waiters", async () => {
    const queue = new TerminalAdmissionQueue();
    const first = queue.wait(request("owner", () => false, { maxWaiters: 1 }));
    const second = queue.wait(request("owner", () => false, { maxWaiters: 1 }));

    await expect(second).rejects.toThrow("terminal pool exhausted");
    queue.retire();
    await expect(first).rejects.toBeInstanceOf(TerminalAdmissionCancelledError);
  });

  it("rejects pending waiters when retired", async () => {
    const queue = new TerminalAdmissionQueue();
    const pending = queue.wait(request("owner", () => false));

    queue.retire();
    await expect(pending).rejects.toMatchObject({
      name: "TerminalAdmissionCancelledError",
      message: "Terminal provider was retired",
    });
  });
});
