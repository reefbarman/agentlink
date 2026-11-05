import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  McpResourceWatches,
  type McpResourceWatchMode,
  type McpResourceWatchSubscriptionHandlers,
  type McpResourceWatchesOptions,
} from "./mcpResourceWatches.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function harness() {
  const identities = new Map([
    ["server", "definition-1"],
    ["other", "definition-2"],
  ]);
  const subscriptions: {
    server: string;
    uris: readonly string[];
    handlers: McpResourceWatchSubscriptionHandlers;
    dispose: ReturnType<typeof vi.fn>;
  }[] = [];
  const options = {
    getServerIdentity: (server: string) => identities.get(server),
    requestApproval: vi.fn<McpResourceWatchesOptions["requestApproval"]>(
      async ({ mode }) => mode,
    ),
    subscribe: vi.fn<McpResourceWatchesOptions["subscribe"]>(
      async (server, uris, handlers) => {
        const subscription = {
          server,
          uris,
          handlers,
          dispose: vi.fn(async () => {}),
        };
        subscriptions.push(subscription);
        return subscription;
      },
    ),
    read: vi.fn<McpResourceWatchesOptions["read"]>(async () => ({
      text: "first snapshot",
    })),
    onChange: vi.fn(),
    onPending: vi.fn(),
    now: () => Date.now(),
  };
  const watches = new McpResourceWatches(options);
  const settle = () => vi.advanceTimersByTimeAsync(0);
  const add = async (
    uri = "resource://one",
    mode: McpResourceWatchMode = "deliver",
    server = "server",
  ) => {
    const result = await watches.watch(server, uri, mode);
    await settle();
    return result;
  };
  const update = (uri = "resource://one", server = "server") => {
    [...subscriptions]
      .reverse()
      .find((subscription) => subscription.server === server)!
      .handlers.onUpdated(uri);
  };
  return { watches, options, subscriptions, identities, settle, add, update };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});
afterEach(() => vi.useRealTimers());

