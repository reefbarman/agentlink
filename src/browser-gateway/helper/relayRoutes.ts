import { randomUUID } from "crypto";
import type * as http from "http";

import type { BrowserGatewayCoreOwnerRegistry } from "../coreOwnerRegistry.js";
import { BROWSER_GATEWAY_DATA_PLANE_LIMITS } from "../dataPlane/limits.js";
import {
  BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION,
  type BrowserGatewayOperationState,
} from "../dataPlane/protocol.js";
import { readBoundedBody, readJsonBody } from "../nodeHttpPrimitives.js";
import type { HelperLifecycleCoordinator } from "./HelperLifecycleCoordinator.js";
import {
  type BrowserGatewayRelayRecord,
  type BrowserGatewayRelayStorePublication,
  createRelayReset,
  type OwnerRelayStore,
} from "./OwnerRelayStore.js";
import {
  createRelaySseFrame,
  RelaySseClientQueue,
  type RelaySseFrame,
} from "./RelaySseClientQueue.js";
import type { BrowserRelayRouteHandler } from "./helperRouteFamilies.js";

export interface BrowserRelayAuthIdentity {
  readonly sessionKey: string;
  readonly deviceId?: string;
}

export interface BrowserGatewayRelayRoutesOptions {
  readonly helperGenerationId: string;
  readonly ownerRegistry: BrowserGatewayCoreOwnerRegistry;
  readonly store: OwnerRelayStore;
  readonly lifecycle: HelperLifecycleCoordinator;
  readonly now?: () => number;
  readonly keepaliveIntervalMs?: number;
  readonly isAllowedHost: (host: string) => boolean;
  readonly onSubscriberCountChanged?: (
    ownerId: string,
    ownerGenerationId: string,
    subscriberCount: number,
  ) => void;
  readonly onCheckpointRequested?: (
    ownerId: string,
    ownerGenerationId: string,
    latestOwnerSequence: number,
  ) => void;
  readonly onCommand?: (
    context: {
      sessionKey: string;
      browserConnectionId: string;
      subscriptionId: string;
      ownerId: string;
      ownerGenerationId: string;
    },
    value: unknown,
  ) => { status: number; payload: unknown };
  readonly onOperationStatus?: (
    context: {
      sessionKey: string;
      browserConnectionId: string;
      ownerId: string;
      ownerGenerationId: string;
    },
    operationId: string,
  ) => { status: number; payload: unknown };
  readonly onConnectionClosed?: (browserConnectionId: string) => void;
}

type BrowserRelaySubscription = {
  readonly subscriptionId: string;
  readonly ownerId: string;
  readonly ownerGenerationId: string;
};

type BrowserRelayConnection = {
  readonly browserConnectionId: string;
  readonly csrfNonce: string;
  readonly auth: BrowserRelayAuthIdentity;
  readonly queue: RelaySseClientQueue;
  readonly releaseLifecycle: () => void;
  readonly keepaliveTimer: NodeJS.Timeout | undefined;
  readonly selectionTimestamps: number[];
  readonly checkpointRequestTimestamps: number[];
  subscription: BrowserRelaySubscription | null;
};

type SubscriptionRequest = {
  browserConnectionId: string;
  csrfNonce: string;
  ownerId: string;
  ownerGenerationId: string;
};

export class BrowserGatewayRelayRoutes {
  private readonly connections = new Map<string, BrowserRelayConnection>();
  private readonly subscriberCounts = new Map<string, number>();
  private readonly now: () => number;
  private readonly keepaliveIntervalMs: number;
  private readonly unsubscribeStore: () => void;

  constructor(private readonly options: BrowserGatewayRelayRoutesOptions) {
    this.now = options.now ?? Date.now;
    this.keepaliveIntervalMs = options.keepaliveIntervalMs ?? 15_000;
    this.unsubscribeStore = options.store.subscribe((publication) =>
      this.broadcastPublication(publication),
    );
  }

