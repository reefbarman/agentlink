import {
  BROWSER_GATEWAY_COMMAND_IDEMPOTENCY,
  BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION,
  parseBrowserGatewayOwnerCheckpoint,
  parseBrowserGatewayOwnerEvent,
  type BrowserGatewayCommandDeadlineClass,
  type BrowserGatewayCommandIdempotency,
  type BrowserGatewayDetailHandle,
  type BrowserGatewayOperationState,
  type BrowserGatewayOwnerCommandBody,
  type BrowserGatewayOwnerEvent,
} from "../../dataPlane/protocol";
import { randomId } from "../../../shared/randomId";
import { BROWSER_GATEWAY_DATA_PLANE_LIMITS } from "../../dataPlane/limits";
import {
  type RelayCatalogOwner,
  type RelayCheckpointRecord,
  type RelayEventRecord,
  RelayOwnerStore,
} from "./RelayOwnerStore";

export interface RelayEventSource {
  onopen: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
  close(): void;
  addEventListener(
    type: string,
    listener: (event: MessageEvent<string>) => void,
  ): void;
}

export interface RelayConnectionManagerOptions {
  store: RelayOwnerStore;
  eventSourceFactory?: (url: string) => RelayEventSource;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  random?: () => number;
  setTimeout?: RelaySetTimeout;
  clearTimeout?: RelayClearTimeout;
  eventTarget?: Pick<Window, "addEventListener" | "removeEventListener">;
  document?: Pick<
    Document,
    "visibilityState" | "addEventListener" | "removeEventListener"
  >;
  firstEventTimeoutMs?: number;
  staleVisibleTimeoutMs?: number;
  minimumReconnectMs?: number;
  maximumReconnectMs?: number;
  onCatalog?: (owners: readonly RelayCatalogOwner[]) => void;
  onCheckpoint?: (
    ownerId: string,
    ownerGenerationId: string,
    checkpoint: ReturnType<RelayOwnerStore["getCheckpoint"]> & {},
    sourceEvent?: BrowserGatewayOwnerEvent,
  ) => void;
  onOperation?: (operation: BrowserGatewayOperationState) => void;
  onStatus?: (status: RelayConnectionStatus) => void;
}

export type RelayConnectionStatus =
  | "connecting"
  | "connected"
  | "offline"
  | "reconnecting"
  | "closed";

export interface RelayOwnerSelection {
  ownerId: string;
  ownerGenerationId: string;
}

export interface RelayCommandRequest {
  operationId?: string;
  deadlineClass?: BrowserGatewayCommandDeadlineClass;
  command: BrowserGatewayOwnerCommandBody;
}

export interface RelaySessionDetailRequest {
  instanceId: string;
  controllerEpoch: string;
  tabId: string;
  sessionId: string;
}

export interface RelaySessionDetailResult {
  operationId: string;
  handle: BrowserGatewayDetailHandle;
  content: Uint8Array;
}

type ConnectionIdentity = {
  helperGenerationId: string;
  browserConnectionId: string;
  csrfNonce: string;
};

type SubscriptionIdentity = RelayOwnerSelection & {
  helperGenerationId: string;
  browserConnectionId: string;
  subscriptionId: string;
};

type PendingOperation = {
  operation: BrowserGatewayOperationState;
  idempotency: BrowserGatewayCommandIdempotency;
  ownerId: string;
  ownerGenerationId: string;
};

type OperationWaiter = {
  ownerId: string;
  ownerGenerationId: string;
  kind: BrowserGatewayOperationState["kind"];
  resolve: (operation: BrowserGatewayOperationState) => void;
};

type BufferedOwnerFrame =
  | {
      kind: "checkpoint";
      envelope: RelayOwnerRecordEnvelope<RelayCheckpointRecord>;
    }
  | { kind: "event"; envelope: RelayOwnerRecordEnvelope<RelayEventRecord> };

type RelayOwnerRecordEnvelope<TRecord> = {
  protocolVersion: string;
  helperGenerationId: string;
  subscriptionId: string;
  ownerId: string;
  ownerGenerationId: string;
  record: TRecord;
};

type RelayTimerHandle = number | ReturnType<typeof globalThis.setTimeout>;
type RelaySetTimeout = (
  handler: TimerHandler,
  timeout?: number,
  ...arguments_: unknown[]
) => RelayTimerHandle;
type RelayClearTimeout = (timer: RelayTimerHandle) => void;