describe("McpResourceWatches consent and lifecycle", () => {
  it("acknowledges only the captured notify notice, preserving later notifications even in the same millisecond", async () => {
    const h = harness();
    await h.add("resource://one", "notify");
    h.update();
    const stale = h.watches.captureNoticeAcknowledgement(
      "server",
      "resource://one",
    )!;
    h.update();
    stale();
    expect(h.watches.snapshot()[0].pending).toBe(true);
    const current = h.watches.captureNoticeAcknowledgement(
      "server",
      "resource://one",
    )!;
    expect(h.watches.snapshot()[0].pending).toBe(true);
    current();
    expect(h.watches.snapshot()[0]).toMatchObject({
      mode: "notify",
      pending: false,
    });
    h.update();
    current();
    expect(h.watches.snapshot()[0].pending).toBe(true);
    expect(h.options.read).not.toHaveBeenCalled();
    await h.watches.dispose();
  });

  it("does not acknowledge a replacement watch or a changed grant", async () => {
    const h = harness();
    await h.add("resource://one", "notify");
    h.update();
    const acknowledge = h.watches.captureNoticeAcknowledgement(
      "server",
      "resource://one",
    )!;
    await h.watches.unwatch("server", "resource://one");
    await h.add("resource://one", "notify");
    h.update();
    acknowledge();
    expect(h.watches.snapshot()[0].pending).toBe(true);
    const changed = h.watches.captureNoticeAcknowledgement(
      "server",
      "resource://one",
    )!;
    h.watches.pause("server", "resource://one");
    changed();
    expect(h.watches.snapshot()[0].pending).toBe(true);
    await h.watches.dispose();
  });

  it("does nothing before explicit consent and denial creates no subscription", async () => {
    const h = harness();
    const approval = deferred<McpResourceWatchMode | "deny">();
    h.options.requestApproval.mockReturnValueOnce(approval.promise);
    const request = h.watches.watch("server", "resource://one", "wake");
    await h.settle();
    expect(h.options.subscribe).not.toHaveBeenCalled();
    expect(h.options.read).not.toHaveBeenCalled();
    expect(h.watches.snapshot()[0]).toMatchObject({
      paused: true,
      reason: "Approval required",
    });
    expect(h.watches.snapshot({ includePendingApprovals: false })).toEqual([]);
    approval.resolve("deny");
    expect(await request).toEqual({
      ok: false,
      error: "Resource watch denied",
    });
    expect(h.watches.snapshot()).toEqual([]);
    expect(h.options.subscribe).not.toHaveBeenCalled();
  });

  it("notify only coalesces metadata and never reads, including reconnect", async () => {
    const h = harness();
    h.options.requestApproval.mockResolvedValue("notify");
    await h.add("resource://one", "wake");
    h.update();
    h.update();
    h.subscriptions[0]!.handlers.onReconnected();
    await h.settle();
    expect(h.watches.snapshot()).toEqual([
      {
        server: "server",
        uri: "resource://one",
        mode: "notify",
        paused: false,
        pending: true,
        updatedAt: Date.now(),
      },
    ]);
    expect(h.options.read).not.toHaveBeenCalled();
    expect(h.watches.reservePending({ idle: false })).toBeUndefined();
    expect(h.options.onPending).not.toHaveBeenCalled();
  });

  it("reuses identical grants, approves upgrades, and cancels pending content on downgrade", async () => {
    const h = harness();
    await h.add();
    await h.add();
    expect(h.options.requestApproval).toHaveBeenCalledTimes(1);
    const batch = h.watches.reservePending({ idle: false })!;
    expect(batch.updates[0]).toMatchObject({
      server: "server",
      uri: "resource://one",
      text: "first snapshot",
    });
    await h.add("resource://one", "notify");
    expect(h.watches.isBatchValid(batch)).toBe(false);
    expect(h.options.requestApproval).toHaveBeenCalledTimes(1);
    await h.add("resource://one", "wake");
    expect(h.options.requestApproval).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.watches.reservePending({ idle: true })).toBeDefined();
  });

  it("aggregates URIs per server and rejects late notifications from replaced streams", async () => {
    const h = harness();
    await h.add("resource://one", "notify");
    await h.add("resource://two", "notify");
    await h.add("resource://one", "notify", "other");
    expect(h.subscriptions.map(({ server, uris }) => [server, uris])).toEqual([
      ["server", ["resource://one"]],
      ["server", ["resource://one", "resource://two"]],
      ["other", ["resource://one"]],
    ]);
    expect(h.subscriptions[0]!.dispose).toHaveBeenCalledTimes(1);
    h.subscriptions[0]!.handlers.onUpdated("resource://one");
    h.subscriptions[1]!.handlers.onUpdated("resource://unrequested");
    expect(h.watches.snapshot().every((watch) => !watch.pending)).toBe(true);
    h.watches.unwatch("server", "resource://one");
    await h.settle();
    expect(h.subscriptions.at(-1)!.uris).toEqual(["resource://two"]);
    expect(h.subscriptions[2]!.dispose).not.toHaveBeenCalled();
  });

  it("caps watches at four, including unresolved approvals", async () => {
    const h = harness();
    for (let i = 0; i < 4; i++) await h.add(`resource://${i}`, "notify");
    expect(await h.add("resource://fifth", "notify")).toEqual({
      ok: false,
      error: "Maximum four resource watches",
    });
    expect(h.options.requestApproval).toHaveBeenCalledTimes(4);
  });

  it.each(["revoke", "identity", "dispose"])(
    "rejects a late approval after %s",
    async (action) => {
      const h = harness();
      const approval = deferred<McpResourceWatchMode | "deny">();
      h.options.requestApproval.mockReturnValueOnce(approval.promise);
      const request = h.watches.watch("server", "resource://one", "wake");
      if (action === "revoke") h.watches.unwatch("server", "resource://one");
      if (action === "identity") h.identities.set("server", "replacement");
      if (action === "dispose") await h.watches.dispose();
      approval.resolve("wake");
      expect((await request).ok).toBe(false);
      expect(h.options.subscribe).not.toHaveBeenCalled();
      expect(h.options.read).not.toHaveBeenCalled();
    },
  );

  it("stop cancels outstanding approval and fresh consent does not restart a stopped session", async () => {
    const h = harness();
    const approval = deferred<McpResourceWatchMode | "deny">();
    h.options.requestApproval.mockReturnValueOnce(approval.promise);
    const request = h.watches.watch("server", "resource://one", "wake");
    h.watches.pauseAll();
    approval.resolve("wake");
    expect((await request).ok).toBe(false);
    await h.add("resource://one", "wake");
    expect(h.watches.snapshot()[0]).toMatchObject({
      paused: true,
      reason: "Session stopped",
    });
    expect(h.options.read).not.toHaveBeenCalled();
    h.watches.noteUserTurn();
    await h.settle();
    expect(h.options.read).toHaveBeenCalledTimes(1);
  });

  it("disposes a subscription that resolves after revocation", async () => {
    const h = harness();
    const subscription = deferred<{ dispose(): Promise<void> }>();
    const dispose = vi.fn(async () => {});
    h.options.subscribe.mockReturnValueOnce(subscription.promise);
    await h.add();
    h.watches.unwatch("server", "resource://one");
    subscription.resolve({ dispose });
    await h.settle();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(h.options.read).not.toHaveBeenCalled();
  });

  it("server replacement invalidates reservations and requires fresh approval even if identity returns", async () => {
    const h = harness();
    await h.add("resource://one", "wake");
    const batch = h.watches.reservePending({ idle: true })!;
    h.identities.set("server", "replacement");
    expect(h.watches.isBatchValid(batch)).toBe(false);
    h.identities.set("server", "definition-1");
    h.watches.noteUserTurn();
    expect(h.watches.resume("server", "resource://one")).toBe(false);
    expect(h.watches.snapshot()[0]).toMatchObject({
      paused: true,
      reason: expect.stringContaining("approval required"),
    });
    await h.add("resource://one", "wake");
    expect(h.options.requestApproval).toHaveBeenCalledTimes(2);
  });

  it("distinguishes manual pause, stop and errors on a genuine user turn", async () => {
    const h = harness();
    await h.add("resource://manual");
    await h.add("resource://stop");
    h.watches.pause("server", "resource://manual");
    h.watches.pauseAll();
    h.watches.noteUserTurn();
    expect(h.watches.snapshot()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          uri: "resource://manual",
          paused: true,
          reason: "Paused by user",
        }),
        expect.objectContaining({ uri: "resource://stop", paused: false }),
      ]),
    );
    h.subscriptions.at(-1)!.handlers.onError(new Error("auth required"));
    h.watches.noteUserTurn();
    expect(h.watches.snapshot().every((watch) => watch.paused)).toBe(true);
    expect(h.watches.resume("server", "resource://manual")).toBe(true);
    await h.settle();
    expect(
      h.watches.snapshot().find((watch) => watch.uri === "resource://manual")!
        .paused,
    ).toBe(false);
  });
});