  async handle(
    handler: BrowserRelayRouteHandler,
    auth: BrowserRelayAuthIdentity,
    req: http.IncomingMessage,
    res: http.ServerResponse,
    requestUrl: URL,
  ): Promise<void> {
    if (
      typeof req.headers.host !== "string" ||
      !this.options.isAllowedHost(req.headers.host)
    ) {
      writeJson(res, 403, { error: "host_not_allowed" });
      return;
    }
    switch (handler) {
      case "events":
        this.handleEvents(auth, req, res, requestUrl);
        return;
      case "subscription":
        await this.handleSubscription(auth, req, res);
        return;
      case "commands":
        await this.handleCommand(auth, req, res);
        return;
      case "operationStatus":
        await this.handleOperationStatus(auth, req, res);
        return;
      case "detail":
        this.handleDetail(requestUrl, res);
        return;
    }
  }

  ownerRegistered(ownerId: string, ownerGenerationId: string): void {
    for (const connection of this.connections.values()) {
      const subscription = connection.subscription;
      if (
        subscription?.ownerId !== ownerId ||
        subscription.ownerGenerationId === ownerGenerationId
      ) {
        continue;
      }
      this.selectOwner(
        connection,
        ownerId,
        ownerGenerationId,
        null,
        "generation",
      );
    }
    this.ownerCatalogChanged();
  }

  ownerCatalogChanged(): void {
    const frame = createRelaySseFrame({
      event: "catalog",
      data: this.catalogEnvelope(),
    });
    for (const connection of this.connections.values()) {
      connection.queue.send(frame);
    }
  }

  closeDevice(deviceId: string): void {
    for (const connection of this.connections.values()) {
      if (connection.auth.deviceId === deviceId) connection.queue.close(true);
    }
  }

  emitOperation(
    browserConnectionId: string,
    ownerId: string,
    ownerGenerationId: string,
    operation: BrowserGatewayOperationState,
  ): boolean {
    const connection = this.connections.get(browserConnectionId);
    const subscription = connection?.subscription;
    if (
      !connection ||
      !subscription ||
      subscription.ownerId !== ownerId ||
      subscription.ownerGenerationId !== ownerGenerationId
    ) {
      return false;
    }
    return connection.queue.send(
      createRelaySseFrame({
        event: "relay.operation",
        data: {
          protocolVersion: BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION,
          helperGenerationId: this.options.helperGenerationId,
          subscriptionId: subscription.subscriptionId,
          ownerId,
          ownerGenerationId,
          emittedAt: this.now(),
          operation,
        },
        retainDuringCompaction: true,
      }),
    );
  }

  close(): void {
    this.unsubscribeStore();
    for (const connection of this.connections.values()) {
      connection.queue.close();
    }
    this.connections.clear();
    this.subscriberCounts.clear();
  }

