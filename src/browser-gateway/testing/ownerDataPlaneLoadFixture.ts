import * as http from "http";

import type {
  BrowserGatewayOwnerCheckpoint,
  BrowserGatewayOwnerEventKind,
} from "../dataPlane/protocol.js";
import type {
  BrowserGatewayOwnerProjectionReadSet,
  BrowserGatewayOwnerProjectionSourceKind,
  BrowserGatewayOwnerProjectionSources,
} from "../dataPlane/ownerProjectionSources.js";
import type { ChatMessage, ContentBlock } from "../../agent/webview/types.js";
import {
  HttpBrowserGatewayOwnerTransport,
  isBrowserGatewayOwnerImmediateEvent,
} from "../dataPlane/OwnerTransport.js";

import { BROWSER_GATEWAY_DATA_PLANE_LIMITS } from "../dataPlane/limits.js";
import { BrowserGatewayCoreOwnerRegistry } from "../coreOwnerRegistry.js";
import { BrowserGatewayDataPlaneRoutes } from "../helper/dataPlaneRoutes.js";
import { BrowserGatewayOwnerProjectionAdapter } from "../dataPlane/ownerProjectionAdapter.js";
import { BrowserGatewayRelayProjectionAccumulator } from "./stateEquivalenceOracle.js";
import { BrowserGatewayRelayRoutes } from "../helper/relayRoutes.js";
import { HelperLifecycleCoordinator } from "../helper/HelperLifecycleCoordinator.js";
import { OwnerRelayStore } from "../helper/OwnerRelayStore.js";
import { performance } from "node:perf_hooks";

const helperGenerationId = "load-helper-generation";
const ownerId = "load-owner";
const ownerGenerationId = "load-owner-generation";
const clientSharedSecret = "load-fixture-secret";
const relaySessionKey = "load-browser";
const relayDeviceId = "load-device";
const referenceHistoryMessages =
  BROWSER_GATEWAY_DATA_PLANE_LIMITS.selectedOwnerCheckpointMessages + 5;

export interface OwnerDataPlaneLatencySummary {
  readonly count: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly maximumMs: number;
}

export interface OwnerDataPlaneRelayClientResult {
  readonly ownerEventFrames: number;
  readonly checkpointFrames: number;
  readonly resetFramesDuringLoad: number;
  readonly orderingViolationFrames: number;
  readonly sequenceGapFrames: number;
  readonly lastOwnerSequence: number;
  readonly closedUnexpectedly: boolean;
}

export interface OwnerDataPlaneLoadResult {
  readonly durationMs: number;
  readonly sourceUpdates: number;
  readonly requestedSourceUpdatesPerSecond: number;
  readonly measuredSourceUpdatesPerSecond: number;
  readonly sourceHistoryMessages: number;
  readonly retainedCheckpointMessages: number;
  readonly eventCounts: Readonly<Record<string, number>>;
  readonly immediateLatency: OwnerDataPlaneLatencySummary;
  readonly batchedLatency: OwnerDataPlaneLatencySummary;
  readonly publicationBatches: number;
  readonly publicationWireBytes: number;
  readonly maximumPublicationWireBatchBytes: number;
  readonly uploadedDetails: number;
  readonly uploadedDetailBytes: number;
  readonly maximumPendingBatches: number;
  readonly maximumQueuedBytes: number;
  readonly finalPendingBatches: number;
  readonly drainDurationMs: number;
  readonly relayBrowserClients: readonly OwnerDataPlaneRelayClientResult[];
  readonly maximumRelaySubscribers: number;
  readonly finalRelaySubscribers: number;
  readonly relayCheckpointRequests: number;
  readonly sourceCheckpoint: BrowserGatewayOwnerCheckpoint;
  readonly relayCheckpoint: BrowserGatewayOwnerCheckpoint;
}

export interface OwnerDataPlaneLoadOptions {
  readonly durationMs: number;
  readonly sourceUpdatesPerSecond?: number;
  readonly relayBrowserConnections?: number;
}

// Checkpoints and events share the owner-sequence axis. A mid-stream resync at
// the current sequence is conservatively classified as a violation; the load
// gate separately requires zero reset frames and zero checkpoint requests.
export function classifyOwnerSequence(
  previousSequence: number,
  ownerSequence: number,
): { readonly orderingViolation: boolean; readonly sequenceGap: boolean } {
  return {
    orderingViolation:
      previousSequence >= 0 && ownerSequence <= previousSequence,
    sequenceGap: previousSequence >= 0 && ownerSequence > previousSequence + 1,
  };
}