describe("McpResourceWatches read queue", () => {
  it("catches up initially and on reconnect, with no idle delivery without wake consent", async () => {
    const h = harness();
    await h.add();
    expect(h.options.read).toHaveBeenCalledWith(
      "server",
      "resource://one",
      expect.any(AbortSignal),
    );
    expect(h.watches.reservePending({ idle: true })).toBeUndefined();
    expect(h.watches.reservePending({ idle: false })).toBeDefined();
    h.subscriptions[0]!.handlers.onReconnected();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(h.options.read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.options.read).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(h.watches.snapshot())).not.toContain(
      "first snapshot",
    );
  });

  it("retains dirty notifications arriving during reads and reads one latest snapshot", async () => {
    const h = harness();
    const read = deferred<{ text: string }>();
    h.options.read
      .mockReturnValueOnce(read.promise)
      .mockResolvedValue({ text: "newest" });
    await h.add();
    h.update();
    h.update();
    read.resolve({ text: "old" });
    await h.settle();
    expect(h.options.read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.options.read).toHaveBeenCalledTimes(2);
    const batch = h.watches.reservePending({ idle: false })!;
    expect(batch.updates.map((update) => update.text)).toEqual(["newest"]);
  });

  it.each(["pause", "revoke", "downgrade", "identity", "upgrade"])(
    "drops a late read after %s",
    async (action) => {
      const h = harness();
      const read = deferred<{ text: string }>();
      h.options.read.mockReturnValueOnce(read.promise);
      await h.add();
      const signal = h.options.read.mock.calls[0]![2];
      if (action === "pause") h.watches.pause("server", "resource://one");
      if (action === "revoke") h.watches.unwatch("server", "resource://one");
      if (action === "downgrade") await h.add("resource://one", "notify");
      if (action === "identity") {
        h.identities.set("server", "replacement");
        h.watches.refresh();
      }
      if (action === "upgrade") {
        h.options.requestApproval.mockReturnValueOnce(
          deferred<McpResourceWatchMode | "deny">().promise,
        );
        void h.watches.watch("server", "resource://one", "wake");
      }
      expect(signal.aborted).toBe(true);
      read.resolve({ text: "late body" });
      await h.settle();
      expect(h.watches.reservePending({ idle: false })).toBeUndefined();
      expect(h.options.onPending).not.toHaveBeenCalled();
    },
  );

  it("only commits dedup after transcript admission, not reads or release", async () => {
    const h = harness();
    await h.add();
    const first = h.watches.reservePending({ idle: false })!;
    expect(h.watches.reservePending({ idle: false })).toBeUndefined();
    h.watches.releasePending(first);
    const retry = h.watches.reservePending({ idle: false })!;
    expect(retry.updates[0]!.id).toBe(first.updates[0]!.id);
    expect(h.watches.commitPending(first)).toBe(false);
    expect(h.watches.commitPending(retry)).toBe(true);
    expect(h.watches.commitPending(retry)).toBe(false);
    h.update();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.watches.reservePending({ idle: false })).toBeUndefined();
    expect(h.options.read).toHaveBeenCalledTimes(2);
  });

  it("invalidates a reserved older snapshot when a newer snapshot replaces it", async () => {
    const h = harness();
    await h.add();
    const batch = h.watches.reservePending({ idle: false })!;
    h.options.read.mockResolvedValue({ text: "new body" });
    h.update();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.watches.isBatchValid(batch)).toBe(false);
    h.watches.releasePending(batch);
    expect(h.watches.reservePending({ idle: false })!.updates[0]!.text).toBe(
      "new body",
    );
  });

  it("does not queue empty text or turn structured errors into content", async () => {
    const h = harness();
    h.options.read.mockResolvedValueOnce({ text: "" });
    await h.add();
    expect(h.options.onPending).not.toHaveBeenCalled();
    h.options.read.mockResolvedValueOnce({ error: "interaction_required" });
    h.update();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.watches.reservePending({ idle: false })).toBeUndefined();
    expect(h.watches.snapshot()[0]).toMatchObject({
      paused: true,
      reason: expect.stringContaining("Action required"),
    });
    h.watches.noteUserTurn();
    expect(h.watches.snapshot()[0]!.paused).toBe(true);
  });

  it("rejects unsupported payloads without injecting an error body", async () => {
    const h = harness();
    h.options.read.mockResolvedValueOnce({
      text: new Uint8Array([1, 2]),
    } as unknown as { text: string });
    await h.add();
    expect(h.watches.snapshot()[0]).toMatchObject({
      paused: true,
      reason: "Action required: unsupported resource content",
    });
    expect(h.watches.reservePending({ idle: false })).toBeUndefined();
    expect(h.options.onPending).not.toHaveBeenCalled();
  });

  it("dispose aborts reads, cancels dirty timers, and ignores late callbacks", async () => {
    const h = harness();
    const read = deferred<{ text: string }>();
    h.options.read.mockReturnValueOnce(read.promise);
    await h.add();
    const signal = h.options.read.mock.calls[0]![2];
    h.update();
    await h.watches.dispose();
    expect(signal.aborted).toBe(true);
    read.resolve({ text: "late" });
    h.subscriptions[0]!.handlers.onUpdated("resource://one");
    h.subscriptions[0]!.handlers.onReconnected();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.options.read).toHaveBeenCalledTimes(1);
    expect(h.watches.snapshot()).toEqual([]);
    expect(h.options.onPending).not.toHaveBeenCalled();
    expect(h.subscriptions[0]!.dispose).toHaveBeenCalledTimes(1);
  });

  it("bounds UTF-8 text per read and aggregate queued content without truncation", async () => {
    const h = harness();
    h.options.read.mockResolvedValue({ text: "é".repeat(32_769) });
    await h.add("resource://oversize");
    expect(h.watches.snapshot()[0]!.paused).toBe(true);
    h.watches.unwatch("server", "resource://oversize");
    h.options.read.mockResolvedValue({ text: "a".repeat(65_536) });
    await h.add("resource://a");
    await h.add("resource://b");
    await h.add("resource://c");
    expect(
      h.watches.snapshot().find((watch) => watch.uri === "resource://c")!
        .paused,
    ).toBe(true);
    const batch = h.watches.reservePending({ idle: false })!;
    expect(batch.updates.map((update) => update.text.length)).toEqual([
      65_536, 65_536,
    ]);
  });

  it("limits six reads per minute across all servers and cancels deferred reads on stop", async () => {
    const h = harness();
    await h.add("resource://one", "deliver", "server");
    await h.add("resource://two", "deliver", "other");
    for (let i = 0; i < 3; i++) {
      h.update("resource://one", "server");
      h.update("resource://two", "other");
      await vi.advanceTimersByTimeAsync(5_000);
    }
    expect(h.options.read).toHaveBeenCalledTimes(6);
    h.watches.pauseAll();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.options.read).toHaveBeenCalledTimes(6);
  });
});