  private handleEvents(
    auth: BrowserRelayAuthIdentity,
    req: http.IncomingMessage,
    res: http.ServerResponse,
    requestUrl: URL,
  ): void {
    req.socket.setTimeout(0);
    res.socket?.setTimeout(0);
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders?.();

    const browserConnectionId = randomUUID();
    const csrfNonce = randomUUID();
    let connection!: BrowserRelayConnection;
    const queue = new RelaySseClientQueue({
      writable: res,
      requestCompaction: (request) => {
        const selected = connection.subscription;
        if (
          !selected ||
          !this.requestCheckpoint(
            connection,
            selected.ownerId,
            selected.ownerGenerationId,
            request.maximumOwnerSequence,
          )
        ) {
          queue.close(true);
        }
      },
      onClose: () => this.removeConnection(browserConnectionId),
    });
    const releaseLifecycle = this.options.lifecycle.trackStream(res, () =>
      queue.close(true),
    );
    const keepaliveTimer =
      this.keepaliveIntervalMs > 0
        ? setInterval(() => {
            const keepalive = `: keepalive ${this.now()}\n\n`;
            queue.send({
              data: keepalive,
              byteLength: Buffer.byteLength(keepalive),
            });
            queue.send(
              createRelaySseFrame({
                event: "catalog",
                data: this.catalogEnvelope(),
              }),
            );
          }, this.keepaliveIntervalMs)
        : undefined;
    keepaliveTimer?.unref();
    connection = {
      browserConnectionId,
      csrfNonce,
      auth,
      queue,
      releaseLifecycle,
      keepaliveTimer,
      selectionTimestamps: [],
      checkpointRequestTimestamps: [],
      subscription: null,
    };
    this.connections.set(browserConnectionId, connection);

    queue.send(
      createRelaySseFrame({
        event: "hello",
        data: {
          protocolVersion: BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION,
          helperGenerationId: this.options.helperGenerationId,
          browserConnectionId,
          csrfNonce,
          emittedAt: this.now(),
        },
      }),
    );
    queue.send(
      createRelaySseFrame({ event: "catalog", data: this.catalogEnvelope() }),
    );

    const replayCursor = parseRelayCursor(
      req.headers["last-event-id"] ??
        requestUrl.searchParams.get("cursor") ??
        undefined,
      this.options.helperGenerationId,
    );
    const requestedOwnerId = requestUrl.searchParams.get("ownerId")?.trim();
    const requestedOwnerGenerationId = requestUrl.searchParams
      .get("ownerGenerationId")
      ?.trim();
    const ownerId = requestedOwnerId ?? replayCursor.ownerId;
    const ownerGenerationId =
      requestedOwnerGenerationId ?? replayCursor.ownerGenerationId;
    if (ownerId && ownerGenerationId) {
      const owner = this.options.ownerRegistry.get(ownerId);
      if (
        owner?.status === "connected" &&
        owner.ownerGenerationId === ownerGenerationId
      ) {
        const resetSource = replayCursor.helperGenerationChanged
          ? "helper_generation"
          : requestedOwnerId && replayCursor.ownerId !== requestedOwnerId
            ? "selection"
            : requestedOwnerGenerationId &&
                replayCursor.ownerGenerationId !== requestedOwnerGenerationId
              ? "generation"
              : null;
        this.selectOwner(
          connection,
          ownerId,
          ownerGenerationId,
          resetSource ? null : replayCursor.cursor,
          resetSource ?? "reconnect",
        );
      }
    }
  }

  private async handleSubscription(
    auth: BrowserRelayAuthIdentity,
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    if (!hasValidSameOrigin(req, this.options.isAllowedHost)) {
      writeJson(res, 403, { error: "same_origin_required" });
      return;
    }
    let body: SubscriptionRequest;
    try {
      body = parseSubscriptionRequest(await readJsonBody(req, 32 * 1024));
    } catch {
      writeJson(res, 400, { error: "invalid_request" });
      return;
    }
    const connection = this.connections.get(body.browserConnectionId);
    if (
      !connection ||
      connection.auth.sessionKey !== auth.sessionKey ||
      connection.csrfNonce !== body.csrfNonce
    ) {
      writeJson(res, 403, { error: "connection_mismatch" });
      return;
    }
    if (
      !consumeRateLimit(
        connection.selectionTimestamps,
        BROWSER_GATEWAY_DATA_PLANE_LIMITS.selectionChangesPerSecond,
        this.now(),
      )
    ) {
      writeJson(res, 429, { error: "selection_rate_limited" });
      return;
    }
    const owner = this.options.ownerRegistry.get(body.ownerId);
    if (
      !owner ||
      owner.status !== "connected" ||
      owner.ownerGenerationId !== body.ownerGenerationId
    ) {
      writeJson(res, 409, { error: "owner_generation_unavailable" });
      return;
    }

    const subscription = this.selectOwner(
      connection,
      body.ownerId,
      body.ownerGenerationId,
      null,
      "selection",
    );
    writeJson(res, 202, {
      ok: true,
      protocolVersion: BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION,
      helperGenerationId: this.options.helperGenerationId,
      browserConnectionId: connection.browserConnectionId,
      subscriptionId: subscription.subscriptionId,
      ownerId: subscription.ownerId,
      ownerGenerationId: subscription.ownerGenerationId,
    });
  }