const DEFAULT_FIRST_EVENT_TIMEOUT_MS = 5_000;
const DEFAULT_STALE_VISIBLE_TIMEOUT_MS = 45_000;
const DEFAULT_MINIMUM_RECONNECT_MS = 500;
const DEFAULT_MAXIMUM_RECONNECT_MS = 15_000;

export class RelayConnectionManager {
  private readonly store: RelayOwnerStore;
  private readonly createEventSource: (url: string) => RelayEventSource;
  private readonly fetch: typeof globalThis.fetch;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly setTimer: RelaySetTimeout;
  private readonly clearTimer: RelayClearTimeout;
  private readonly eventTarget: RelayConnectionManagerOptions["eventTarget"];
  private readonly document: RelayConnectionManagerOptions["document"];
  private readonly firstEventTimeoutMs: number;
  private readonly staleVisibleTimeoutMs: number;
  private readonly minimumReconnectMs: number;
  private readonly maximumReconnectMs: number;
  private readonly pendingOperations = new Map<string, PendingOperation>();
  private readonly operationWaiters = new Map<string, OperationWaiter>();
  private readonly earlyTerminalOperations = new Map<
    string,
    BrowserGatewayOperationState
  >();
  private readonly bufferedOwnerFrames: BufferedOwnerFrame[] = [];
  private source: RelayEventSource | null = null;
  private connection: ConnectionIdentity | null = null;
  private subscription: SubscriptionIdentity | null = null;
  private selectedOwner: RelayOwnerSelection | null = null;
  private subscriptionRequestId = 0;
  private reconnectAttempt = 0;
  private checkpointResyncPending = false;
  private reconnectTimer: RelayTimerHandle | null = null;
  private firstEventTimer: RelayTimerHandle | null = null;
  private staleEventTimer: RelayTimerHandle | null = null;
  private lastEventAt = 0;
  private started = false;
  private closed = false;
  private online = true;

  constructor(private readonly options: RelayConnectionManagerOptions) {
    this.store = options.store;
    this.createEventSource =
      options.eventSourceFactory ??
      ((url) => new EventSource(url) as unknown as RelayEventSource);
    this.fetch =
      options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.setTimer =
      options.setTimeout ??
      ((handler, timeout, ...arguments_) =>
        globalThis.setTimeout(handler, timeout, ...arguments_));
    this.clearTimer =
      options.clearTimeout ?? ((timer) => globalThis.clearTimeout(timer));
    this.eventTarget = options.eventTarget ?? globalThis.window;
    this.document = options.document ?? globalThis.document;
    this.firstEventTimeoutMs =
      options.firstEventTimeoutMs ?? DEFAULT_FIRST_EVENT_TIMEOUT_MS;
    this.staleVisibleTimeoutMs =
      options.staleVisibleTimeoutMs ?? DEFAULT_STALE_VISIBLE_TIMEOUT_MS;
    this.minimumReconnectMs =
      options.minimumReconnectMs ?? DEFAULT_MINIMUM_RECONNECT_MS;
    this.maximumReconnectMs =
      options.maximumReconnectMs ?? DEFAULT_MAXIMUM_RECONNECT_MS;
  }

  start(): void {
    if (this.started || this.closed) return;
    this.started = true;
    this.eventTarget?.addEventListener("online", this.handleOnline);
    this.eventTarget?.addEventListener("offline", this.handleOffline);
    this.document?.addEventListener(
      "visibilitychange",
      this.handleVisibilityChange,
    );
    if (this.online) this.connect("connecting");
    else this.options.onStatus?.("offline");
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.started = false;
    this.resolveOperationWaiters("relay_client_closed");
    this.eventTarget?.removeEventListener("online", this.handleOnline);
    this.eventTarget?.removeEventListener("offline", this.handleOffline);
    this.document?.removeEventListener(
      "visibilitychange",
      this.handleVisibilityChange,
    );
    this.closeSource();
    this.clearReconnectTimer();
    this.clearFirstEventTimer();
    this.clearStaleEventTimer();
    this.resolvePendingOperations("relay_client_closed");
    this.options.onStatus?.("closed");
  }

