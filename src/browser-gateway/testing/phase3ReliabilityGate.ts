import { EventEmitter } from "node:events";
import type * as http from "node:http";
import { Readable } from "node:stream";

import { BrowserGatewayCoreOwnerRegistry } from "../coreOwnerRegistry.js";
import {
  BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION,
  type BrowserGatewayOwnerCheckpoint,
  type BrowserGatewayOwnerEvent,
  type BrowserGatewayTranscriptMessage,
} from "../dataPlane/protocol.js";
import type { HelperLifecycleCoordinator } from "../helper/HelperLifecycleCoordinator.js";
import { OwnerRelayStore } from "../helper/OwnerRelayStore.js";
import { BrowserGatewayRelayRoutes } from "../helper/relayRoutes.js";
import { SseHub, type SsePublication } from "../SseHub.js";
import {
  createRelaySseFrame,
  RelaySseClientQueue,
  type RelaySseWritable,
} from "../helper/RelaySseClientQueue.js";
import {
  RelayConnectionManager,
  type RelayEventSource,
} from "../webview/relay/RelayConnectionManager.js";
import { RelayOwnerStore } from "../webview/relay/RelayOwnerStore.js";
import { GatewayGenerationFaultHarness } from "./GatewayGenerationFaultHarness.js";
import {
  ControllableSseRequest,
  ControllableSseResponse,
  createDeferred,
} from "./SseFaultPeer.js";

export const PHASE3_RELIABILITY_FOCUSED_SUITES = [
  "src/browser-gateway/testing/GatewayGenerationFaultHarness.test.ts",
  "src/browser-gateway/testing/SseFaultPeer.test.ts",
  "src/browser-gateway/helper/browserGatewayGenerationFaults.test.ts",
  "src/browser-gateway/helper/RelaySseClientQueue.test.ts",
  "src/browser-gateway/helper/browserGatewayHelper.lifecycle.integration.test.ts",
  "src/browser-gateway/helper/browserGatewayRelay.integration.test.ts",
  "src/browser-gateway/webview/relay/RelayConnectionManager.test.ts",
  "src/browser-gateway/webview/relay/RelayOwnerStore.test.ts",
] as const;

export interface Phase3ReliabilityGateReport {
  readonly cycles: number;
  readonly ownerRestartConvergences: number;
  readonly helperRestartConvergences: number;
  readonly staleHeartbeatsRejected: number;
  readonly staleLeasesRejected: number;
  readonly delayedCaptureCompacted: boolean;
  readonly backpressureDisconnected: boolean;
  readonly replacementClientConverged: boolean;
  readonly disconnectedCaptureAborted: boolean;
  readonly relayQueueCompactionCleared: boolean;
  readonly relayQueueCleanupComplete: boolean;
  readonly stallDeadlineCleanupComplete: boolean;
  readonly relaySlowClientCompactionRequested: boolean;
  readonly relaySlowClientCheckpointRecovered: boolean;
  readonly relaySlowClientStatePreserved: boolean;
  readonly relaySlowClientCompactedTailHidden: boolean;
  readonly delegatedFocusedSuites: readonly string[];
  readonly failures: readonly string[];
  readonly converged: boolean;
}

const RELAY_HELPER_GENERATION_ID = "phase3-relay-helper";
const RELAY_OWNER_ID = "phase3-relay-owner";
const RELAY_OWNER_GENERATION_ID = "phase3-relay-owner-generation";
const RELAY_ORIGIN = "http://127.0.0.1:47200";
const RELAY_AUTH = {
  sessionKey: "phase3-device-session",
  deviceId: "phase3-device",
} as const;

class RelayWritableFixture extends EventEmitter implements RelaySseWritable {
  readonly chunks: string[] = [];
  destroyed = false;
  writableEnded = false;
  blockWrites = false;

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return !this.blockWrites;
  }

  end(): void {
    this.writableEnded = true;
    this.emit("close");
  }

  destroy(): void {
    this.destroyed = true;
    this.emit("close");
  }
}

class RelayEventSourceFixture implements RelayEventSource {
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  private readonly listeners = new Map<
    string,
    Array<(event: MessageEvent<string>) => void>
  >();
  closed = false;

  constructor(readonly url: string) {}

  close(): void {
    this.closed = true;
  }