type LiveRelayBrowserClient = {
  readonly result: OwnerDataPlaneRelayClientResult;
  beginLoad(): void;
  waitForOwnerSequence(sequence: number): Promise<void>;
  close(): Promise<void>;
};

class MutableProjectionSources implements BrowserGatewayOwnerProjectionSources {
  private listener:
    | ((source: BrowserGatewayOwnerProjectionSourceKind) => void)
    | undefined;

  constructor(readonly readSet: BrowserGatewayOwnerProjectionReadSet) {}

  capture(): BrowserGatewayOwnerProjectionReadSet {
    return this.readSet;
  }

  onDidChange(
    listener: (source: BrowserGatewayOwnerProjectionSourceKind) => void,
  ): { dispose(): void } {
    this.listener = listener;
    return {
      dispose: () => {
        if (this.listener === listener) this.listener = undefined;
      },
    };
  }

  fire(source: BrowserGatewayOwnerProjectionSourceKind): void {
    this.listener?.(source);
  }
}

export async function runOwnerDataPlaneLoad(
  options: OwnerDataPlaneLoadOptions,
): Promise<OwnerDataPlaneLoadResult> {
  const sourceUpdatesPerSecond = options.sourceUpdatesPerSecond ?? 30;
  if (options.durationMs <= 0 || sourceUpdatesPerSecond <= 0) {
    throw new Error("owner_data_plane_load_options_must_be_positive");
  }

  const now = Date.now;
  const registry = new BrowserGatewayCoreOwnerRegistry({
    heartbeatTtlMs: 120_000,
  });
  const relayStore = new OwnerRelayStore({ helperGenerationId, now });
  const server = http.createServer();
  const lifecycle = new HelperLifecycleCoordinator({ server });
  let allowedRelayHost = "";
  let currentRelaySubscribers = 0;
  let maximumRelaySubscribers = 0;
  let relayCheckpointRequests = 0;
  const relayRoutes = new BrowserGatewayRelayRoutes({
    helperGenerationId,
    ownerRegistry: registry,
    store: relayStore,
    lifecycle,
    keepaliveIntervalMs: 0,
    now,
    isAllowedHost: (host) => host === allowedRelayHost,
    onSubscriberCountChanged: (registeredOwnerId, generation, count) => {
      if (registeredOwnerId !== ownerId || generation !== ownerGenerationId) {
        return;
      }
      currentRelaySubscribers = count;
      maximumRelaySubscribers = Math.max(maximumRelaySubscribers, count);
    },
    onCheckpointRequested: () => {
      relayCheckpointRequests += 1;
    },
  });
  const immediateLatencies: number[] = [];
  const batchedLatencies: number[] = [];
  const eventCounts = new Map<BrowserGatewayOwnerEventKind, number>();
  const relayOracle = new BrowserGatewayRelayProjectionAccumulator();
  const sourceOracle = new BrowserGatewayRelayProjectionAccumulator();
  let publicationBatches = 0;
  let publicationWireBytes = 0;
  let maximumPublicationWireBatchBytes = 0;
  let uploadedDetails = 0;
  let uploadedDetailBytes = 0;

  const routes = new BrowserGatewayDataPlaneRoutes({
    helperGenerationId,
    ownerRegistry: registry,
    lifecycle,
    commandKeepaliveIntervalMs: 0,
    now,
    onPublication: (batch) => {
      const ingestedAt = now();
      const batchBytes = Buffer.byteLength(JSON.stringify(batch), "utf-8");
      publicationBatches += 1;
      publicationWireBytes += batchBytes;
      maximumPublicationWireBatchBytes = Math.max(
        maximumPublicationWireBatchBytes,
        batchBytes,
      );
      for (const event of batch.events) {
        const latencies = isBrowserGatewayOwnerImmediateEvent(event)
          ? immediateLatencies
          : batchedLatencies;
        latencies.push(Math.max(0, ingestedAt - event.emittedAt));
        eventCounts.set(event.kind, (eventCounts.get(event.kind) ?? 0) + 1);
      }
      const publication = relayStore.ingestPublication(batch);
      for (const record of publication.records) {
        relayOracle.apply(
          record.kind === "checkpoint"
            ? { kind: "checkpoint", checkpoint: record.checkpoint }
            : { kind: "event", event: record.event },
        );
      }
    },
    onDetail: (handle, content) => {
      uploadedDetails += 1;
      uploadedDetailBytes += content.byteLength;
      relayStore.putDetail(handle, content);
    },
  });

  server.on("request", (request, response) => {
    void handleRequest(
      request,
      response,
      registry,
      routes,
      relayRoutes,
      relayStore,
    );
  });
  await listen(server);
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("owner_data_plane_load_server_address_missing");
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;
  allowedRelayHost = `127.0.0.1:${address.port}`;

  const readSet = createReadSet();
  const sources = new MutableProjectionSources(readSet);
  const adapter = new BrowserGatewayOwnerProjectionAdapter(
    sources,
    { helperGenerationId, ownerId, ownerGenerationId },
    {
      now,
      createId: (kind, sequence) => `load-${kind}-${sequence}`,
      createDetailId: (locator, revision) => `load-${locator}-${revision}`,
    },
  );
  const transport = new HttpBrowserGatewayOwnerTransport({
    helperUrl: baseUrl,
    clientSharedSecret,
    helperGenerationId,
    owner: {
      ownerId,
      ownerKind: "vscode",
      displayName: "Load fixture owner",
      scope: {
        kind: "workspace",
        workspaceId: "load-workspace",
        displayName: "Load workspace",
      },
      ownerGenerationId,
      instanceId: "load-instance",
    },
    now,
    random: () => 0.5,
    retryBaseMs: 1,
    reconnectBaseMs: 1_000,
    getCheckpoint: () => adapter.getCheckpoint(),
    getRecoveryCheckpointPublication: () =>
      adapter.getRecoveryCheckpointPublication(),
  });

  let maximumPendingBatches = 0;
  let maximumQueuedBytes = 0;
  let sourceUpdates = 0;
  const sampleBacklog = (): void => {
    const backlog = transport.getPublicationBacklog();
    maximumPendingBatches = Math.max(
      maximumPendingBatches,
      backlog.pendingBatches,
    );
    maximumQueuedBytes = Math.max(maximumQueuedBytes, backlog.queuedBytes);
  };
  const projectionSubscription = adapter.onDidPublish((publication) => {
    sourceOracle.apply(publication);
    transport.enqueue(publication);
    sampleBacklog();
  });
  const relayBrowserClients: LiveRelayBrowserClient[] = [];

  try {
    await transport.register();
    adapter.setDemanded(true);
    await waitForCondition(
      () => relayStore.getCheckpoint(ownerId, ownerGenerationId) !== null,
      "owner_data_plane_load_initial_checkpoint_timeout",
    );
    for (
      let index = 0;
      index < (options.relayBrowserConnections ?? 0);
      index += 1
    ) {
      relayBrowserClients.push(await openRelayBrowserClient(baseUrl));
    }
    for (const client of relayBrowserClients) client.beginLoad();

    const start = performance.now();
    const intervalMs = 1_000 / sourceUpdatesPerSecond;
    const updateCount = Math.ceil(options.durationMs / intervalMs) + 1;
    for (let index = 0; index < updateCount; index += 1) {
      const target = start + index * intervalMs;
      await delayUntil(target);
      updateSources(readSet, sources, index);
      sourceUpdates += 1;
      sampleBacklog();
    }
    await delayUntil(start + options.durationMs);
    const durationMs = performance.now() - start;

    const drainStartedAt = performance.now();
    await transport.drain();
    const drainDurationMs = performance.now() - drainStartedAt;
    const finalPendingBatches =
      transport.getPublicationBacklog().pendingBatches;
    const sourceCheckpoint = sourceOracle.getCheckpoint();
    const relayCheckpoint = relayOracle.getCheckpoint();
    await Promise.all(
      relayBrowserClients.map((client) =>
        client.waitForOwnerSequence(relayCheckpoint.checkpointSequence),
      ),
    );
    await Promise.all(relayBrowserClients.map((client) => client.close()));
    await waitForCondition(
      () => currentRelaySubscribers === 0,
      "owner_data_plane_load_relay_cleanup_timeout",
    );

    return {
      durationMs,
      sourceUpdates,
      requestedSourceUpdatesPerSecond: sourceUpdatesPerSecond,
      measuredSourceUpdatesPerSecond: sourceUpdates / (durationMs / 1_000),
      sourceHistoryMessages: referenceHistoryMessages,
      retainedCheckpointMessages: sourceCheckpoint.transcript.messages.length,
      eventCounts: Object.fromEntries(eventCounts),
      immediateLatency: summarizeLatency(immediateLatencies),
      batchedLatency: summarizeLatency(batchedLatencies),
      publicationBatches,
      publicationWireBytes,
      maximumPublicationWireBatchBytes,
      uploadedDetails,
      uploadedDetailBytes,
      maximumPendingBatches,
      maximumQueuedBytes,
      finalPendingBatches,
      drainDurationMs,
      relayBrowserClients: relayBrowserClients.map((client) => client.result),
      maximumRelaySubscribers,
      finalRelaySubscribers: currentRelaySubscribers,
      relayCheckpointRequests,
      sourceCheckpoint,
      relayCheckpoint,
    };
  } finally {
    await Promise.all(
      relayBrowserClients.map((client) =>
        client.close().catch(() => undefined),
      ),
    );
    projectionSubscription.dispose();
    adapter.dispose();
    await transport.close().catch(() => undefined);
    relayRoutes.close();
    routes.close();
    relayStore.close();
    await closeServer(server);
  }
}