  selectOwner(owner: RelayOwnerSelection): void {
    if (
      this.selectedOwner?.ownerId === owner.ownerId &&
      this.selectedOwner.ownerGenerationId === owner.ownerGenerationId
    ) {
      return;
    }
    const previousOwner = this.selectedOwner;
    this.selectedOwner = owner;
    if (
      previousOwner?.ownerId === owner.ownerId &&
      previousOwner.ownerGenerationId !== owner.ownerGenerationId
    ) {
      this.resolveOwnerOperations(
        previousOwner.ownerId,
        previousOwner.ownerGenerationId,
        "owner_generation_changed",
      );
      this.resolveOwnerOperationWaiters(
        previousOwner.ownerId,
        previousOwner.ownerGenerationId,
        "owner_generation_changed",
      );
    }
    this.subscription = null;
    this.bufferedOwnerFrames.length = 0;
    const checkpoint = this.store.getCheckpoint(
      owner.ownerId,
      owner.ownerGenerationId,
    );
    if (checkpoint) {
      this.options.onCheckpoint?.(
        owner.ownerId,
        owner.ownerGenerationId,
        checkpoint,
      );
    }
    if (this.connection) void this.subscribeCurrentOwner();
  }

  isSubscribedTo(owner: RelayOwnerSelection): boolean {
    return Boolean(this.subscription && sameOwner(this.subscription, owner));
  }

  async requestSessionDetail(
    request: RelaySessionDetailRequest,
  ): Promise<RelaySessionDetailResult> {
    const subscription = this.subscription;
    if (!subscription) throw new Error("relay_subscription_required");
    const operationId = randomId();
    const terminal = new Promise<BrowserGatewayOperationState>((resolve) => {
      this.operationWaiters.set(operationId, {
        ownerId: subscription.ownerId,
        ownerGenerationId: subscription.ownerGenerationId,
        kind: "session.detail",
        resolve,
      });
    });

    try {
      const initial = await this.sendCommand({
        operationId,
        command: { kind: "session.detail", ...request },
      });
      const operation = initial.state === "accepted" ? await terminal : initial;
      if (
        operation.state !== "completed" ||
        operation.kind !== "session.detail" ||
        !operation.detailHandle
      ) {
        throw new Error(
          operation.message ?? `relay_session_detail_${operation.state}`,
        );
      }
      if (subscription !== this.subscription) {
        throw new Error("relay_session_detail_subscription_changed");
      }
      const handle = operation.detailHandle;
      if (
        handle.helperGenerationId !== subscription.helperGenerationId ||
        handle.ownerId !== subscription.ownerId ||
        handle.ownerGenerationId !== subscription.ownerGenerationId ||
        handle.kind !== "session" ||
        handle.mediaType !== "application/json; charset=utf-8" ||
        handle.expiresAt <= this.now() ||
        handle.byteLength >
          BROWSER_GATEWAY_DATA_PLANE_LIMITS.authenticatedDetailResponseBytes
      ) {
        throw new Error("relay_session_detail_handle_invalid");
      }
      const query = new URLSearchParams({
        handleId: handle.handleId,
        ownerId: handle.ownerId,
        ownerGenerationId: handle.ownerGenerationId,
      });
      const response = await this.fetch(`/api/relay/details?${query}`, {
        credentials: "same-origin",
      });
      if (!response.ok) {
        throw new Error(`relay_session_detail_failed_${response.status}`);
      }
      const content = new Uint8Array(await response.arrayBuffer());
      if (subscription !== this.subscription) {
        throw new Error("relay_session_detail_subscription_changed");
      }
      if (content.byteLength !== handle.byteLength) {
        throw new Error("relay_session_detail_size_mismatch");
      }
      return { operationId, handle, content };
    } finally {
      this.operationWaiters.delete(operationId);
      this.earlyTerminalOperations.delete(operationId);
    }
  }