  private async handleCommand(
    auth: BrowserRelayAuthIdentity,
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    if (!hasValidSameOrigin(req, this.options.isAllowedHost)) {
      writeJson(res, 403, { error: "same_origin_required" });
      return;
    }
    let raw: Buffer;
    try {
      raw = await readBoundedBody(
        req,
        BROWSER_GATEWAY_DATA_PLANE_LIMITS.ownerCommandBytes,
      );
    } catch {
      writeJson(res, 413, { error: "command_body_limit_exceeded" });
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(raw.toString("utf-8"));
    } catch {
      writeJson(res, 400, { error: "invalid_request" });
      return;
    }
    const credentials = parseCommandCredentials(value);
    if (!credentials) {
      writeJson(res, 400, { error: "invalid_request" });
      return;
    }
    const connection = this.connections.get(credentials.browserConnectionId);
    if (
      !connection ||
      connection.auth.sessionKey !== auth.sessionKey ||
      connection.csrfNonce !== credentials.csrfNonce
    ) {
      writeJson(res, 403, { error: "connection_mismatch" });
      return;
    }
    const subscription = connection.subscription;
    if (!subscription) {
      writeJson(res, 409, { error: "subscription_required" });
      return;
    }
    if (subscription.subscriptionId !== credentials.subscriptionId) {
      writeJson(res, 409, { error: "subscription_mismatch" });
      return;
    }
    if (!this.options.onCommand) {
      writeJson(res, 503, { error: "command_router_unavailable" });
      return;
    }
    const result = this.options.onCommand(
      {
        sessionKey: auth.sessionKey,
        browserConnectionId: connection.browserConnectionId,
        subscriptionId: subscription.subscriptionId,
        ownerId: subscription.ownerId,
        ownerGenerationId: subscription.ownerGenerationId,
      },
      value,
    );
    writeJson(res, result.status, result.payload);
  }

  private async handleOperationStatus(
    auth: BrowserRelayAuthIdentity,
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    if (!hasValidSameOrigin(req, this.options.isAllowedHost)) {
      writeJson(res, 403, { error: "same_origin_required" });
      return;
    }
    let value: unknown;
    try {
      value = await readJsonBody(req, 32 * 1024);
    } catch {
      writeJson(res, 400, { error: "invalid_request" });
      return;
    }
    const request = parseOperationStatusRequest(value);
    if (!request) {
      writeJson(res, 400, { error: "invalid_request" });
      return;
    }
    const connection = this.connections.get(request.browserConnectionId);
    if (
      !connection ||
      connection.auth.sessionKey !== auth.sessionKey ||
      connection.csrfNonce !== request.csrfNonce
    ) {
      writeJson(res, 403, { error: "connection_mismatch" });
      return;
    }
    const subscription = connection.subscription;
    if (!subscription) {
      writeJson(res, 409, { error: "subscription_required" });
      return;
    }
    if (subscription.subscriptionId !== request.subscriptionId) {
      writeJson(res, 409, { error: "subscription_mismatch" });
      return;
    }
    if (!this.options.onOperationStatus) {
      writeJson(res, 503, { error: "command_router_unavailable" });
      return;
    }
    const result = this.options.onOperationStatus(
      {
        sessionKey: auth.sessionKey,
        browserConnectionId: connection.browserConnectionId,
        ownerId: subscription.ownerId,
        ownerGenerationId: subscription.ownerGenerationId,
      },
      request.operationId,
    );
    writeJson(res, result.status, result.payload);
  }