async function handleRequest(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  registry: BrowserGatewayCoreOwnerRegistry,
  routes: BrowserGatewayDataPlaneRoutes,
  relayRoutes: BrowserGatewayRelayRoutes,
  relayStore: OwnerRelayStore,
): Promise<void> {
  const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
  const relayAuth = { sessionKey: relaySessionKey, deviceId: relayDeviceId };
  if (request.method === "GET" && requestUrl.pathname === "/api/relay/events") {
    await relayRoutes.handle(
      "events",
      relayAuth,
      request,
      response,
      requestUrl,
    );
    return;
  }
  if (
    request.method === "POST" &&
    requestUrl.pathname === "/api/relay/subscription"
  ) {
    await relayRoutes.handle(
      "subscription",
      relayAuth,
      request,
      response,
      requestUrl,
    );
    return;
  }
  if (request.headers.authorization !== `Bearer ${clientSharedSecret}`) {
    writeJson(response, 401, { error: "unauthorized" });
    return;
  }
  if (
    request.method === "POST" &&
    requestUrl.pathname === "/internal/core-owners/register"
  ) {
    const body = (await readJson(request)) as {
      ownerId: string;
      ownerKind: "vscode";
      displayName: string;
      scope: {
        kind: "workspace";
        workspaceId: string;
        displayName: string;
      };
      ownerGenerationId: string;
      instanceId?: string;
    };
    const registration = registry.registerWithCollisionPolicy({
      ...body,
      now: Date.now(),
    });
    routes.ownerRegistered(
      registration.effectiveOwnerId,
      registration.registration.ownerGenerationId,
    );
    relayRoutes.ownerRegistered(
      registration.effectiveOwnerId,
      registration.registration.ownerGenerationId,
    );
    relayStore.ownerRegistered(
      registration.effectiveOwnerId,
      registration.registration.ownerGenerationId,
    );
    writeJson(response, 200, {
      ok: true,
      helperGenerationId,
      requestedOwnerId: registration.requestedOwnerId,
      effectiveOwnerId: registration.effectiveOwnerId,
      resolution: registration.resolution,
      ownerRegistration: registration.registration,
    });
    return;
  }
  if (requestUrl.pathname === "/internal/data-plane/publications") {
    await routes.handle("publications", request, response, requestUrl);
    return;
  }
  if (requestUrl.pathname === "/internal/data-plane/commands") {
    await routes.handle("commands", request, response, requestUrl);
    return;
  }
  if (requestUrl.pathname === "/internal/data-plane/details") {
    await routes.handle("details", request, response, requestUrl);
    return;
  }
  writeJson(response, 404, { error: "not_found" });
}