  async sendCommand(
    request: RelayCommandRequest,
  ): Promise<BrowserGatewayOperationState> {
    const connection = this.connection;
    const subscription = this.subscription;
    if (!connection || !subscription)
      throw new Error("relay_subscription_required");
    const operationId = request.operationId ?? randomId();
    const idempotency =
      BROWSER_GATEWAY_COMMAND_IDEMPOTENCY[request.command.kind];
    const response = await this.fetch("/api/relay/commands", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        browserConnectionId: connection.browserConnectionId,
        csrfNonce: connection.csrfNonce,
        subscriptionId: subscription.subscriptionId,
        operationId,
        deadlineClass: request.deadlineClass ?? "default",
        command: request.command,
      }),
    });
    const body = (await response.json()) as {
      operation?: BrowserGatewayOperationState;
      ownerId?: string;
      ownerGenerationId?: string;
      error?: string;
    };
    if (
      !response.ok ||
      !body.operation ||
      body.ownerId !== subscription.ownerId ||
      body.ownerGenerationId !== subscription.ownerGenerationId ||
      body.operation.operationId !== operationId ||
      body.operation.kind !== request.command.kind
    ) {
      throw new Error(body.error ?? `relay_command_failed_${response.status}`);
    }
    const earlyTerminal = this.earlyTerminalOperations.get(operationId);
    if (earlyTerminal) return earlyTerminal;
    const pending: PendingOperation = {
      operation: body.operation,
      idempotency,
      ownerId: subscription.ownerId,
      ownerGenerationId: subscription.ownerGenerationId,
    };
    if (body.operation.state === "accepted") {
      this.pendingOperations.set(operationId, pending);
    }
    this.recordOperation(
      body.operation,
      subscription.ownerId,
      subscription.ownerGenerationId,
    );
    return body.operation;
  }

  private connect(status: "connecting" | "reconnecting"): void {
    if (this.closed || !this.online || this.source) return;
    this.options.onStatus?.(status);
    const cursor = this.selectedOwner
      ? this.store.getCursor(
          this.selectedOwner.ownerId,
          this.selectedOwner.ownerGenerationId,
        )
      : null;
    const url = cursor
      ? `/api/relay/events?cursor=${encodeURIComponent(cursor)}`
      : "/api/relay/events";
    const source = this.createEventSource(url);
    this.source = source;
    this.connection = null;
    this.subscription = null;
    this.bufferedOwnerFrames.length = 0;
    source.onopen = () => {
      if (this.source !== source || this.closed) return;
      // Authentication and helper identity are established by the first valid
      // hello frame, not by the transport opening.
    };
    source.onerror = () => {
      if (this.source !== source || this.closed) return;
      this.reconnect("transport_error");
    };
    source.addEventListener("hello", (event) =>
      this.handleHello(source, event),
    );
    source.addEventListener("catalog", (event) =>
      this.handleCatalog(source, event),
    );
    source.addEventListener("reset", (event) =>
      this.handleReset(source, event),
    );
    source.addEventListener("checkpoint", (event) =>
      this.handleOwnerFrame(source, "checkpoint", event),
    );
    source.addEventListener("owner.event", (event) =>
      this.handleOwnerFrame(source, "event", event),
    );
    source.addEventListener("relay.operation", (event) =>
      this.handleOperation(source, event),
    );
    this.firstEventTimer = this.setTimer(
      () => this.reconnect("first_event_timeout"),
      this.firstEventTimeoutMs,
    );
  }

  private handleHello(
    source: RelayEventSource,
    event: MessageEvent<string>,
  ): void {
    if (!this.acceptEvent(source)) return;
    const value = parseJsonRecord(event.data);
    if (
      value.protocolVersion !== BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION ||
      typeof value.helperGenerationId !== "string" ||
      typeof value.browserConnectionId !== "string" ||
      typeof value.csrfNonce !== "string"
    ) {
      this.reconnect("invalid_hello");
      return;
    }
    this.clearFirstEventTimer();
    const helperChanged = this.store.bindHelperGeneration(
      value.helperGenerationId,
    );
    if (helperChanged) {
      this.subscription = null;
      this.resolvePendingOperations("helper_generation_changed");
      this.resolveOperationWaiters("helper_generation_changed");
    }
    this.connection = {
      helperGenerationId: value.helperGenerationId,
      browserConnectionId: value.browserConnectionId,
      csrfNonce: value.csrfNonce,
    };
    this.reconnectAttempt = 0;
    this.options.onStatus?.("connected");
    if (this.selectedOwner) void this.subscribeCurrentOwner();
  }

  private handleCatalog(
    source: RelayEventSource,
    event: MessageEvent<string>,
  ): void {
    if (!this.acceptEvent(source)) return;
    const value = parseJsonRecord(event.data);
    if (
      value.protocolVersion !== BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION ||
      typeof value.helperGenerationId !== "string" ||
      value.helperGenerationId !== this.connection?.helperGenerationId ||
      !Array.isArray(value.owners)
    ) {
      return;
    }
    const owners = value.owners.filter(isCatalogOwner);
    if (owners.length !== value.owners.length) return;
    this.store.setCatalog(value.helperGenerationId, owners);
    this.options.onCatalog?.(this.store.getCatalog());
  }

  private handleReset(
    source: RelayEventSource,
    event: MessageEvent<string>,
  ): void {
    if (!this.acceptEvent(source)) return;
    const value = parseJsonRecord(event.data);
    if (
      typeof value.helperGenerationId !== "string" ||
      typeof value.ownerId !== "string" ||
      typeof value.ownerGenerationId !== "string"
    ) {
      return;
    }
    const subscription = this.subscription;
    if (
      value.helperGenerationId !== this.connection?.helperGenerationId ||
      !subscription ||
      typeof value.subscriptionId !== "string" ||
      value.subscriptionId !== subscription.subscriptionId ||
      value.ownerId !== subscription.ownerId ||
      value.ownerGenerationId !== subscription.ownerGenerationId
    ) {
      return;
    }
    this.store.invalidate(value.ownerId, value.ownerGenerationId);
  }

  private handleOwnerFrame(
    source: RelayEventSource,
    kind: "checkpoint" | "event",
    event: MessageEvent<string>,
  ): void {
    if (!this.acceptEvent(source)) return;
    const envelope = parseOwnerEnvelope(event.data, kind);
    if (
      !envelope ||
      envelope.helperGenerationId !== this.connection?.helperGenerationId
    ) {
      return;
    }
    if (!this.subscription) {
      if (this.selectedOwner && sameOwner(this.selectedOwner, envelope)) {
        this.bufferedOwnerFrames.push({ kind, envelope } as BufferedOwnerFrame);
      }
      return;
    }
    if (!this.isCurrentSubscription(envelope)) return;
    this.applyOwnerFrame({ kind, envelope } as BufferedOwnerFrame);
  }

  private applyOwnerFrame(frame: BufferedOwnerFrame): void {
    const result =
      frame.kind === "checkpoint"
        ? this.store.applyCheckpoint(
            frame.envelope.helperGenerationId,
            frame.envelope.record,
          )
        : this.store.applyEvent(
            frame.envelope.helperGenerationId,
            frame.envelope.record,
          );
    if (result.status === "checkpoint_required") {
      if (!this.checkpointResyncPending) {
        this.checkpointResyncPending = true;
        this.subscription = null;
        this.bufferedOwnerFrames.length = 0;
        void this.subscribeCurrentOwner().finally(() => {
          this.checkpointResyncPending = false;
        });
      }
      return;
    }
    if (result.status === "applied") {
      this.options.onCheckpoint?.(
        frame.envelope.ownerId,
        frame.envelope.ownerGenerationId,
        result.checkpoint,
        frame.kind === "event" ? frame.envelope.record.event : undefined,
      );
    }
  }

  private handleOperation(
    source: RelayEventSource,
    event: MessageEvent<string>,
  ): void {
    if (!this.acceptEvent(source)) return;
    const value = parseJsonRecord(event.data);
    const operation = value.operation as
      | BrowserGatewayOperationState
      | undefined;
    if (
      !operation ||
      typeof operation.operationId !== "string" ||
      typeof operation.state !== "string" ||
      typeof value.helperGenerationId !== "string" ||
      value.helperGenerationId !== this.subscription?.helperGenerationId ||
      typeof value.subscriptionId !== "string" ||
      value.subscriptionId !== this.subscription?.subscriptionId ||
      typeof value.ownerId !== "string" ||
      typeof value.ownerGenerationId !== "string" ||
      !this.subscription ||
      value.ownerId !== this.subscription.ownerId ||
      value.ownerGenerationId !== this.subscription.ownerGenerationId
    ) {
      return;
    }
    this.recordOperation(operation, value.ownerId, value.ownerGenerationId);
  }

  private async subscribeCurrentOwner(): Promise<void> {
    const connection = this.connection;
    const owner = this.selectedOwner;
    if (!connection || !owner || this.closed) return;
    const requestId = ++this.subscriptionRequestId;
    try {
      const response = await this.fetch("/api/relay/subscription", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          browserConnectionId: connection.browserConnectionId,
          csrfNonce: connection.csrfNonce,
          ownerId: owner.ownerId,
          ownerGenerationId: owner.ownerGenerationId,
        }),
      });
      const body = (await response.json()) as Partial<SubscriptionIdentity> & {
        error?: string;
      };
      if (
        !response.ok ||
        requestId !== this.subscriptionRequestId ||
        connection !== this.connection ||
        owner !== this.selectedOwner ||
        typeof body.subscriptionId !== "string" ||
        typeof body.helperGenerationId !== "string" ||
        typeof body.browserConnectionId !== "string" ||
        typeof body.ownerId !== "string" ||
        typeof body.ownerGenerationId !== "string" ||
        body.helperGenerationId !== connection.helperGenerationId ||
        body.browserConnectionId !== connection.browserConnectionId ||
        body.ownerId !== owner.ownerId ||
        body.ownerGenerationId !== owner.ownerGenerationId
      ) {
        if (!response.ok && requestId === this.subscriptionRequestId) {
          this.reconnect(body.error ?? "subscription_failed");
        }
        return;
      }
      this.subscription = {
        helperGenerationId: body.helperGenerationId,
        browserConnectionId: body.browserConnectionId,
        subscriptionId: body.subscriptionId,
        ownerId: body.ownerId,
        ownerGenerationId: body.ownerGenerationId,
      };
      const frames = this.bufferedOwnerFrames.splice(0);
      for (const frame of frames) {
        if (this.isCurrentSubscription(frame.envelope))
          this.applyOwnerFrame(frame);
      }
      await this.reconcilePendingOperations();
    } catch {
      if (requestId === this.subscriptionRequestId) {
        this.reconnect("subscription_failed");
      }
    }
  }

  private async reconcilePendingOperations(): Promise<void> {
    const connection = this.connection;
    const subscription = this.subscription;
    if (!connection || !subscription) return;
    const candidates = [...this.pendingOperations.values()].filter((pending) =>
      sameOwner(pending, subscription),
    );
    await Promise.all(
      candidates.map(async (pending) => {
        try {
          const response = await this.fetch("/api/relay/operations/status", {
            method: "POST",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              browserConnectionId: connection.browserConnectionId,
              csrfNonce: connection.csrfNonce,
              subscriptionId: subscription.subscriptionId,
              operationId: pending.operation.operationId,
            }),
          });
          if (
            connection !== this.connection ||
            subscription !== this.subscription
          )
            return;
          if (response.status === 404) {
            this.resolveMissingOperation(pending);
            return;
          }
          const body = (await response.json()) as {
            helperGenerationId?: string;
            ownerId?: string;
            ownerGenerationId?: string;
            operation?: BrowserGatewayOperationState;
          };
          if (
            !response.ok ||
            !body.operation ||
            body.helperGenerationId !== subscription.helperGenerationId ||
            body.ownerId !== subscription.ownerId ||
            body.ownerGenerationId !== subscription.ownerGenerationId ||
            body.operation.operationId !== pending.operation.operationId ||
            body.operation.kind !== pending.operation.kind
          ) {
            this.resolveMissingOperation(pending);
            return;
          }
          pending.operation = body.operation;
          this.recordOperation(
            body.operation,
            subscription.ownerId,
            subscription.ownerGenerationId,
          );
        } catch {
          if (
            connection === this.connection &&
            subscription === this.subscription
          ) {
            this.resolveMissingOperation(pending);
          }
        }
      }),
    );
  }

  private resolveOwnerOperations(
    ownerId: string,
    ownerGenerationId: string,
    message: string,
  ): void {
    for (const pending of this.pendingOperations.values()) {
      if (
        pending.ownerId !== ownerId ||
        pending.ownerGenerationId !== ownerGenerationId
      ) {
        continue;
      }
      this.resolveOperation(pending, message);
    }
  }

  private resolveOwnerOperationWaiters(
    ownerId: string,
    ownerGenerationId: string,
    message: string,
  ): void {
    for (const [operationId, waiter] of this.operationWaiters) {
      if (
        waiter.ownerId !== ownerId ||
        waiter.ownerGenerationId !== ownerGenerationId
      ) {
        continue;
      }
      this.recordOperation(
        {
          operationId,
          kind: waiter.kind,
          state: "failed",
          message,
        },
        ownerId,
        ownerGenerationId,
      );
    }
  }

  private resolvePendingOperations(message: string): void {
    for (const pending of this.pendingOperations.values()) {
      this.resolveOperation(pending, message);
    }
  }

  private resolveOperation(pending: PendingOperation, message: string): void {
    const operation: BrowserGatewayOperationState = {
      operationId: pending.operation.operationId,
      kind: pending.operation.kind,
      state: pending.idempotency === "idempotent" ? "failed" : "uncertain",
      message,
    };
    this.recordOperation(operation, pending.ownerId, pending.ownerGenerationId);
  }

  private resolveMissingOperation(pending: PendingOperation): void {
    const operation: BrowserGatewayOperationState = {
      operationId: pending.operation.operationId,
      kind: pending.operation.kind,
      state: pending.idempotency === "idempotent" ? "failed" : "uncertain",
      message:
        pending.idempotency === "idempotent"
          ? "operation_status_unavailable_retry_required"
          : "operation_status_unavailable_do_not_retry",
    };
    this.recordOperation(operation, pending.ownerId, pending.ownerGenerationId);
  }

  private recordOperation(
    operation: BrowserGatewayOperationState,
    ownerId: string,
    ownerGenerationId: string,
  ): void {
    if (operation.state !== "accepted") {
      this.pendingOperations.delete(operation.operationId);
      const waiter = this.operationWaiters.get(operation.operationId);
      if (
        waiter &&
        waiter.ownerId === ownerId &&
        waiter.ownerGenerationId === ownerGenerationId &&
        waiter.kind === operation.kind
      ) {
        this.earlyTerminalOperations.set(operation.operationId, operation);
        waiter.resolve(operation);
      }
    }
    this.options.onOperation?.(operation);
  }

  private resolveOperationWaiters(message: string): void {
    for (const [operationId, waiter] of this.operationWaiters) {
      if (this.pendingOperations.has(operationId)) continue;
      this.recordOperation(
        {
          operationId,
          kind: waiter.kind,
          state: "failed",
          message,
        },
        waiter.ownerId,
        waiter.ownerGenerationId,
      );
    }
  }

  private acceptEvent(source: RelayEventSource): boolean {
    if (this.source !== source || this.closed) return false;
    this.lastEventAt = this.now();
    this.armStaleEventTimer();
    return true;
  }

  private isCurrentSubscription(envelope: {
    helperGenerationId: string;
    subscriptionId: string;
    ownerId: string;
    ownerGenerationId: string;
  }): boolean {
    const subscription = this.subscription;
    return Boolean(
      subscription &&
      envelope.helperGenerationId === subscription.helperGenerationId &&
      envelope.subscriptionId === subscription.subscriptionId &&
      sameOwner(envelope, subscription),
    );
  }

  private reconnect(_reason: string): void {
    if (this.closed) return;
    this.closeSource();
    this.clearFirstEventTimer();
    this.clearStaleEventTimer();
    this.connection = null;
    this.subscription = null;
    this.checkpointResyncPending = false;
    this.subscriptionRequestId += 1;
    if (!this.online) {
      this.options.onStatus?.("offline");
      return;
    }
    this.clearReconnectTimer();
    const exponential = Math.min(
      this.maximumReconnectMs,
      this.minimumReconnectMs * 2 ** this.reconnectAttempt,
    );
    this.reconnectAttempt += 1;
    const delay = Math.round(exponential * (0.75 + this.random() * 0.5));
    this.options.onStatus?.("reconnecting");
    this.reconnectTimer = this.setTimer(() => {
      this.reconnectTimer = null;
      this.connect("reconnecting");
    }, delay);
  }

  private closeSource(): void {
    const source = this.source;
    this.source = null;
    source?.close();
  }

  private clearReconnectTimer(): void {
    if (!this.reconnectTimer) return;
    this.clearTimer(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private armStaleEventTimer(): void {
    this.clearStaleEventTimer();
    this.staleEventTimer = this.setTimer(() => {
      this.staleEventTimer = null;
      if (!this.closed && this.source && this.online) {
        this.reconnect("stale_event_timeout");
      }
    }, this.staleVisibleTimeoutMs);
  }

  private clearStaleEventTimer(): void {
    if (!this.staleEventTimer) return;
    this.clearTimer(this.staleEventTimer);
    this.staleEventTimer = null;
  }

  private clearFirstEventTimer(): void {
    if (!this.firstEventTimer) return;
    this.clearTimer(this.firstEventTimer);
    this.firstEventTimer = null;
  }

  private readonly handleOffline = (): void => {
    this.online = false;
    this.connection = null;
    this.subscription = null;
    this.subscriptionRequestId += 1;
    this.closeSource();
    this.clearReconnectTimer();
    this.clearFirstEventTimer();
    this.clearStaleEventTimer();
    this.options.onStatus?.("offline");
  };

  private readonly handleOnline = (): void => {
    this.online = true;
    this.reconnectAttempt = 0;
    this.connect("reconnecting");
  };

  private readonly handleVisibilityChange = (): void => {
    if (
      this.document?.visibilityState === "visible" &&
      this.now() - this.lastEventAt >= this.staleVisibleTimeoutMs
    ) {
      this.reconnect("visible_stale");
    }
  };
}

function parseOwnerEnvelope(
  data: string,
  kind: "checkpoint" | "event",
): RelayOwnerRecordEnvelope<RelayCheckpointRecord | RelayEventRecord> | null {
  try {
    const value = JSON.parse(data) as Record<string, unknown>;
    if (
      value.protocolVersion !== BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION ||
      typeof value.helperGenerationId !== "string" ||
      typeof value.subscriptionId !== "string" ||
      typeof value.ownerId !== "string" ||
      typeof value.ownerGenerationId !== "string" ||
      !value.record ||
      typeof value.record !== "object"
    ) {
      return null;
    }
    const rawRecord = value.record as Record<string, unknown>;
    if (
      rawRecord.kind !== kind ||
      typeof rawRecord.relaySequence !== "number" ||
      !Number.isSafeInteger(rawRecord.relaySequence) ||
      rawRecord.relaySequence < 0 ||
      typeof rawRecord.ownerSequence !== "number" ||
      !Number.isSafeInteger(rawRecord.ownerSequence) ||
      rawRecord.ownerSequence < 0
    ) {
      return null;
    }
    const record =
      kind === "checkpoint"
        ? ({
            kind,
            relaySequence: rawRecord.relaySequence,
            ownerSequence: rawRecord.ownerSequence,
            checkpoint: parseBrowserGatewayOwnerCheckpoint(
              rawRecord.checkpoint,
            ),
          } satisfies RelayCheckpointRecord)
        : ({
            kind,
            relaySequence: rawRecord.relaySequence,
            ownerSequence: rawRecord.ownerSequence,
            event: parseBrowserGatewayOwnerEvent(rawRecord.event),
          } satisfies RelayEventRecord);
    const identity =
      kind === "checkpoint"
        ? (record as RelayCheckpointRecord).checkpoint
        : (record as RelayEventRecord).event;
    if (
      identity.ownerId !== value.ownerId ||
      identity.ownerGenerationId !== value.ownerGenerationId ||
      identity.helperGenerationId !== value.helperGenerationId
    ) {
      return null;
    }
    return {
      protocolVersion: value.protocolVersion,
      helperGenerationId: value.helperGenerationId,
      subscriptionId: value.subscriptionId,
      ownerId: value.ownerId,
      ownerGenerationId: value.ownerGenerationId,
      record,
    };
  } catch {
    return null;
  }
}

function parseJsonRecord(data: string): Record<string, unknown> {
  try {
    const value = JSON.parse(data) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function isCatalogOwner(value: unknown): value is RelayCatalogOwner {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const owner = value as Record<string, unknown>;
  if (
    typeof owner.ownerId !== "string" ||
    typeof owner.ownerGenerationId !== "string" ||
    typeof owner.ownerKind !== "string" ||
    typeof owner.displayName !== "string" ||
    (owner.instanceId !== undefined && typeof owner.instanceId !== "string") ||
    typeof owner.status !== "string" ||
    !Array.isArray(owner.capabilities) ||
    !owner.capabilities.every(isCatalogCapability) ||
    !owner.scope ||
    typeof owner.scope !== "object" ||
    Array.isArray(owner.scope)
  ) {
    return false;
  }
  const scope = owner.scope as Record<string, unknown>;
  return scope.kind === "workspace"
    ? typeof scope.workspaceId === "string" &&
        typeof scope.displayName === "string"
    : scope.kind === "projectless" &&
        typeof scope.scopeId === "string" &&
        typeof scope.displayName === "string";
}

function isCatalogCapability(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const capability = value as Record<string, unknown>;
  return (
    typeof capability.capabilityId === "string" &&
    (capability.state === "enabled" ||
      capability.state === "disabled" ||
      capability.state === "requires_approval" ||
      capability.state === "unavailable") &&
    (capability.reason === undefined || typeof capability.reason === "string")
  );
}

function sameOwner(
  first: { ownerId: string; ownerGenerationId: string },
  second: { ownerId: string; ownerGenerationId: string },
): boolean {
  return (
    first.ownerId === second.ownerId &&
    first.ownerGenerationId === second.ownerGenerationId
  );
}