  private handleDetail(requestUrl: URL, res: http.ServerResponse): void {
    const handleId = requestUrl.searchParams.get("handleId")?.trim() ?? "";
    const ownerId = requestUrl.searchParams.get("ownerId")?.trim() ?? "";
    const ownerGenerationId =
      requestUrl.searchParams.get("ownerGenerationId")?.trim() ?? "";
    if (!handleId || !ownerId || !ownerGenerationId) {
      writeJson(res, 400, { error: "invalid_request" });
      return;
    }
    const detail = this.options.store.getDetail({
      handleId,
      ownerId,
      ownerGenerationId,
    });
    if (!detail) {
      writeJson(res, 404, { error: "detail_not_found" });
      return;
    }
    res.writeHead(200, {
      "Content-Type": detail.handle.mediaType ?? "application/octet-stream",
      "Content-Length": detail.content.byteLength,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(detail.content);
  }

  private selectOwner(
    connection: BrowserRelayConnection,
    ownerId: string,
    ownerGenerationId: string,
    replayCursor: number | null,
    source: "selection" | "reconnect" | "generation" | "helper_generation",
  ): BrowserRelaySubscription {
    this.releaseSubscription(connection.subscription);
    const subscription: BrowserRelaySubscription = {
      subscriptionId: randomUUID(),
      ownerId,
      ownerGenerationId,
    };
    connection.subscription = subscription;
    this.acquireSubscription(subscription);
    connection.queue.replacePending([]);

    const replay = this.options.store.replay(
      ownerId,
      ownerGenerationId,
      replayCursor,
    );
    if (replay.kind === "reset") {
      connection.queue.send(
        createRelaySseFrame({
          id: relayEventId(
            this.options.helperGenerationId,
            ownerId,
            ownerGenerationId,
            Math.max(0, (replay.checkpoint?.relaySequence ?? 1) - 1),
          ),
          event: "reset",
          data: createRelayReset({
            helperGenerationId: this.options.helperGenerationId,
            ownerId,
            ownerGenerationId,
            reason:
              source === "selection"
                ? "subscription_changed"
                : source === "generation"
                  ? "owner_generation_changed"
                  : source === "helper_generation"
                    ? "helper_generation_changed"
                    : replay.reason,
            latestSequence: replay.checkpoint?.ownerSequence ?? 0,
            subscriptionId: subscription.subscriptionId,
          }),
        }),
      );
      if (replay.checkpoint) {
        connection.queue.send(
          this.recordFrame(subscription, replay.checkpoint),
        );
      } else if (
        !this.requestCheckpoint(connection, ownerId, ownerGenerationId, 0)
      ) {
        connection.queue.close(true);
      }
      for (const record of replay.records) {
        connection.queue.send(this.recordFrame(subscription, record));
      }
    } else {
      for (const record of replay.records) {
        connection.queue.send(this.recordFrame(subscription, record));
      }
    }
    return subscription;
  }

  private broadcastPublication(
    publication: BrowserGatewayRelayStorePublication,
  ): void {
    for (const connection of this.connections.values()) {
      const subscription = connection.subscription;
      if (
        !subscription ||
        subscription.ownerId !== publication.ownerId ||
        subscription.ownerGenerationId !== publication.ownerGenerationId
      ) {
        continue;
      }
      for (const record of publication.records) {
        const frame = this.recordFrame(subscription, record);
        if (
          record.kind === "checkpoint" &&
          connection.queue.isAwaitingCompaction
        ) {
          connection.queue.installCompaction(record.ownerSequence, [frame]);
        } else {
          connection.queue.send(frame);
        }
      }
    }
  }

  private recordFrame(
    subscription: BrowserRelaySubscription,
    record: BrowserGatewayRelayRecord,
  ): RelaySseFrame {
    return createRelaySseFrame({
      id: relayEventId(
        this.options.helperGenerationId,
        record.ownerId,
        record.ownerGenerationId,
        record.relaySequence,
      ),
      event: record.kind === "checkpoint" ? "checkpoint" : "owner.event",
      data: {
        protocolVersion: BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION,
        helperGenerationId: this.options.helperGenerationId,
        subscriptionId: subscription.subscriptionId,
        ownerId: subscription.ownerId,
        ownerGenerationId: subscription.ownerGenerationId,
        record,
      },
      relaySequence: record.relaySequence,
      ownerSequence: record.ownerSequence,
    });
  }

  private catalogEnvelope() {
    return {
      protocolVersion: BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION,
      helperGenerationId: this.options.helperGenerationId,
      emittedAt: this.now(),
      owners: this.options.ownerRegistry
        .listVisible(this.now())
        .map((registration) => {
          const scope = registration.owner.scope;
          return {
            ownerId: boundedString(registration.owner.ownerId, 256),
            ownerGenerationId: boundedString(
              registration.ownerGenerationId,
              256,
            ),
            ownerKind: registration.owner.ownerKind,
            displayName: boundedString(registration.owner.displayName, 1_000),
            ...(registration.owner.instanceId
              ? {
                  instanceId: boundedString(registration.owner.instanceId, 256),
                }
              : {}),
            scope:
              scope.kind === "workspace"
                ? {
                    kind: "workspace" as const,
                    workspaceId: boundedString(scope.workspaceId, 256),
                    displayName: boundedString(scope.displayName, 1_000),
                  }
                : {
                    kind: "projectless" as const,
                    scopeId: boundedString(scope.scopeId, 256),
                    displayName: boundedString(scope.displayName, 1_000),
                  },
            status: registration.status,
            capabilities: (Array.isArray(registration.capabilities)
              ? registration.capabilities
              : []
            )
              .filter(
                (capability) =>
                  typeof capability.capabilityId === "string" &&
                  (capability.state === "enabled" ||
                    capability.state === "disabled" ||
                    capability.state === "requires_approval" ||
                    capability.state === "unavailable"),
              )
              .map((capability) => ({
                capabilityId: boundedString(capability.capabilityId, 256),
                state: capability.state,
                ...(typeof capability.reason === "string"
                  ? { reason: boundedString(capability.reason, 1_000) }
                  : {}),
              })),
            lastHeartbeatAt: registration.lastHeartbeatAt ?? null,
          };
        }),
    };
  }

  private requestCheckpoint(
    connection: BrowserRelayConnection,
    ownerId: string,
    ownerGenerationId: string,
    latestOwnerSequence: number,
  ): boolean {
    if (
      !consumeRateLimit(
        connection.checkpointRequestTimestamps,
        BROWSER_GATEWAY_DATA_PLANE_LIMITS.checkpointRequestsPerSecond,
        this.now(),
      )
    ) {
      return false;
    }
    this.options.onCheckpointRequested?.(
      ownerId,
      ownerGenerationId,
      latestOwnerSequence,
    );
    return true;
  }

  private acquireSubscription(subscription: BrowserRelaySubscription): void {
    const key = subscriptionKey(subscription);
    const count = (this.subscriberCounts.get(key) ?? 0) + 1;
    this.subscriberCounts.set(key, count);
    this.options.onSubscriberCountChanged?.(
      subscription.ownerId,
      subscription.ownerGenerationId,
      count,
    );
  }

  private releaseSubscription(
    subscription: BrowserRelaySubscription | null,
  ): void {
    if (!subscription) return;
    const key = subscriptionKey(subscription);
    const count = Math.max(0, (this.subscriberCounts.get(key) ?? 1) - 1);
    if (count === 0) this.subscriberCounts.delete(key);
    else this.subscriberCounts.set(key, count);
    this.options.onSubscriberCountChanged?.(
      subscription.ownerId,
      subscription.ownerGenerationId,
      count,
    );
  }

  private removeConnection(browserConnectionId: string): void {
    const connection = this.connections.get(browserConnectionId);
    if (!connection) return;
    this.connections.delete(browserConnectionId);
    this.options.onConnectionClosed?.(browserConnectionId);
    if (connection.keepaliveTimer) clearInterval(connection.keepaliveTimer);
    this.releaseSubscription(connection.subscription);
    connection.releaseLifecycle();
  }
}

function subscriptionKey(subscription: {
  ownerId: string;
  ownerGenerationId: string;
}): string {
  return `${subscription.ownerId}\u0000${subscription.ownerGenerationId}`;
}

function relayEventId(
  helperGenerationId: string,
  ownerId: string,
  ownerGenerationId: string,
  relaySequence: number,
): string {
  return [
    helperGenerationId,
    encodeURIComponent(ownerId),
    encodeURIComponent(ownerGenerationId),
    relaySequence,
  ].join("/");
}

function parseRelayCursor(
  value: string | string[] | undefined,
  helperGenerationId: string,
): {
  cursor: number | null;
  ownerId: string | null;
  ownerGenerationId: string | null;
  helperGenerationChanged: boolean;
} {
  const empty = {
    cursor: null,
    ownerId: null,
    ownerGenerationId: null,
    helperGenerationChanged: false,
  };
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return empty;
  const parts = raw.split("/");
  if (parts.length === 4) {
    const [
      encodedHelperGenerationId,
      encodedOwnerId,
      encodedOwnerGenerationId,
      sequence,
    ] = parts;
    if (!/^\d+$/.test(sequence!)) return empty;
    try {
      const parsed = Number(sequence);
      return {
        cursor: Number.isSafeInteger(parsed) ? parsed : null,
        ownerId: decodeURIComponent(encodedOwnerId!),
        ownerGenerationId: decodeURIComponent(encodedOwnerGenerationId!),
        helperGenerationChanged:
          encodedHelperGenerationId !== helperGenerationId,
      };
    } catch {
      return empty;
    }
  }
  if (!/^\d+$/.test(raw)) return empty;
  const parsed = Number(raw);
  return {
    ...empty,
    cursor: Number.isSafeInteger(parsed) ? parsed : null,
  };
}

function consumeRateLimit(
  timestamps: number[],
  maximumPerSecond: number,
  now: number,
): boolean {
  while (timestamps.length > 0 && now - timestamps[0]! >= 1_000) {
    timestamps.shift();
  }
  if (timestamps.length >= maximumPerSecond) return false;
  timestamps.push(now);
  return true;
}

function parseCommandCredentials(value: unknown): {
  browserConnectionId: string;
  csrfNonce: string;
  subscriptionId: string;
} | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.browserConnectionId !== "string" ||
    !record.browserConnectionId.trim() ||
    Buffer.byteLength(record.browserConnectionId) > 256 ||
    typeof record.csrfNonce !== "string" ||
    !record.csrfNonce.trim() ||
    Buffer.byteLength(record.csrfNonce) > 256 ||
    typeof record.subscriptionId !== "string" ||
    !record.subscriptionId.trim() ||
    Buffer.byteLength(record.subscriptionId) > 256
  ) {
    return null;
  }
  return {
    browserConnectionId: record.browserConnectionId.trim(),
    csrfNonce: record.csrfNonce.trim(),
    subscriptionId: record.subscriptionId.trim(),
  };
}