async function openRelayBrowserClient(
  baseUrl: string,
): Promise<LiveRelayBrowserClient> {
  const response = await fetch(`${baseUrl}/api/relay/events`);
  if (!response.ok || !response.body) {
    throw new Error(
      `owner_data_plane_load_relay_open_failed:${response.status}`,
    );
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const mutableResult = {
    ownerEventFrames: 0,
    checkpointFrames: 0,
    resetFramesDuringLoad: 0,
    orderingViolationFrames: 0,
    sequenceGapFrames: 0,
    lastOwnerSequence: -1,
    closedUnexpectedly: false,
  };
  let browserConnectionId = "";
  let csrfNonce = "";
  let buffer = "";
  let loadStarted = false;
  let plannedClose = false;
  let streamError: Error | undefined;

  const observeOwnerSequence = (ownerSequence: number): void => {
    const observation = classifyOwnerSequence(
      mutableResult.lastOwnerSequence,
      ownerSequence,
    );
    if (observation.orderingViolation) {
      mutableResult.orderingViolationFrames += 1;
    }
    if (observation.sequenceGap) mutableResult.sequenceGapFrames += 1;
    mutableResult.lastOwnerSequence = ownerSequence;
  };

  const consume = async (): Promise<void> => {
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) {
          if (!plannedClose) mutableResult.closedUnexpectedly = true;
          return;
        }
        buffer += decoder
          .decode(next.value, { stream: true })
          .replaceAll("\r\n", "\n");
        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const event = parseSseFrame(frame);
          if (event?.name === "hello") {
            browserConnectionId = stringField(
              event.data,
              "browserConnectionId",
              "owner_data_plane_load_relay_hello_invalid",
            );
            csrfNonce = stringField(
              event.data,
              "csrfNonce",
              "owner_data_plane_load_relay_hello_invalid",
            );
          } else if (event?.name === "owner.event") {
            mutableResult.ownerEventFrames += 1;
            observeOwnerSequence(ownerSequenceFromRelayEnvelope(event.data));
          } else if (event?.name === "checkpoint") {
            mutableResult.checkpointFrames += 1;
            observeOwnerSequence(ownerSequenceFromRelayEnvelope(event.data));
          } else if (event?.name === "reset" && loadStarted) {
            mutableResult.resetFramesDuringLoad += 1;
          }
          boundary = buffer.indexOf("\n\n");
        }
      }
    } catch (error) {
      if (!plannedClose) {
        mutableResult.closedUnexpectedly = true;
        streamError =
          error instanceof Error ? error : new Error("relay_stream_failed");
      }
    }
  };
  const consumeTask = consume();

  await waitForCondition(
    () => browserConnectionId !== "" && csrfNonce !== "",
    "owner_data_plane_load_relay_hello_timeout",
    () => streamError,
  );
  const subscription = await fetch(`${baseUrl}/api/relay/subscription`, {
    method: "POST",
    headers: {
      Origin: baseUrl,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      browserConnectionId,
      csrfNonce,
      ownerId,
      ownerGenerationId,
    }),
  });
  if (subscription.status !== 202) {
    plannedClose = true;
    await reader.cancel().catch(() => undefined);
    await consumeTask;
    throw new Error(
      `owner_data_plane_load_relay_subscription_failed:${subscription.status}`,
    );
  }
  await waitForCondition(
    () => mutableResult.checkpointFrames > 0,
    "owner_data_plane_load_relay_checkpoint_timeout",
    () => streamError,
  );

  return {
    get result() {
      return { ...mutableResult };
    },
    beginLoad: () => {
      loadStarted = true;
    },
    waitForOwnerSequence: async (sequence) => {
      await waitForCondition(
        () => mutableResult.lastOwnerSequence >= sequence,
        "owner_data_plane_load_relay_terminal_sequence_timeout",
        () => streamError,
      );
    },
    close: async () => {
      if (plannedClose) return;
      plannedClose = true;
      await reader.cancel().catch(() => undefined);
      await consumeTask;
    },
  };
}