describe("McpResourceWatches session-wide automatic budgets", () => {
  it("counts active batches, pauses after three, and watch recreation cannot reset the limit", async () => {
    const h = harness();
    await h.add();
    for (let i = 0; i < 3; i++) {
      if (i) {
        h.options.read.mockResolvedValue({ text: `body-${i}` });
        h.update();
        await vi.advanceTimersByTimeAsync(5_000);
      }
      const batch = h.watches.reservePending({ idle: false })!;
      expect(h.watches.commitPending(batch)).toBe(true);
    }
    expect(h.watches.snapshot()[0]).toMatchObject({
      paused: true,
      reason: "Paused, automatic-update limit reached",
    });
    h.watches.unwatch("server", "resource://one");
    await h.add();
    expect(h.watches.snapshot()[0]!.paused).toBe(true);
    const count = h.options.read.mock.calls.length;
    h.update();
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(h.options.read).toHaveBeenCalledTimes(count);
    h.watches.noteUserTurn();
    await h.settle();
    expect(h.watches.reservePending({ idle: false })).toBeDefined();
  });

  it("reserves wake attempts globally, release does not refund, and timers cannot resume", async () => {
    const h = harness();
    await h.add("resource://one", "wake");
    await h.add("resource://two", "wake", "other");
    const first = h.watches.reservePending({ idle: true })!;
    expect(first.updates).toHaveLength(2);
    h.watches.releasePending(first);
    expect(h.watches.reservePending({ idle: true })).toBeUndefined();
    expect(h.watches.snapshot().every((watch) => watch.paused)).toBe(true);
    await vi.advanceTimersByTimeAsync(300_000);
    h.update();
    await h.settle();
    expect(h.watches.reservePending({ idle: true })).toBeUndefined();
    h.watches.noteUserTurn();
    await h.settle();
    expect(h.watches.reservePending({ idle: true })).toBeDefined();
  });

  it("allows six wake attempts per rolling hour even across genuine user turns", async () => {
    const h = harness();
    await h.add("resource://one", "wake");
    for (let i = 0; i < 6; i++) {
      if (i) {
        await vi.advanceTimersByTimeAsync(300_000);
        h.watches.noteUserTurn();
        h.options.read.mockResolvedValue({ text: `body-${i}` });
        h.update();
        await h.settle();
      }
      const batch = h.watches.reservePending({ idle: true });
      expect(batch).toBeDefined();
      expect(h.watches.commitPending(batch!)).toBe(true);
    }
    await vi.advanceTimersByTimeAsync(300_000);
    h.watches.noteUserTurn();
    h.options.read.mockResolvedValue({ text: "seventh" });
    h.update();
    await h.settle();
    expect(h.watches.reservePending({ idle: true })).toBeUndefined();
    expect(h.watches.snapshot()[0]).toMatchObject({
      paused: true,
      reason: "Paused, automatic-wake limit reached",
    });
  });

  it("a genuine user start supersedes an idle reservation without consuming the content", async () => {
    const h = harness();
    await h.add("resource://one", "wake");
    const idle = h.watches.reservePending({ idle: true })!;
    h.watches.noteUserTurn();
    expect(h.watches.isBatchValid(idle)).toBe(false);
    const active = h.watches.reservePending({ idle: false })!;
    expect(active.updates[0]!.id).toBe(idle.updates[0]!.id);
    expect(h.watches.commitPending(active)).toBe(true);
  });

  it("idle batches exclude deliver-only resources while active batches include both", async () => {
    const h = harness();
    await h.add("resource://one", "deliver");
    await h.add("resource://two", "wake");
    const idle = h.watches.reservePending({ idle: true })!;
    expect(idle.updates.map((update) => update.uri)).toEqual([
      "resource://two",
    ]);
    h.watches.commitPending(idle);
    const active = h.watches.reservePending({ idle: false })!;
    expect(active.updates.map((update) => update.uri)).toEqual([
      "resource://one",
    ]);
  });
});