  addEventListener(
    type: string,
    listener: (event: MessageEvent<string>) => void,
  ): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  emit(type: string, data: string): void {
    if (this.closed) return;
    const event = { data } as MessageEvent<string>;
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

class RelayHttpResponseFixture extends EventEmitter {
  readonly socket = { setTimeout: (_timeout: number) => {} };
  readonly chunks: string[] = [];
  statusCode = 200;
  destroyed = false;
  writableEnded = false;
  blockWrites = false;

  constructor(private readonly source?: RelayEventSourceFixture) {
    super();
  }

  writeHead(status: number): this {
    this.statusCode = status;
    return this;
  }

  flushHeaders(): void {}

  write(chunk: string | Uint8Array): boolean {
    const text = String(chunk);
    this.chunks.push(text);
    this.dispatchSseFrame(text);
    return !this.blockWrites;
  }

  end(chunk?: string | Uint8Array): this {
    if (chunk !== undefined) this.write(chunk);
    this.writableEnded = true;
    this.emit("close");
    return this;
  }

  destroy(): this {
    this.destroyed = true;
    this.emit("close");
    return this;
  }

  asServerResponse(): http.ServerResponse {
    return this as unknown as http.ServerResponse;
  }

  private dispatchSseFrame(frame: string): void {
    if (!this.source) return;
    const eventLine = frame
      .split("\n")
      .find((line) => line.startsWith("event: "));
    const dataLine = frame
      .split("\n")
      .find((line) => line.startsWith("data: "));
    if (!eventLine || !dataLine) return;
    this.source.emit(eventLine.slice("event: ".length), dataLine.slice(6));
  }
}

export async function runPhase3ReliabilityGate(
  cycles = 100,
): Promise<Phase3ReliabilityGateReport> {
  if (!Number.isSafeInteger(cycles) || cycles <= 0) {
    throw new Error("phase3_reliability_cycles_must_be_positive");
  }

  const failures: string[] = [];
  let ownerRestartConvergences = 0;
  let helperRestartConvergences = 0;
  let staleHeartbeatsRejected = 0;
  let staleLeasesRejected = 0;

  for (let cycle = 1; cycle <= cycles; cycle += 1) {
    const harness = new GatewayGenerationFaultHarness({
      helperGenerationId: `phase3-helper-${cycle}-1`,
      ownerGenerationId: `phase3-owner-${cycle}-1`,
      ownerId: `phase3-owner-${cycle}`,
      now: cycle * 100_000,
    });
    const firstLease = harness.issueLease();
    const staleOwnerGeneration = harness.currentOwnerGenerationId;
    harness.restartOwner(`phase3-owner-${cycle}-2`);

    if (harness.heartbeat(staleOwnerGeneration) === undefined) {
      staleHeartbeatsRejected += 1;
    } else {
      failures.push(`cycle ${cycle}: stale owner heartbeat accepted`);
    }
    const staleOwnerLease = harness.validateLease(firstLease.leaseId);
    if (!staleOwnerLease.ok && staleOwnerLease.reason === "wrong_owner") {
      staleLeasesRejected += 1;
    } else {
      failures.push(`cycle ${cycle}: replacement owner accepted stale lease`);
    }

    const secondLease = harness.issueLease();
    if (harness.validateLease(secondLease.leaseId).ok) {
      ownerRestartConvergences += 1;
    } else {
      failures.push(`cycle ${cycle}: owner restart did not converge`);
    }

    harness.restartHelper(`phase3-helper-${cycle}-2`);
    if (harness.heartbeat() === undefined) staleHeartbeatsRejected += 1;
    else
      failures.push(`cycle ${cycle}: unregistered helper heartbeat accepted`);
    const staleHelperLease = harness.validateLease(secondLease.leaseId);
    if (!staleHelperLease.ok) staleLeasesRejected += 1;
    else failures.push(`cycle ${cycle}: stale helper lease accepted`);

    let rejectedBeforeRegistration = false;
    try {
      harness.issueLease();
    } catch {
      rejectedBeforeRegistration = true;
    }
    if (!rejectedBeforeRegistration) {
      failures.push(
        `cycle ${cycle}: helper restart did not require registration`,
      );
    }

    harness.registerCurrentOwner();
    const replacementLease = harness.issueLease();
    if (
      replacementLease.helperGenerationId ===
        harness.currentHelperGenerationId &&
      harness.validateLease(replacementLease.leaseId).ok
    ) {
      helperRestartConvergences += 1;
    } else {
      failures.push(`cycle ${cycle}: helper restart did not converge`);
    }
  }

  const sse = await runSseLifecycleScenario();
  if (!sse.delayedCaptureCompacted)
    failures.push(
      "delayed SSE capture did not compact to the latest publication",
    );
  if (!sse.backpressureDisconnected)
    failures.push("backpressured SSE client was not removed");
  if (!sse.replacementClientConverged)
    failures.push("replacement SSE client did not converge");
  if (!sse.disconnectedCaptureAborted)
    failures.push("disconnected initial SSE capture was not aborted");

  const queue = runRelayQueueScenario();
  if (!queue.compactionCleared)
    failures.push("relay queue retained compaction state after replacement");
  if (!queue.cleanupComplete)
    failures.push("relay queue retained bytes or lifecycle state after close");
  if (!queue.stallCleanupComplete)
    failures.push("relay queue stall deadline did not force complete cleanup");

  const slowClient = await runRelaySlowClientCompactionScenario();
  if (!slowClient.compactionRequested)
    failures.push("relay slow client did not request compaction");
  if (!slowClient.checkpointRecovered)
    failures.push("relay client did not recover from a compaction checkpoint");
  if (!slowClient.statePreserved)
    failures.push("relay compaction checkpoint lost visible client state");
  if (!slowClient.compactedTailHidden)
    failures.push("relay client rendered events superseded by compaction");

  return {
    cycles,
    ownerRestartConvergences,
    helperRestartConvergences,
    staleHeartbeatsRejected,
    staleLeasesRejected,
    delayedCaptureCompacted: sse.delayedCaptureCompacted,
    backpressureDisconnected: sse.backpressureDisconnected,
    replacementClientConverged: sse.replacementClientConverged,
    disconnectedCaptureAborted: sse.disconnectedCaptureAborted,
    relayQueueCompactionCleared: queue.compactionCleared,
    relayQueueCleanupComplete: queue.cleanupComplete,
    stallDeadlineCleanupComplete: queue.stallCleanupComplete,
    relaySlowClientCompactionRequested: slowClient.compactionRequested,
    relaySlowClientCheckpointRecovered: slowClient.checkpointRecovered,
    relaySlowClientStatePreserved: slowClient.statePreserved,
    relaySlowClientCompactedTailHidden: slowClient.compactedTailHidden,
    delegatedFocusedSuites: PHASE3_RELIABILITY_FOCUSED_SUITES,
    failures,
    converged: failures.length === 0,
  };
}

async function runSseLifecycleScenario(): Promise<{
  readonly delayedCaptureCompacted: boolean;
  readonly backpressureDisconnected: boolean;
  readonly replacementClientConverged: boolean;
  readonly disconnectedCaptureAborted: boolean;
}> {
  const removals: string[] = [];
  const hub = new SseHub<{ revision: number }>({
    serialize: JSON.stringify,
    keepaliveIntervalMs: 0,
    onClientRemoved: (reason) => removals.push(reason),
  });
  const delayedCapture = createDeferred<SsePublication<{ revision: number }>>();
  const firstRequest = new ControllableSseRequest();
  const firstResponse = new ControllableSseResponse();
  const firstSubscription = hub.subscribe(
    firstRequest.asIncomingMessage(),
    firstResponse.asServerResponse(),
    () => delayedCapture.promise,
  );
  hub.broadcast(publication(2));
  hub.broadcast(publication(4));
  hub.broadcast(publication(3));
  delayedCapture.resolve(publication(1));
  const selected = await firstSubscription;
  const delayedCaptureCompacted =
    selected?.revision === 4 && firstResponse.writes.length === 1;

  firstResponse.enqueueWriteOutcome(false);
  hub.broadcast(publication(5));
  const backpressureDisconnected =
    removals.includes("backpressure") &&
    firstResponse.destroyCount === 1 &&
    hub.size === 0;

  const replacementRequest = new ControllableSseRequest();
  const replacementResponse = new ControllableSseResponse();
  const replacement = await hub.subscribe(
    replacementRequest.asIncomingMessage(),
    replacementResponse.asServerResponse(),
    () => publication(5),
  );
  const delivered = hub.broadcast(publication(6));
  const replacementClientConverged =
    replacement?.revision === 5 &&
    delivered.attempted === 1 &&
    delivered.delivered === 1 &&
    replacementResponse.writes.at(-1)?.includes('"revision":6') === true;
  replacementRequest.close();

  const stalledRequest = new ControllableSseRequest();
  const stalledResponse = new ControllableSseResponse();
  let captureSignal: AbortSignal | undefined;
  const stalledSubscription = hub.subscribe(
    stalledRequest.asIncomingMessage(),
    stalledResponse.asServerResponse(),
    (signal) => {
      captureSignal = signal;
      return new Promise<SsePublication<{ revision: number }>>(() => {});
    },
  );
  stalledRequest.close();
  const stalledResult = await stalledSubscription;
  const disconnectedCaptureAborted =
    stalledResult === null &&
    captureSignal?.aborted === true &&
    stalledResponse.endCount === 1 &&
    hub.size === 0;
  hub.dispose();

  return {
    delayedCaptureCompacted,
    backpressureDisconnected,
    replacementClientConverged,
    disconnectedCaptureAborted,
  };
}

function runRelayQueueScenario(): {
  readonly compactionCleared: boolean;
  readonly cleanupComplete: boolean;
  readonly stallCleanupComplete: boolean;
} {
  const writable = new RelayWritableFixture();
  writable.blockWrites = true;
  const queue = new RelaySseClientQueue({
    writable,
    maxQueuedBytes: 1,
    requestCompaction: () => {},
  });
  queue.send(createRelaySseFrame({ event: "blocked", data: {} }));
  queue.send(
    createRelaySseFrame({
      event: "owner.event",
      data: { value: "large" },
      relaySequence: 5,
      ownerSequence: 7,
    }),
  );
  queue.replacePending([
    createRelaySseFrame({
      event: "checkpoint",
      data: { sequence: 7 },
      relaySequence: 6,
      ownerSequence: 7,
    }),
  ]);
  const compactionCleared = !queue.isAwaitingCompaction;
  queue.close(true);
  const cleanupComplete =
    queue.isClosed && queue.queuedByteLength === 0 && writable.destroyed;

  const stalledWritable = new RelayWritableFixture();
  stalledWritable.blockWrites = true;
  let stallCallback: (() => void) | undefined;
  const stalledQueue = new RelaySseClientQueue({
    writable: stalledWritable,
    stallDeadlineMs: 100,
    requestCompaction: () => {},
    setTimeout: (callback) => {
      stallCallback = callback;
      return { unref: () => {} } as unknown as NodeJS.Timeout;
    },
    clearTimeout: () => {},
  });
  stalledQueue.send(createRelaySseFrame({ event: "blocked", data: {} }));
  stallCallback?.();
  const stallCleanupComplete =
    stalledQueue.isClosed &&
    stalledQueue.queuedByteLength === 0 &&
    stalledWritable.destroyed;

  return { compactionCleared, cleanupComplete, stallCleanupComplete };
}

async function runRelaySlowClientCompactionScenario(): Promise<{
  readonly compactionRequested: boolean;
  readonly checkpointRecovered: boolean;
  readonly statePreserved: boolean;
  readonly compactedTailHidden: boolean;
}> {
  const registry = new BrowserGatewayCoreOwnerRegistry({
    heartbeatTtlMs: 30_000,
  });
  registry.register({
    ownerId: RELAY_OWNER_ID,
    ownerKind: "vscode",
    displayName: "Phase 3 owner",
    instanceId: "phase3-instance",
    scope: {
      kind: "workspace",
      workspaceId: "phase3-workspace",
      displayName: "Phase 3 workspace",
    },
    ownerGenerationId: RELAY_OWNER_GENERATION_ID,
    now: 1_000,
  });
  const relayStore = new OwnerRelayStore({
    helperGenerationId: RELAY_HELPER_GENERATION_ID,
    now: () => 1_000,
  });
  relayStore.ingestPublication(relayPublication(0, relayCheckpoint(0)));

  const checkpointRequests: number[] = [];
  const subscriptionReady = createDeferred<void>();
  let routes!: BrowserGatewayRelayRoutes;
  routes = new BrowserGatewayRelayRoutes({
    helperGenerationId: RELAY_HELPER_GENERATION_ID,
    ownerRegistry: registry,
    store: relayStore,
    lifecycle: {
      trackStream: () => () => undefined,
    } as unknown as HelperLifecycleCoordinator,
    now: () => 1_000,
    keepaliveIntervalMs: 0,
    isAllowedHost: (host) => host === "127.0.0.1:47200",
    onSubscriberCountChanged: (_ownerId, _ownerGenerationId, count) => {
      if (count === 1) subscriptionReady.resolve();
    },
    onCheckpointRequested: (_ownerId, _ownerGenerationId, sequence) => {
      checkpointRequests.push(sequence);
      relayStore.ingestPublication(
        relayPublication(
          sequence,
          relayCheckpoint(sequence, relayMessage(sequence)),
        ),
      );
    },
  });

  const visibleCheckpoints: BrowserGatewayOwnerCheckpoint[] = [];
  const clientReady = createDeferred<void>();
  const browserStore = new RelayOwnerStore();
  let source: RelayEventSourceFixture | undefined;
  let stream: RelayHttpResponseFixture | undefined;
  const manager = new RelayConnectionManager({
    store: browserStore,
    eventSourceFactory: (url) => {
      source = new RelayEventSourceFixture(url);
      return source;
    },
    fetch: (async (input, init) => {
      const requestUrl = new URL(String(input), RELAY_ORIGIN);
      const response = new RelayHttpResponseFixture();
      await routes.handle(
        "subscription",
        RELAY_AUTH,
        relayRequest({
          method: init?.method ?? "GET",
          url: requestUrl.pathname,
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
          headers: { origin: RELAY_ORIGIN },
        }),
        response.asServerResponse(),
        requestUrl,
      );
      return new Response(response.chunks.join(""), {
        status: response.statusCode,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof globalThis.fetch,
    setTimeout: ((..._args: Parameters<typeof globalThis.setTimeout>) =>
      ({ unref: () => {} }) as unknown as ReturnType<
        typeof globalThis.setTimeout
      >) as unknown as typeof globalThis.setTimeout,
    clearTimeout: (() => {}) as typeof globalThis.clearTimeout,
    onCheckpoint: (_ownerId, _ownerGenerationId, checkpoint) => {
      visibleCheckpoints.push(checkpoint);
      if (checkpoint.checkpointSequence === 0) clientReady.resolve();
    },
  });

  try {
    manager.selectOwner({
      ownerId: RELAY_OWNER_ID,
      ownerGenerationId: RELAY_OWNER_GENERATION_ID,
    });
    manager.start();
    if (!source) throw new Error("phase3_relay_event_source_missing");
    stream = new RelayHttpResponseFixture(source);
    const eventUrl = new URL(source.url, RELAY_ORIGIN);
    await routes.handle(
      "events",
      RELAY_AUTH,
      relayRequest({ method: "GET", url: eventUrl.pathname }),
      stream.asServerResponse(),
      eventUrl,
    );
    await subscriptionReady.promise;
    await clientReady.promise;

    stream.blockWrites = true;
    for (let sequence = 1; sequence <= 6; sequence += 1) {
      relayStore.ingestPublication(
        relayPublication(sequence, null, relayUpsertEvent(sequence)),
      );
    }

    const compactionRequested = checkpointRequests.length === 1;
    stream.blockWrites = false;
    stream.emit("drain");

    const finalCheckpoint = browserStore.getCheckpoint(
      RELAY_OWNER_ID,
      RELAY_OWNER_GENERATION_ID,
    );
    const checkpointRecovered =
      checkpointRequests[0] === 6 &&
      finalCheckpoint?.checkpointId === "phase3-checkpoint-6" &&
      finalCheckpoint.checkpointSequence === 6 &&
      !stream.destroyed &&
      manager.isSubscribedTo({
        ownerId: RELAY_OWNER_ID,
        ownerGenerationId: RELAY_OWNER_GENERATION_ID,
      });
    const finalMessages = finalCheckpoint?.transcript.messages ?? [];
    const statePreserved =
      finalMessages.length === 2 &&
      finalMessages[0]?.messageId === "phase3-baseline-message" &&
      finalMessages[0]?.content.kind === "inline" &&
      finalMessages[0].content.text === "state-before-backpressure" &&
      finalMessages[1]?.messageId === "phase3-stream-message" &&
      finalMessages[1]?.revision === 6 &&
      finalMessages[1].blocks[0]?.type === "text" &&
      finalMessages[1].blocks[0].text.kind === "inline" &&
      finalMessages[1].blocks[0].text.text.startsWith("revision-6:");
    const compactedTailHidden =
      visibleCheckpoints
        .map((checkpoint) => checkpoint.checkpointSequence)
        .join(",") === "0,1,6";

    return {
      compactionRequested,
      checkpointRecovered,
      statePreserved,
      compactedTailHidden,
    };
  } finally {
    manager.close();
    routes.close();
  }
}

function relayRequest(params: {
  readonly method: string;
  readonly url: string;
  readonly body?: unknown;
  readonly headers?: http.IncomingHttpHeaders;
}): http.IncomingMessage {
  const body = params.body === undefined ? [] : [JSON.stringify(params.body)];
  const request = Readable.from(body) as unknown as http.IncomingMessage;
  Object.assign(request, {
    method: params.method,
    url: params.url,
    headers: { host: "127.0.0.1:47200", ...params.headers },
    socket: { setTimeout: (_timeout: number) => {} },
  });
  return request;
}

function relayPublication(
  sequence: number,
  checkpoint: BrowserGatewayOwnerCheckpoint | null,
  event?: BrowserGatewayOwnerEvent,
) {
  return {
    protocolVersion: BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION,
    helperGenerationId: RELAY_HELPER_GENERATION_ID,
    ownerId: RELAY_OWNER_ID,
    ownerGenerationId: RELAY_OWNER_GENERATION_ID,
    batchId: `phase3-batch-${sequence}`,
    firstSequence: sequence,
    lastSequence: sequence,
    checkpoint,
    events: event ? [event] : [],
  };
}

function relayCheckpoint(
  sequence: number,
  streamMessage?: BrowserGatewayTranscriptMessage,
): BrowserGatewayOwnerCheckpoint {
  return {
    protocolVersion: BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION,
    helperGenerationId: RELAY_HELPER_GENERATION_ID,
    ownerId: RELAY_OWNER_ID,
    ownerGenerationId: RELAY_OWNER_GENERATION_ID,
    checkpointId: `phase3-checkpoint-${sequence}`,
    checkpointSequence: sequence,
    emittedAt: 1_000 + sequence,
    foreground: null,
    catalog: {
      projects: [],
      sessions: [],
      defaultProjectId: null,
      foregroundSessionId: null,
    },
    transcript: {
      messages: [
        {
          messageId: "phase3-baseline-message",
          role: "user",
          revision: 1,
          createdAt: 900,
          content: { kind: "inline", text: "state-before-backpressure" },
          blocks: [],
        },
        ...(streamMessage ? [streamMessage] : []),
      ],
      earlierCursor: null,
      hasEarlier: false,
    },
    ui: { interaction: null, queue: [], todos: [], operations: [] },
    background: [],
    fleet: [],
    diffs: [],
    repository: null,
    theme: { revision: "phase3-theme", colorScheme: "dark", variables: [] },
    modelCatalogRevision: "phase3-models",
    capabilities: [],
  };
}

function relayMessage(revision: number): BrowserGatewayTranscriptMessage {
  // Four sub-64 KiB inline blocks keep each event below 256 KiB, while five
  // backpressured frames exceed the production 1 MiB relay queue at sequence 6.
  const blockText = `${`revision-${revision}:`}${"x".repeat(54_000)}`;
  return {
    messageId: "phase3-stream-message",
    role: "assistant",
    revision,
    createdAt: 1_000,
    content: { kind: "inline", text: "" },
    blocks: Array.from({ length: 4 }, (_, index) => ({
      type: "text" as const,
      blockId: `phase3-block-${index}`,
      text: { kind: "inline" as const, text: blockText },
    })),
  };
}

function relayUpsertEvent(sequence: number): BrowserGatewayOwnerEvent {
  return {
    protocolVersion: BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION,
    helperGenerationId: RELAY_HELPER_GENERATION_ID,
    ownerId: RELAY_OWNER_ID,
    ownerGenerationId: RELAY_OWNER_GENERATION_ID,
    ownerSequence: sequence,
    eventId: `phase3-event-${sequence}`,
    kind:
      sequence === 1
        ? "transcript.message.appended"
        : "transcript.message.upserted",
    emittedAt: 1_000 + sequence,
    payload: { message: relayMessage(sequence) },
  };
}

function publication(revision: number): SsePublication<{ revision: number }> {
  const value = { revision };
  const serialized = JSON.stringify(value);
  return {
    revision,
    value,
    serialized,
    bytes: Buffer.byteLength(serialized),
  };
}