function parseSseFrame(
  frame: string,
): { readonly name: string; readonly data: unknown } | null {
  let name = "";
  const data: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) name = line.slice(6).trim();
    if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  if (!name || data.length === 0) return null;
  return { name, data: JSON.parse(data.join("\n")) };
}

function ownerSequenceFromRelayEnvelope(value: unknown): number {
  if (!value || typeof value !== "object") {
    throw new Error("owner_data_plane_load_relay_record_invalid");
  }
  const record = (value as { record?: unknown }).record;
  if (!record || typeof record !== "object") {
    throw new Error("owner_data_plane_load_relay_record_invalid");
  }
  const ownerSequence = (record as { ownerSequence?: unknown }).ownerSequence;
  if (!Number.isSafeInteger(ownerSequence) || (ownerSequence as number) < 0) {
    throw new Error("owner_data_plane_load_relay_record_invalid");
  }
  return ownerSequence as number;
}

function stringField(value: unknown, key: string, error: string): string {
  if (!value || typeof value !== "object") throw new Error(error);
  const field = (value as Record<string, unknown>)[key];
  if (typeof field !== "string" || field.length === 0) throw new Error(error);
  return field;
}

function createReadSet(): BrowserGatewayOwnerProjectionReadSet {
  const messages = Array.from(
    { length: referenceHistoryMessages },
    (_, index) => createMessage(index),
  );
  return {
    catalog: {
      projects: [
        {
          projectId: "load-project",
          displayName: "Load project",
          availability: "available",
        },
      ],
      sessions: [
        {
          sessionId: "load-session",
          projectId: "load-project",
          title: "Owner data-plane load",
          mode: "code",
          model: "load-model",
          messageCount: messages.length,
          createdAt: 1,
          updatedAt: Date.now(),
        },
      ],
      defaultProjectId: "load-project",
      foregroundSessionId: "load-session",
    },
    foreground: {
      sessionId: "load-session",
      title: "Owner data-plane load",
      mode: "code",
      model: "load-model",
      status: "streaming",
      streaming: true,
      statusOverride: null,
      thinkingEnabled: true,
      reasoningEffort: "high",
      lastInputTokens: 0,
      lastOutputTokens: 0,
      lastCacheReadTokens: 0,
      restoringSession: false,
      revertRecoveryNotice: null,
      messages,
      earlierCursor: "load-earlier",
      hasEarlier: true,
      cursorBeforeMessage: (messageId) => `before:${messageId}`,
      queue: [],
      todos: [],
    },
    interaction: null,
    background: [],
    fleet: [],
    diffs: [],
    repository: null,
    theme: { colorScheme: "dark", cssVariables: {} },
    modelCatalogRevision: "load-models-1",
    mcp: [],
    policies: {
      agentWriteApproval: "prompt",
      commandApprovalPolicy: "safe",
      approvalPolicy: "on-request",
      approvalReviewer: "user",
      executionPreset: "native-manual",
      configuredCommandApprovalPolicy: "safe",
    },
  };
}

