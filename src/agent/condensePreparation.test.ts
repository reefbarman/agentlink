import {
  CondensePreparation,
  MAX_PREPARATION_ATTEMPTS,
  getPrepareThresholdTokens,
  isUnchangedPrefix,
  mergePreparedSummary,
} from "./condensePreparation.js";
import { describe, expect, it, vi } from "vitest";

import type { AgentMessage } from "./types.js";
import type { SummarizeResult } from "./condense.js";

function message(content: string, role: "user" | "assistant" = "user") {
  return { role, content } as AgentMessage;
}

function summaryResult(snapshot: AgentMessage[]): SummarizeResult {
  return {
    messages: [
      ...snapshot.map((m, i) =>
        i === 0 ? m : { ...m, condenseParent: "summary-1" },
      ),
      { role: "user", content: "summary", isSummary: true },
    ],
    summary: "summary",
    prevInputTokens: 100,
    newInputTokens: 10,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const identity = { providerId: "p", model: "m" };

describe("getPrepareThresholdTokens", () => {
  it("leads the apply threshold by the smallest of 10% window, 20k, half apply", () => {
    expect(getPrepareThresholdTokens(80_000, 100_000)).toBe(70_000);
    expect(getPrepareThresholdTokens(230_000, 256_000)).toBe(210_000);
    expect(getPrepareThresholdTokens(10, 100_000)).toBe(5);
    expect(getPrepareThresholdTokens(0, 0)).toBe(0);
  });
});

describe("isUnchangedPrefix", () => {
  it("compares message identity, not content", () => {
    const a = message("a");
    const b = message("b");
    expect(isUnchangedPrefix([a], [a, b])).toBe(true);
    expect(isUnchangedPrefix([a, b], [a])).toBe(false);
    expect(isUnchangedPrefix([a], [{ ...a }, b])).toBe(false);
    expect(isUnchangedPrefix([], [a])).toBe(false);
  });
});

describe("CondensePreparation", () => {
  it("reuses a ready summary and keeps messages appended after the snapshot verbatim", async () => {
    const preparation = new CondensePreparation();
    const live = [message("task"), message("reply", "assistant")];
    const start = vi.fn(async (snapshot: AgentMessage[]) =>
      summaryResult(snapshot),
    );
    expect(
      preparation.arm({ ...identity, messages: live, usedTokens: 70, start }),
    ).toBe(true);
    const tail = [message("later", "assistant"), message("tool results")];
    live.push(...tail);

    const taken = await preparation.take({
      ...identity,
      readMessages: () => live,
      usedTokens: 75,
      applyTokens: 80,
    });

    expect(taken.rejection).toBeUndefined();
    expect(taken.result?.prevInputTokens).toBe(75);
    const merged = taken.result!.messages;
    expect(merged.at(-3)?.isSummary).toBe(true);
    expect(merged.slice(-2)).toEqual(tail);
    expect(merged.slice(-2)[0]).toBe(tail[0]);
    expect(preparation.hasTask).toBe(false);
  });

  it("waits for an in-flight preparation instead of starting over", async () => {
    let now = 0;
    const preparation = new CondensePreparation(() => now);
    const live = [message("task"), message("reply", "assistant")];
    const gate = deferred<SummarizeResult>();
    preparation.arm({
      ...identity,
      messages: live,
      usedTokens: 70,
      start: () => gate.promise,
    });

    const take = preparation.take({
      ...identity,
      readMessages: () => live,
      usedTokens: 80,
      applyTokens: 80,
    });
    now = 1_500;
    gate.resolve(summaryResult([...live]));
    const taken = await take;
    expect(taken.result).toBeDefined();
    expect(taken.waitMs).toBe(1_500);
  });

  it("rejects and aborts when the transcript prefix or model changed", async () => {
    const preparation = new CondensePreparation();
    const first = message("task");
    let signal: AbortSignal | undefined;
    preparation.arm({
      ...identity,
      messages: [first, message("a", "assistant")],
      usedTokens: 70,
      start: (_snapshot, s) => {
        signal = s;
        return new Promise(() => {});
      },
    });
    const rewound = await preparation.take({
      ...identity,
      readMessages: () => [first, message("different", "assistant")],
      usedTokens: 75,
      applyTokens: 80,
    });
    expect(rewound).toEqual({ rejection: "transcript_changed", waitMs: 0 });
    expect(signal?.aborted).toBe(true);

    const live = [first];
    preparation.arm({
      ...identity,
      messages: live,
      usedTokens: 71,
      start: () => new Promise(() => {}),
    });
    const switched = await preparation.take({
      providerId: "p",
      model: "other",
      readMessages: () => live,
      usedTokens: 75,
      applyTokens: 80,
    });
    expect(switched.rejection).toBe("identity_changed");
  });

  it("rejects when the transcript is replaced while waiting for the preparation", async () => {
    const preparation = new CondensePreparation();
    let live = [message("task"), message("reply", "assistant")];
    const gate = deferred<SummarizeResult>();
    preparation.arm({
      ...identity,
      messages: live,
      usedTokens: 70,
      start: () => gate.promise,
    });
    const take = preparation.take({
      ...identity,
      readMessages: () => live,
      usedTokens: 80,
      applyTokens: 80,
    });
    // A checkpoint revert swaps in a new transcript array mid-wait.
    live = [live[0]!];
    gate.resolve(summaryResult([message("task"), message("reply")]));
    const taken = await take;
    expect(taken.rejection).toBe("transcript_changed");
    expect(taken.result).toBeUndefined();
  });

  it("rejects when the verbatim tail would leave the session near the threshold", async () => {
    const preparation = new CondensePreparation();
    const live = [message("task")];
    preparation.arm({
      ...identity,
      messages: live,
      usedTokens: 70_000,
      start: async (snapshot) => summaryResult(snapshot),
    });
    const taken = await preparation.take({
      ...identity,
      readMessages: () => live,
      usedTokens: 115_000,
      applyTokens: 80_000,
    });
    expect(taken.rejection).toBe("tail_too_large");
  });

  it("reports failed preparations so the caller condenses in the foreground", async () => {
    const preparation = new CondensePreparation();
    const live = [message("task")];
    preparation.arm({
      ...identity,
      messages: live,
      usedTokens: 70,
      start: async (snapshot) => ({
        ...summaryResult(snapshot),
        error: "Condensing API call failed",
      }),
    });
    const taken = await preparation.take({
      ...identity,
      readMessages: () => live,
      usedTokens: 75,
      applyTokens: 80,
    });
    expect(taken.rejection).toBe("failed");
    expect(taken.result).toBeUndefined();
  });

  it("stops waiting and aborts the preparation when the turn is aborted", async () => {
    const preparation = new CondensePreparation();
    const live = [message("task")];
    let prepSignal: AbortSignal | undefined;
    preparation.arm({
      ...identity,
      messages: live,
      usedTokens: 70,
      start: (_snapshot, signal) => {
        prepSignal = signal;
        return new Promise(() => {});
      },
    });
    const controller = new AbortController();
    const take = preparation.take({
      ...identity,
      readMessages: () => live,
      usedTokens: 75,
      applyTokens: 80,
      signal: controller.signal,
    });
    controller.abort();
    expect((await take).rejection).toBe("aborted");
    expect(prepSignal?.aborted).toBe(true);
  });

  it("keeps a valid preparation across later boundaries and caps attempts per cycle", async () => {
    const preparation = new CondensePreparation();
    const live = [message("task")];
    const start = vi.fn(async (snapshot: AgentMessage[]) => ({
      ...summaryResult(snapshot),
      error: "failed",
    }));
    const arm = (usedTokens: number) =>
      preparation.arm({ ...identity, messages: live, usedTokens, start });

    expect(arm(70)).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    // A failure retries only once usage has moved on.
    expect(arm(70)).toBe(false);
    expect(arm(72)).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(arm(74)).toBe(false);
    expect(preparation.attemptCount).toBe(MAX_PREPARATION_ATTEMPTS);
    expect(start).toHaveBeenCalledTimes(2);

    preparation.cancel(true);
    expect(arm(76)).toBe(true);
  });

  it("does not replace a pending or successful preparation at the next boundary", () => {
    const preparation = new CondensePreparation();
    const live = [message("task")];
    const start = vi.fn(() => new Promise<SummarizeResult>(() => {}));
    expect(
      preparation.arm({ ...identity, messages: live, usedTokens: 70, start }),
    ).toBe(true);
    live.push(message("more", "assistant"));
    expect(
      preparation.arm({ ...identity, messages: live, usedTokens: 72, start }),
    ).toBe(false);
    expect(start).toHaveBeenCalledTimes(1);
  });
});

describe("mergePreparedSummary", () => {
  it("appends the live tail after the prepared summary", () => {
    const snapshot = [message("task")];
    const tail = message("tail", "assistant");
    const merged = mergePreparedSummary(
      summaryResult(snapshot),
      snapshot,
      [...snapshot, tail],
      500,
    );
    expect(merged.messages.at(-1)).toBe(tail);
    expect(merged.prevInputTokens).toBe(500);
  });
});
