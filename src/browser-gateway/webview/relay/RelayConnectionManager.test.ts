import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION,
  type BrowserGatewayOwnerCheckpoint,
  type BrowserGatewayOwnerEvent,
} from "../../dataPlane/protocol";
import {
  RelayConnectionManager,
  type RelayEventSource,
} from "./RelayConnectionManager";
import { RelayOwnerStore } from "./RelayOwnerStore";

const helperGenerationId = "helper-1";
const ownerId = "owner-1";
const ownerGenerationId = "generation-1";

class EventSourceFixture implements RelayEventSource {
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readonly listeners = new Map<
    string,
    Array<(event: MessageEvent<string>) => void>
  >();
  closed = false;
  closeCount = 0;

  constructor(readonly url: string) {}

  close(): void {
    this.closed = true;
    this.closeCount += 1;
  }

  addEventListener(
    type: string,
    listener: (event: MessageEvent<string>) => void,
  ): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  emit(type: string, value: unknown): void {
    const event = { data: JSON.stringify(value) } as MessageEvent<string>;
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function checkpoint(
  overrides: Partial<BrowserGatewayOwnerCheckpoint> = {},
): BrowserGatewayOwnerCheckpoint {
  return {
    protocolVersion: BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION,
    helperGenerationId,
    ownerId,
    ownerGenerationId,
    checkpointId: "checkpoint-1",
    checkpointSequence: 1,
    emittedAt: 1,
    foreground: null,
    catalog: {
      projects: [],
      sessions: [],
      defaultProjectId: null,
      foregroundSessionId: null,
    },
    transcript: { messages: [], earlierCursor: null, hasEarlier: false },
    ui: { interaction: null, queue: [], todos: [], operations: [] },
    background: [],
    fleet: [],
    diffs: [],
    repository: null,
    theme: { revision: "theme-1", colorScheme: "dark", variables: [] },
    modelCatalogRevision: "models-1",
    capabilities: [],
    ...overrides,
  };
}

function hello(connectionId = "connection-1") {
  return {
    protocolVersion: BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION,
    helperGenerationId,
    browserConnectionId: connectionId,
    csrfNonce: `nonce-${connectionId}`,
    emittedAt: 1,
  };
}

function subscription(
  connectionId = "connection-1",
  subscriptionId = "subscription-1",
) {
  return {
    ok: true,
    protocolVersion: BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION,
    helperGenerationId,
    browserConnectionId: connectionId,
    subscriptionId,
    ownerId,
    ownerGenerationId,
  };
}

function checkpointEnvelope(subscriptionId = "subscription-1", sequence = 2) {
  return {
    protocolVersion: BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION,
    helperGenerationId,
    subscriptionId,
    ownerId,
    ownerGenerationId,
    record: {
      kind: "checkpoint",
      relaySequence: 10,
      ownerId,
      ownerGenerationId,
      ownerSequence: sequence,
      emittedAt: sequence,
      checkpoint: checkpoint({
        checkpointId: `checkpoint-${sequence}`,
        checkpointSequence: sequence,
      }),
    },
  };
}

function eventEnvelope(
  event: BrowserGatewayOwnerEvent,
  subscriptionId = "subscription-1",
  relaySequence = event.ownerSequence + 10,
) {
  return {
    protocolVersion: BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION,
    helperGenerationId,
    subscriptionId,
    ownerId,
    ownerGenerationId,
    record: {
      kind: "event",
      relaySequence,
      ownerSequence: event.ownerSequence,
      emittedAt: event.emittedAt,
      event,
    },
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function deferredResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("RelayConnectionManager", () => {
  beforeEach(() => vi.useRealTimers());

  it("reports connected only after a valid authenticated hello", () => {
    const statuses: string[] = [];
    const source = new EventSourceFixture("/api/relay/events");
    const manager = new RelayConnectionManager({
      store: new RelayOwnerStore(),
      eventSourceFactory: () => source,
      onStatus: (status) => statuses.push(status),
    });

    manager.start();
    expect(statuses.at(-1)).toBe("connecting");
    source.onopen?.({} as Event);
    expect(statuses).not.toContain("connected");

    source.emit("hello", hello());
    expect(statuses.at(-1)).toBe("connected");
    manager.close();
  });

  it("keeps one EventSource across owner selection and applies only the authoritative subscription", async () => {
    const sources: EventSourceFixture[] = [];
    const subscriptionResponse = deferredResponse();
    const fetch = vi.fn(() => subscriptionResponse.promise);
    const checkpoints: BrowserGatewayOwnerCheckpoint[] = [];
    const store = new RelayOwnerStore();
    store.applyCheckpoint(helperGenerationId, {
      kind: "checkpoint",
      relaySequence: 5,
      ownerSequence: 1,
      checkpoint: checkpoint({ checkpointId: "cached" }),
    });
    const manager = new RelayConnectionManager({
      store,
      eventSourceFactory: (url) => {
        const source = new EventSourceFixture(url);
        sources.push(source);
        return source;
      },
      fetch: fetch as unknown as typeof globalThis.fetch,
      onCheckpoint: (_owner, _generation, value) => checkpoints.push(value),
    });

    manager.start();
    manager.selectOwner({ ownerId, ownerGenerationId });
    expect(sources).toHaveLength(1);
    sources[0]!.emit("catalog", {
      protocolVersion: BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION,
      helperGenerationId: "stale-helper",
      owners: [],
    });
    expect(fetch).not.toHaveBeenCalled();
    sources[0]!.emit("hello", hello());
    await flushPromises();
    expect(fetch).toHaveBeenCalledTimes(1);

    sources[0]!.emit("reset", {
      protocolVersion: BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION,
      helperGenerationId,
      subscriptionId: "temporary-subscription",
      ownerId,
      ownerGenerationId,
      reason: "subscription_changed",
      latestSequence: 1,
    });
    expect(store.getCheckpoint(ownerId, ownerGenerationId)?.checkpointId).toBe(
      "cached",
    );
    sources[0]!.emit(
      "checkpoint",
      checkpointEnvelope("temporary-subscription"),
    );
    sources[0]!.emit("checkpoint", checkpointEnvelope("subscription-1"));
    expect(checkpoints.map((value) => value.checkpointId)).toEqual(["cached"]);
    subscriptionResponse.resolve(jsonResponse(subscription(), 202));
    await flushPromises();

    expect(checkpoints).toHaveLength(2);
    expect(checkpoints.at(-1)?.checkpointId).toBe("checkpoint-2");
    expect(sources).toHaveLength(1);
    manager.close();
  });

  it("forwards the exact source event only for newly applied event frames", async () => {
    const sources: EventSourceFixture[] = [];
    const commits: Array<{
      checkpoint: BrowserGatewayOwnerCheckpoint;
      sourceEvent?: BrowserGatewayOwnerEvent;
    }> = [];
    const manager = new RelayConnectionManager({
      store: new RelayOwnerStore(),
      eventSourceFactory: (url) => {
        const source = new EventSourceFixture(url);
        sources.push(source);
        return source;
      },
      fetch: vi.fn(async () => jsonResponse(subscription(), 202)),
      onCheckpoint: (_owner, _generation, value, sourceEvent) =>
        commits.push({ checkpoint: value, sourceEvent }),
    });

    manager.selectOwner({ ownerId, ownerGenerationId });
    manager.start();
    sources[0]!.emit("hello", hello());
    await flushPromises();
    sources[0]!.emit("checkpoint", checkpointEnvelope("subscription-1", 1));
    const sourceEvent: BrowserGatewayOwnerEvent = {
      protocolVersion: BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION,
      helperGenerationId,
      ownerId,
      ownerGenerationId,
      ownerSequence: 2,
      eventId: "event-2",
      kind: "queue.updated",
      emittedAt: 123,
      payload: { queue: [] },
    };
    sources[0]!.emit(
      "owner.event",
      eventEnvelope(sourceEvent, "stale-subscription"),
    );
    sources[0]!.emit("owner.event", eventEnvelope(sourceEvent));
    sources[0]!.emit(
      "owner.event",
      eventEnvelope(sourceEvent, "subscription-1", 12),
    );
    sources[0]!.emit(
      "owner.event",
      eventEnvelope(
        { ...sourceEvent, ownerSequence: 4, eventId: "event-gap" },
        "subscription-1",
        14,
      ),
    );
    await flushPromises();

    expect(commits).toHaveLength(2);
    expect(commits[0]).toMatchObject({
      checkpoint: { checkpointId: "checkpoint-1" },
      sourceEvent: undefined,
    });
    expect(commits[1]?.sourceEvent).toEqual(sourceEvent);
    expect(commits[1]?.sourceEvent).toMatchObject({
      eventId: "event-2",
      ownerSequence: 2,
      emittedAt: 123,
    });
    manager.close();
  });

  it("commits cached owner state synchronously before posting a new subscription", () => {
    const store = new RelayOwnerStore();
    const cached = checkpoint();
    store.applyCheckpoint(helperGenerationId, {
      kind: "checkpoint",
      relaySequence: 10,
      ownerSequence: 1,
      checkpoint: cached,
    });
    const committed: BrowserGatewayOwnerCheckpoint[] = [];
    const manager = new RelayConnectionManager({
      store,
      eventSourceFactory: (url) => new EventSourceFixture(url),
      fetch: vi.fn() as unknown as typeof globalThis.fetch,
      onCheckpoint: (_owner, _generation, value) => committed.push(value),
    });

    manager.selectOwner({ ownerId, ownerGenerationId });
    expect(committed).toEqual([cached]);

    manager.selectOwner({ ownerId, ownerGenerationId });
    expect(committed).toEqual([cached]);
    manager.close();
  });

  it("recreates EventSource with a qualified cursor after transport failure", async () => {
    vi.useFakeTimers();
    const sources: EventSourceFixture[] = [];
    const store = new RelayOwnerStore();
    store.applyCheckpoint(helperGenerationId, {
      kind: "checkpoint",
      relaySequence: 42,
      ownerSequence: 1,
      checkpoint: checkpoint(),
    });
    const manager = new RelayConnectionManager({
      store,
      eventSourceFactory: (url) => {
        const source = new EventSourceFixture(url);
        sources.push(source);
        return source;
      },
      fetch: vi.fn(async () => jsonResponse(subscription(), 202)),
      random: () => 0,
      minimumReconnectMs: 100,
      maximumReconnectMs: 100,
    });

    manager.selectOwner({ ownerId, ownerGenerationId });
    manager.start();
    expect(sources[0]?.url).toContain(
      `cursor=${encodeURIComponent(`${helperGenerationId}/${ownerId}/${ownerGenerationId}/42`)}`,
    );
    sources[0]!.emit("hello", hello());
    await flushPromises();
    sources[0]!.onerror?.({} as Event);
    await vi.advanceTimersByTimeAsync(75);

    expect(sources).toHaveLength(2);
    expect(sources[0]?.closed).toBe(true);
    manager.close();
  });

  it("recreates a stalled active stream with its qualified cursor", async () => {
    vi.useFakeTimers();
    const sources: EventSourceFixture[] = [];
    const store = new RelayOwnerStore();
    store.applyCheckpoint(helperGenerationId, {
      kind: "checkpoint",
      relaySequence: 7,
      ownerSequence: 1,
      checkpoint: checkpoint(),
    });
    const manager = new RelayConnectionManager({
      store,
      eventSourceFactory: (url) => {
        const source = new EventSourceFixture(url);
        sources.push(source);
        return source;
      },
      fetch: vi.fn(async () => jsonResponse(subscription(), 202)),
      staleVisibleTimeoutMs: 1_000,
      minimumReconnectMs: 100,
      maximumReconnectMs: 100,
      random: () => 0,
    });

    manager.selectOwner({ ownerId, ownerGenerationId });
    manager.start();
    sources[0]!.emit("hello", hello());
    await flushPromises();
    await vi.advanceTimersByTimeAsync(1_075);

    expect(sources).toHaveLength(2);
    expect(sources[0]?.closed).toBe(true);
    expect(sources[1]?.url).toContain(
      `cursor=${encodeURIComponent(`${helperGenerationId}/${ownerId}/${ownerGenerationId}/7`)}`,
    );
    manager.close();
  });

  it("resolves operations when the selected owner generation rolls over", async () => {
    const sources: EventSourceFixture[] = [];
    const operations: Array<{ state: string; message?: string }> = [];
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.endsWith("/subscription"))
        return jsonResponse(subscription(), 202);
      if (path.endsWith("/commands")) {
        return jsonResponse(
          {
            ok: true,
            ownerId,
            ownerGenerationId,
            operation: {
              operationId: "send-rollover",
              kind: "session.send",
              state: "accepted",
            },
          },
          202,
        );
      }
      throw new Error(`unexpected request: ${path}`);
    });
    const manager = new RelayConnectionManager({
      store: new RelayOwnerStore(),
      eventSourceFactory: (url) => {
        const source = new EventSourceFixture(url);
        sources.push(source);
        return source;
      },
      fetch: fetch as unknown as typeof globalThis.fetch,
      onOperation: (operation) => operations.push(operation),
    });

    manager.selectOwner({ ownerId, ownerGenerationId });
    manager.start();
    sources[0]!.emit("hello", hello());
    await flushPromises();
    await manager.sendCommand({
      operationId: "send-rollover",
      command: {
        kind: "session.send",
        sessionId: "session-1",
        text: "hello",
        detailHandles: [],
      },
    });
    manager.selectOwner({ ownerId, ownerGenerationId: "generation-2" });

    expect(operations.at(-1)).toEqual({
      operationId: "send-rollover",
      kind: "session.send",
      state: "uncertain",
      message: "owner_generation_changed",
    });
    expect(
      fetch.mock.calls.filter(([path]) => String(path).endsWith("/commands")),
    ).toHaveLength(1);
    manager.close();
  });

  it("converges across 100 mixed reconnect, helper-restart, and owner-restart cycles", async () => {
    vi.useFakeTimers();
    const sources: EventSourceFixture[] = [];
    const checkpoints: BrowserGatewayOwnerCheckpoint[] = [];
    const statuses: string[] = [];
    const store = new RelayOwnerStore();
    let currentHelperGenerationId = "helper-cycle-1";
    let currentSubscriptionId = "";
    let subscriptionCount = 0;
    const fetch = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        const request = JSON.parse(String(init?.body)) as {
          browserConnectionId: string;
          ownerId: string;
          ownerGenerationId: string;
        };
        currentSubscriptionId = `subscription-cycle-${++subscriptionCount}`;
        return jsonResponse(
          {
            ok: true,
            protocolVersion: BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION,
            helperGenerationId: currentHelperGenerationId,
            browserConnectionId: request.browserConnectionId,
            subscriptionId: currentSubscriptionId,
            ownerId: request.ownerId,
            ownerGenerationId: request.ownerGenerationId,
          },
          202,
        );
      },
    );
    const manager = new RelayConnectionManager({
      store,
      eventSourceFactory: (url) => {
        const source = new EventSourceFixture(url);
        sources.push(source);
        return source;
      },
      fetch: fetch as unknown as typeof globalThis.fetch,
      random: () => 0,
      minimumReconnectMs: 100,
      maximumReconnectMs: 100,
      onCheckpoint: (_owner, _generation, value) => checkpoints.push(value),
      onStatus: (status) => statuses.push(status),
    });

    let selectedOwnerGenerationId = "";
    manager.start();
    for (let cycle = 1; cycle <= 100; cycle += 1) {
      currentHelperGenerationId = `helper-cycle-${Math.floor((cycle - 1) / 10) + 1}`;
      const ownerGeneration = `generation-cycle-${Math.floor((cycle - 1) / 3) + 1}`;
      if (ownerGeneration !== selectedOwnerGenerationId) {
        selectedOwnerGenerationId = ownerGeneration;
        manager.selectOwner({
          ownerId,
          ownerGenerationId: selectedOwnerGenerationId,
        });
      }

      const source = sources.at(-1)!;
      const connectionId = `connection-cycle-${cycle}`;
      source.emit("hello", {
        protocolVersion: BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION,
        helperGenerationId: currentHelperGenerationId,
        browserConnectionId: connectionId,
        csrfNonce: `nonce-${connectionId}`,
        emittedAt: cycle,
      });
      await flushPromises();
      expect(
        manager.isSubscribedTo({
          ownerId,
          ownerGenerationId: selectedOwnerGenerationId,
        }),
      ).toBe(true);

      const relaySequence = cycle * 10;
      const accepted = checkpoint({
        helperGenerationId: currentHelperGenerationId,
        ownerGenerationId: selectedOwnerGenerationId,
        checkpointId: `checkpoint-cycle-${cycle}`,
        checkpointSequence: cycle,
        emittedAt: cycle,
      });
      source.emit("checkpoint", {
        protocolVersion: BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION,
        helperGenerationId: currentHelperGenerationId,
        subscriptionId: currentSubscriptionId,
        ownerId,
        ownerGenerationId: selectedOwnerGenerationId,
        record: {
          kind: "checkpoint",
          relaySequence,
          ownerSequence: cycle,
          checkpoint: accepted,
        },
      });
      expect(checkpoints.at(-1)?.checkpointId).toBe(
        `checkpoint-cycle-${cycle}`,
      );

      source.onerror?.({} as Event);
      await vi.advanceTimersByTimeAsync(75);
      expect(source.closeCount).toBe(1);
      expect(sources).toHaveLength(cycle + 1);
      expect(sources.at(-1)?.url).toContain(
        `cursor=${encodeURIComponent(
          `${currentHelperGenerationId}/${ownerId}/${selectedOwnerGenerationId}/${relaySequence}`,
        )}`,
      );

      source.emit("checkpoint", {
        protocolVersion: BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION,
        helperGenerationId: currentHelperGenerationId,
        subscriptionId: currentSubscriptionId,
        ownerId,
        ownerGenerationId: selectedOwnerGenerationId,
        record: {
          kind: "checkpoint",
          relaySequence: relaySequence + 1,
          ownerSequence: cycle + 1_000,
          checkpoint: {
            ...accepted,
            checkpointId: `stale-checkpoint-cycle-${cycle}`,
            checkpointSequence: cycle + 1_000,
          },
        },
      });
      expect(checkpoints.at(-1)?.checkpointId).toBe(
        `checkpoint-cycle-${cycle}`,
      );
    }

    manager.close();
    expect(checkpoints).toHaveLength(100);
    expect(subscriptionCount).toBe(100);
    expect(sources).toHaveLength(101);
    expect(sources.every((source) => source.closeCount === 1)).toBe(true);
    expect(statuses.at(-1)).toBe("closed");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("re-resolves accepted operations after reconnect without resubmitting commands", async () => {
    vi.useFakeTimers();
    const sources: EventSourceFixture[] = [];
    const operations: Array<{ state: string; message?: string }> = [];
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.endsWith("/subscription")) {
        const connectionId =
          sources.length === 1 ? "connection-1" : "connection-2";
        const subscriptionId =
          sources.length === 1 ? "subscription-1" : "subscription-2";
        return jsonResponse(subscription(connectionId, subscriptionId), 202);
      }
      if (path.endsWith("/commands")) {
        return jsonResponse(
          {
            ok: true,
            ownerId,
            ownerGenerationId,
            operation: {
              operationId: "send-1",
              kind: "session.send",
              state: "accepted",
            },
          },
          202,
        );
      }
      if (path.endsWith("/operations/status")) {
        return jsonResponse({ error: "operation_not_found" }, 404);
      }
      throw new Error(`unexpected request: ${path}`);
    });
    const manager = new RelayConnectionManager({
      store: new RelayOwnerStore(),
      eventSourceFactory: (url) => {
        const source = new EventSourceFixture(url);
        sources.push(source);
        return source;
      },
      fetch: fetch as unknown as typeof globalThis.fetch,
      random: () => 0,
      minimumReconnectMs: 100,
      maximumReconnectMs: 100,
      onOperation: (operation) => operations.push(operation),
    });

    manager.selectOwner({ ownerId, ownerGenerationId });
    manager.start();
    sources[0]!.emit("hello", hello("connection-1"));
    await flushPromises();
    await manager.sendCommand({
      operationId: "send-1",
      command: {
        kind: "session.send",
        sessionId: "session-1",
        text: "hello",
        detailHandles: [],
      },
    });
    sources[0]!.onerror?.({} as Event);
    await vi.advanceTimersByTimeAsync(75);
    sources[1]!.emit("hello", hello("connection-2"));
    await vi.waitFor(() => {
      expect(operations.at(-1)).toEqual({
        operationId: "send-1",
        kind: "session.send",
        state: "uncertain",
        message: "operation_status_unavailable_do_not_retry",
      });
    });

    expect(
      fetch.mock.calls.filter(([path]) => String(path).endsWith("/commands")),
    ).toHaveLength(1);
    expect(
      fetch.mock.calls.filter(([path]) =>
        String(path).endsWith("/operations/status"),
      ),
    ).toHaveLength(1);
    manager.close();
  });
});