function createMessage(index: number): ChatMessage {
  return {
    id: `load-message-${index}`,
    role: "assistant",
    content: "",
    timestamp: index + 1,
    blocks: [{ type: "text", text: `history-${index}` }],
  };
}

function updateSources(
  readSet: BrowserGatewayOwnerProjectionReadSet,
  sources: MutableProjectionSources,
  index: number,
): void {
  if (index % 30 === 0) {
    readSet.interaction = readSet.interaction
      ? null
      : {
          requestId: `load-interaction-${index}`,
          kind: "approval",
          backgroundTask: "Load approval",
        };
    sources.fire("ui");
    return;
  }
  const foreground = readSet.foreground;
  if (!foreground) throw new Error("owner_data_plane_load_foreground_missing");
  if (index === 1 || index % 10 === 0) {
    foreground.queue = [{ id: "load-queue", text: `queued-${index}` }];
    sources.fire("foreground");
    return;
  }
  const message = foreground.messages.at(-1);
  const block = message?.blocks[0];
  if (!message || !block || block.type !== "text") {
    throw new Error("owner_data_plane_load_text_block_missing");
  }
  const nextBlock: ContentBlock = {
    ...block,
    text: `${block.text}.${index}`,
  };
  message.blocks = [nextBlock];
  sources.fire("foreground");
}

function summarizeLatency(
  values: readonly number[],
): OwnerDataPlaneLatencySummary {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    count: sorted.length,
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    maximumMs: sorted.at(-1) ?? 0,
  };
}

function percentile(sorted: readonly number[], quantile: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.ceil(sorted.length * quantile) - 1;
  return sorted[Math.max(0, index)] ?? 0;
}

async function waitForCondition(
  predicate: () => boolean,
  timeoutError: string,
  getError: () => Error | undefined = () => undefined,
): Promise<void> {
  const deadline = performance.now() + 5_000;
  while (!predicate()) {
    const error = getError();
    if (error) throw error;
    if (performance.now() >= deadline) throw new Error(timeoutError);
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

async function delayUntil(target: number): Promise<void> {
  const remaining = target - performance.now();
  if (remaining > 0) {
    await new Promise<void>((resolve) => setTimeout(resolve, remaining));
  }
}

async function listen(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

async function closeServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

async function readJson(request: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf-8"));
}

function writeJson(
  response: http.ServerResponse,
  status: number,
  payload: unknown,
): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}