function parseOperationStatusRequest(value: unknown): {
  browserConnectionId: string;
  csrfNonce: string;
  subscriptionId: string;
  operationId: string;
} | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const allowed = new Set([
    "browserConnectionId",
    "csrfNonce",
    "subscriptionId",
    "operationId",
  ]);
  if (Object.keys(record).some((key) => !allowed.has(key))) return null;
  for (const key of allowed) {
    if (
      typeof record[key] !== "string" ||
      !(record[key] as string).trim() ||
      Buffer.byteLength(record[key] as string) > 256
    ) {
      return null;
    }
  }
  return {
    browserConnectionId: (record.browserConnectionId as string).trim(),
    csrfNonce: (record.csrfNonce as string).trim(),
    subscriptionId: (record.subscriptionId as string).trim(),
    operationId: (record.operationId as string).trim(),
  };
}

function parseSubscriptionRequest(value: unknown): SubscriptionRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid_request");
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set([
    "browserConnectionId",
    "csrfNonce",
    "ownerId",
    "ownerGenerationId",
  ]);
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    throw new Error("invalid_request");
  }
  for (const key of allowed) {
    if (
      typeof record[key] !== "string" ||
      !(record[key] as string).trim() ||
      Buffer.byteLength(record[key] as string) > 256
    ) {
      throw new Error("invalid_request");
    }
  }
  return {
    browserConnectionId: (record.browserConnectionId as string).trim(),
    csrfNonce: (record.csrfNonce as string).trim(),
    ownerId: (record.ownerId as string).trim(),
    ownerGenerationId: (record.ownerGenerationId as string).trim(),
  };
}

function hasValidSameOrigin(
  req: http.IncomingMessage,
  isAllowedHost: (host: string) => boolean,
): boolean {
  const host = req.headers.host;
  const origin = req.headers.origin;
  if (
    typeof host !== "string" ||
    !/^(?:\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+)(?::\d{1,5})?$/.test(host) ||
    typeof origin !== "string"
  ) {
    return false;
  }
  try {
    return isAllowedHost(host) && new URL(origin).origin === `http://${host}`;
  } catch {
    return false;
  }
}

function boundedString(value: string, maximumBytes: number): string {
  if (Buffer.byteLength(value) <= maximumBytes) return value;
  let result = "";
  for (const character of value) {
    if (Buffer.byteLength(result + character) > maximumBytes) break;
    result += character;
  }
  return result;
}

function writeJson(
  res: http.ServerResponse,
  status: number,
  payload: unknown,
): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}
