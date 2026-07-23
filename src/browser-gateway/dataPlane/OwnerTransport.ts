import type { BrowserGatewayCoreOwnerLeaseRegistration } from "../protocol.js";
import type { BrowserGatewayCoreOwnerRegistrationResolution } from "../coreOwnerRegistry.js";
import { BROWSER_GATEWAY_DATA_PLANE_LIMITS } from "./limits.js";
import {
  BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION,
  parseBrowserGatewayDetailHandle,
  parseBrowserGatewayOwnerCommand,
  parseBrowserGatewayOwnerCommandAck,
  parseBrowserGatewayOwnerControl,
  parseBrowserGatewayOwnerPublicationBatch,
  type BrowserGatewayDetailHandle,
  type BrowserGatewayOwnerCheckpoint,
  type BrowserGatewayOwnerCommand,
  type BrowserGatewayOwnerCommandAck,
  type BrowserGatewayOwnerControl,
  type BrowserGatewayOwnerEvent,
  type BrowserGatewayOwnerEventKind,
  type BrowserGatewayOwnerPublicationBatch,
  type BrowserGatewayTranscriptMessage,
} from "./protocol.js";
import type { BrowserGatewayOwnerProjectionPublication } from "./ownerProjectionAdapter.js";

export interface BrowserGatewayOwnerTransportRegistration {
  readonly requestedOwnerId: string;
  readonly effectiveOwnerId: string;
  readonly ownerGenerationId: string;
  readonly helperGenerationId: string;
  readonly resolution: BrowserGatewayCoreOwnerRegistrationResolution;
}

export interface BrowserGatewayOwnerTransportPublicationAck {
  readonly helperGenerationId: string;
  readonly ownerId: string;
  readonly ownerGenerationId: string;
  readonly batchId: string;
  readonly cursor: number;
  readonly duplicate: boolean;
}

export interface BrowserGatewayOwnerPublicationBacklog {
  readonly pendingBatches: number;
  readonly queuedBytes: number;
}

export interface BrowserGatewayOwnerTransport {
  register(): Promise<BrowserGatewayOwnerTransportRegistration>;
  heartbeat(): Promise<void>;
  publish(
    batch: BrowserGatewayOwnerPublicationBatch,
  ): Promise<BrowserGatewayOwnerTransportPublicationAck>;
  uploadDetail(
    handle: BrowserGatewayDetailHandle,
    content: Uint8Array,
  ): Promise<void>;
  acknowledge(acknowledgement: BrowserGatewayOwnerCommandAck): Promise<void>;
  onCommand(
    handler: (command: BrowserGatewayOwnerCommand) => void | Promise<void>,
  ): { dispose(): void };
  onControl(
    handler: (control: BrowserGatewayOwnerControl) => void | Promise<void>,
  ): { dispose(): void };
  getPublicationBacklog(): BrowserGatewayOwnerPublicationBacklog;
  drain(): Promise<void>;
  close(): Promise<void>;
}

export interface HttpBrowserGatewayOwnerTransportOptions {
  readonly helperUrl: string;
  readonly clientSharedSecret: string;
  readonly helperGenerationId: string;
  readonly owner: BrowserGatewayCoreOwnerLeaseRegistration;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly random?: () => number;
  readonly createBatchId?: () => string;
  readonly getCheckpoint: () => BrowserGatewayOwnerCheckpoint;
  readonly getRecoveryCheckpointPublication?: () => Extract<
    BrowserGatewayOwnerProjectionPublication,
    { kind: "checkpoint" }
  >;
  readonly setTimeout?: (
    callback: () => void,
    timeoutMs: number,
  ) => ReturnType<typeof setTimeout>;
  readonly clearTimeout?: (timer: ReturnType<typeof setTimeout>) => void;
  readonly requestTimeoutMs?: number;
  readonly retryBaseMs?: number;
  readonly retryMaximumMs?: number;
  readonly retryAttempts?: number;
  readonly reconnectBaseMs?: number;
  readonly reconnectMaximumMs?: number;
  readonly log?: (message: string) => void;
}

type QueuedPublication = {
  checkpoint: BrowserGatewayOwnerPublicationBatch["checkpoint"];
  events: BrowserGatewayOwnerPublicationBatch["events"];
  details: Map<
    string,
    NonNullable<BrowserGatewayOwnerProjectionPublication["details"]>[number]
  >;
};

type ExecutedCommand = {
  readonly fingerprint: string;
  readonly deadlineAt: number;
  acknowledgement?: BrowserGatewayOwnerCommandAck;
  updatedAt: number;
};

const IMMEDIATE_EVENT_KINDS = new Set<BrowserGatewayOwnerEventKind>([
  "interaction.updated",
  "operation.updated",
]);

export function isBrowserGatewayOwnerImmediateEventKind(
  kind: BrowserGatewayOwnerEventKind,
): boolean {
  return IMMEDIATE_EVENT_KINDS.has(kind);
}

export function isBrowserGatewayOwnerImmediateEvent(
  event: BrowserGatewayOwnerEvent,
): boolean {
  if (isBrowserGatewayOwnerImmediateEventKind(event.kind)) return true;
  if (
    event.kind !== "transcript.message.appended" &&
    event.kind !== "transcript.message.upserted"
  ) {
    return false;
  }
  const payload = event.payload as { message: BrowserGatewayTranscriptMessage };
  return (
    payload.message.error !== undefined ||
    payload.message.finalMarker !== undefined
  );
}

export class HttpBrowserGatewayOwnerTransport implements BrowserGatewayOwnerTransport {
  private readonly fetch: typeof fetch;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly createBatchId: () => string;
  private readonly scheduleTimeout: HttpBrowserGatewayOwnerTransportOptions["setTimeout"];
  private readonly cancelTimeout: HttpBrowserGatewayOwnerTransportOptions["clearTimeout"];
  private readonly commandHandlers = new Set<
    (command: BrowserGatewayOwnerCommand) => void | Promise<void>
  >();
  private readonly controlHandlers = new Set<
    (control: BrowserGatewayOwnerControl) => void | Promise<void>
  >();
  private readonly requestControllers = new Set<AbortController>();
  private readonly executedCommands = new Map<string, ExecutedCommand>();
  private effectiveOwnerId: string;
  private registered = false;
  private acceptingPublications = true;
  private closed = false;
  private queued: QueuedPublication = {
    checkpoint: null,
    events: [],
    details: new Map(),
  };
  private queuedBytes = 0;
  private checkpointRequired = false;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private inFlightPublication: Promise<void> | undefined;
  private publicationTail = Promise.resolve();
  private publicationError: unknown;
  private acknowledgedCursor = 0;
  private commandController: AbortController | undefined;
  private commandLoop: Promise<void> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectAttempt = 0;

  constructor(
    private readonly options: HttpBrowserGatewayOwnerTransportOptions,
  ) {
    this.fetch = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.scheduleTimeout = options.setTimeout ?? setTimeout;
    this.cancelTimeout = options.clearTimeout ?? clearTimeout;
    this.effectiveOwnerId = options.owner.ownerId;
    let nextBatchId = 0;
    this.createBatchId =
      options.createBatchId ??
      (() =>
        `${options.owner.ownerGenerationId}:batch:${++nextBatchId}:${this.now()}`);
  }

  async register(): Promise<BrowserGatewayOwnerTransportRegistration> {
    this.assertOpen();
    const response = await this.requestWithRetry(
      "/internal/core-owners/register",
      this.options.owner,
      "owner_registration",
    );
    if (!response.ok) throw await responseError(response, "owner_registration");
    const value = (await response.json()) as Record<string, unknown>;
    const effectiveOwnerId = requiredString(
      value.effectiveOwnerId,
      "effectiveOwnerId",
    );
    const requestedOwnerId = requiredString(
      value.requestedOwnerId,
      "requestedOwnerId",
    );
    const resolution = requiredRegistrationResolution(value.resolution);
    const helperGenerationId = requiredString(
      value.helperGenerationId,
      "helperGenerationId",
    );
    if (helperGenerationId !== this.options.helperGenerationId) {
      throw new Error("browser_gateway_helper_generation_mismatch");
    }
    if (requestedOwnerId !== this.options.owner.ownerId) {
      throw new Error("browser_gateway_requested_owner_mismatch");
    }
    this.effectiveOwnerId = effectiveOwnerId;
    this.registered = true;
    this.startCommandLoop();
    return {
      requestedOwnerId,
      effectiveOwnerId,
      ownerGenerationId: this.options.owner.ownerGenerationId,
      helperGenerationId,
      resolution,
    };
  }

  async heartbeat(): Promise<void> {
    this.assertRegistered();
    const response = await this.requestWithRetry(
      "/internal/core-owners/heartbeat",
      {
        ownerId: this.effectiveOwnerId,
        ownerGenerationId: this.options.owner.ownerGenerationId,
        capabilities: this.options.owner.capabilities,
      },
      "owner_heartbeat",
    );
    if (!response.ok) throw await responseError(response, "owner_heartbeat");
  }

  publish(
    value: BrowserGatewayOwnerPublicationBatch,
  ): Promise<BrowserGatewayOwnerTransportPublicationAck> {
    this.assertRegistered();
    if (!this.acceptingPublications) {
      throw new Error("browser_gateway_owner_transport_draining");
    }
    const batch = parseBrowserGatewayOwnerPublicationBatch(value);
    this.assertIdentity(batch);
    return this.serializePublication(batch);
  }

  enqueue(publication: BrowserGatewayOwnerProjectionPublication): void {
    this.assertRegistered();
    if (!this.acceptingPublications) {
      throw new Error("browser_gateway_owner_transport_draining");
    }
    const identity =
      publication.kind === "checkpoint"
        ? publication.checkpoint
        : publication.event;
    this.assertIdentity(identity);

    this.publicationError = undefined;
    if (publication.kind === "checkpoint") {
      const details = this.mergeQueuedDetails(new Map(), publication.details);
      this.queued = {
        checkpoint: publication.checkpoint,
        events: [],
        details,
      };
      this.checkpointRequired = false;
    } else if (!this.checkpointRequired) {
      const details = this.mergeQueuedDetails(
        this.queued.details,
        publication.details,
      );
      this.queued = {
        checkpoint: this.queued.checkpoint,
        events: [...this.queued.events, publication.event],
        details,
      };
    }
    this.queuedBytes = serializedBytes({
      checkpoint: null,
      events: this.queued.events,
    });
    if (
      this.queuedBytes >
      BROWSER_GATEWAY_DATA_PLANE_LIMITS.ownerPublicationQueueBytes
    ) {
      this.compactQueuedToCheckpoint();
    }

    if (
      publication.kind === "event" &&
      isBrowserGatewayOwnerImmediateEvent(publication.event)
    ) {
      this.flushQueued();
      return;
    }
    this.scheduleFlush();
  }

  async uploadDetail(
    value: BrowserGatewayDetailHandle,
    content: Uint8Array,
  ): Promise<void> {
    this.assertRegistered();
    if (!this.acceptingPublications) {
      throw new Error("browser_gateway_owner_transport_draining");
    }
    const handle = parseBrowserGatewayDetailHandle(value);
    this.assertIdentity(handle);
    if (content.byteLength !== handle.byteLength) {
      throw new Error("browser_gateway_detail_size_mismatch");
    }
    await this.uploadDetailWithRetry(handle, content);
  }

  private async uploadDetailWithRetry(
    handle: BrowserGatewayDetailHandle,
    content: Uint8Array,
  ): Promise<void> {
    const query = new URLSearchParams({ handle: JSON.stringify(handle) });
    const detailBytes = Uint8Array.from(content);
    const response = await this.requestRawWithRetry(
      `/internal/data-plane/details?${query}`,
      detailBytes,
      "owner_detail_upload",
    );
    if (!response.ok)
      throw await responseError(response, "owner_detail_upload");
    const acknowledgement = (await response.json()) as Record<string, unknown>;
    this.assertIdentity({
      helperGenerationId: requiredString(
        acknowledgement.helperGenerationId,
        "helperGenerationId",
      ),
      ownerId: requiredString(acknowledgement.ownerId, "ownerId"),
      ownerGenerationId: requiredString(
        acknowledgement.ownerGenerationId,
        "ownerGenerationId",
      ),
    });
    if (
      requiredString(acknowledgement.handleId, "handleId") !== handle.handleId
    ) {
      throw new Error("browser_gateway_detail_handle_mismatch");
    }
  }

  acknowledge(acknowledgement: BrowserGatewayOwnerCommandAck): Promise<void> {
    this.assertRegistered();
    const parsed = parseBrowserGatewayOwnerCommandAck(acknowledgement);
    this.assertIdentity(parsed);
    const executed = this.executedCommands.get(parsed.operation.operationId);
    if (executed) {
      executed.acknowledgement = parsed;
      executed.updatedAt = this.now();
      this.executedCommands.delete(parsed.operation.operationId);
      this.executedCommands.set(parsed.operation.operationId, executed);
    }
    return this.postAcknowledgement(parsed);
  }

  onCommand(
    handler: (command: BrowserGatewayOwnerCommand) => void | Promise<void>,
  ): { dispose(): void } {
    this.commandHandlers.add(handler);
    return { dispose: () => this.commandHandlers.delete(handler) };
  }

  onControl(
    handler: (control: BrowserGatewayOwnerControl) => void | Promise<void>,
  ): { dispose(): void } {
    this.controlHandlers.add(handler);
    return { dispose: () => this.controlHandlers.delete(handler) };
  }

  getPublicationBacklog(): BrowserGatewayOwnerPublicationBacklog {
    const hasQueuedBatch =
      this.queued.checkpoint !== null ||
      this.queued.events.length > 0 ||
      this.checkpointRequired;
    return {
      pendingBatches:
        (this.inFlightPublication ? 1 : 0) + (hasQueuedBatch ? 1 : 0),
      queuedBytes: this.queuedBytes,
    };
  }

  async drain(): Promise<void> {
    if (this.closed) return;
    this.acceptingPublications = false;
    if (this.flushTimer) {
      this.cancelTimeout?.(this.flushTimer);
      this.flushTimer = undefined;
    }
    this.flushQueued();
    while (this.inFlightPublication) await this.inFlightPublication;
    await this.publicationTail;
    if (this.publicationError !== undefined) throw this.publicationError;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    let drainError: unknown;
    try {
      await this.drain();
    } catch (error) {
      drainError = error;
    }
    this.closed = true;
    this.commandController?.abort();
    this.commandController = undefined;
    if (this.reconnectTimer) {
      this.cancelTimeout?.(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    for (const controller of this.requestControllers) controller.abort();
    this.requestControllers.clear();
    await this.commandLoop?.catch(() => undefined);
    this.commandHandlers.clear();
    this.controlHandlers.clear();
    this.executedCommands.clear();
    if (drainError !== undefined) throw drainError;
  }

  private scheduleFlush(): void {
    if (this.flushTimer || !this.acceptingPublications) return;
    this.flushTimer = this.scheduleTimeout?.(() => {
      this.flushTimer = undefined;
      this.flushQueued();
    }, BROWSER_GATEWAY_DATA_PLANE_LIMITS.ownerPublicationBatchWindowMs);
  }

  private flushQueued(): void {
    if (this.inFlightPublication) return;
    if (this.checkpointRequired) this.compactQueuedToCheckpoint();
    const queued = this.queued;
    if (!queued.checkpoint && queued.events.length === 0) return;
    this.queued = { checkpoint: null, events: [], details: new Map() };
    this.queuedBytes = 0;
    const batch = this.buildBatch(queued);
    let failed = false;
    const publication = this.serializePublication(batch, [
      ...queued.details.values(),
    ])
      .then(() => undefined)
      .catch((error) => {
        failed = true;
        this.publicationError = error;
        this.compactQueuedToCheckpoint();
        this.options.log?.(
          `[browser-gateway-data-plane] publication failed: ${String(error)}`,
        );
      })
      .finally(() => {
        if (this.inFlightPublication === publication) {
          this.inFlightPublication = undefined;
        }
        if (
          !failed &&
          (this.queued.checkpoint ||
            this.queued.events.length > 0 ||
            this.checkpointRequired)
        ) {
          this.flushQueued();
        }
      });
    this.inFlightPublication = publication;
  }

  private compactQueuedToCheckpoint(): void {
    const publication = this.options.getRecoveryCheckpointPublication?.() ?? {
      kind: "checkpoint" as const,
      checkpoint: this.options.getCheckpoint(),
    };
    this.assertIdentity(publication.checkpoint);
    if (publication.checkpoint.checkpointSequence < this.acknowledgedCursor) {
      throw new Error("browser_gateway_stale_recovery_checkpoint");
    }
    this.queued = {
      checkpoint: publication.checkpoint,
      events: [],
      details: this.mergeQueuedDetails(new Map(), publication.details),
    };
    this.queuedBytes = 0;
    this.checkpointRequired = false;
  }

  private mergeQueuedDetails(
    current: ReadonlyMap<
      string,
      NonNullable<BrowserGatewayOwnerProjectionPublication["details"]>[number]
    >,
    details: BrowserGatewayOwnerProjectionPublication["details"],
  ): QueuedPublication["details"] {
    const merged = new Map(current);
    for (const detail of details ?? []) {
      const handle = parseBrowserGatewayDetailHandle(detail.handle);
      this.assertIdentity(handle);
      if (detail.content.byteLength !== handle.byteLength) {
        throw new Error("browser_gateway_detail_size_mismatch");
      }
      const previous = merged.get(handle.handleId);
      if (
        previous &&
        (JSON.stringify(previous.handle) !== JSON.stringify(handle) ||
          !sameBytes(previous.content, detail.content))
      ) {
        throw new Error("browser_gateway_detail_handle_collision");
      }
      merged.set(handle.handleId, {
        handle,
        content: Uint8Array.from(detail.content),
      });
    }
    return merged;
  }

  private buildBatch(
    queued: QueuedPublication,
  ): BrowserGatewayOwnerPublicationBatch {
    const checkpointSequence = queued.checkpoint?.checkpointSequence;
    const firstSequence =
      queued.events[0]?.ownerSequence ?? checkpointSequence ?? 0;
    const lastSequence =
      queued.events.at(-1)?.ownerSequence ?? checkpointSequence ?? 0;
    return parseBrowserGatewayOwnerPublicationBatch({
      protocolVersion: BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION,
      helperGenerationId: this.options.helperGenerationId,
      ownerId: this.effectiveOwnerId,
      ownerGenerationId: this.options.owner.ownerGenerationId,
      batchId: this.createBatchId(),
      firstSequence,
      lastSequence,
      checkpoint: queued.checkpoint,
      events: queued.events,
    });
  }

  private serializePublication(
    batch: BrowserGatewayOwnerPublicationBatch,
    details: readonly NonNullable<
      BrowserGatewayOwnerProjectionPublication["details"]
    >[number][] = [],
  ): Promise<BrowserGatewayOwnerTransportPublicationAck> {
    const publication = this.publicationTail.then(async () => {
      for (const detail of details) {
        await this.uploadDetailWithRetry(detail.handle, detail.content);
      }
      return this.publishWithRetry(batch);
    });
    this.publicationTail = publication.then(
      () => undefined,
      () => undefined,
    );
    return publication;
  }

  private async publishWithRetry(
    batch: BrowserGatewayOwnerPublicationBatch,
  ): Promise<BrowserGatewayOwnerTransportPublicationAck> {
    const attempts = Math.max(1, this.options.retryAttempts ?? 4);
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const response = await this.request(
          "/internal/data-plane/publications",
          "POST",
          batch,
        );
        if (!response.ok) {
          const error = await responseError(response, "owner_publication");
          if (response.status < 500 || attempt + 1 >= attempts) throw error;
          lastError = error;
        } else {
          const acknowledgement = parsePublicationAck(await response.json());
          this.assertIdentity(acknowledgement);
          if (acknowledgement.batchId !== batch.batchId) {
            throw new Error("browser_gateway_publication_batch_mismatch");
          }
          if (acknowledgement.cursor < this.acknowledgedCursor) {
            throw new Error("browser_gateway_publication_cursor_regression");
          }
          this.acknowledgedCursor = acknowledgement.cursor;
          return acknowledgement;
        }
      } catch (error) {
        lastError = error;
        if (attempt + 1 >= attempts || !isRetryableTransportError(error))
          throw error;
      }
      await this.delay(this.retryDelay(attempt));
    }
    throw lastError;
  }

  private startCommandLoop(): void {
    if (this.closed || this.commandLoop) return;
    const controller = new AbortController();
    this.commandController = controller;
    this.commandLoop = this.runCommandLoop(controller.signal)
      .catch((error) => {
        if (!controller.signal.aborted && !this.closed) {
          this.options.log?.(
            `[browser-gateway-data-plane] command stream failed: ${String(error)}`,
          );
        }
      })
      .finally(() => {
        if (this.commandController === controller)
          this.commandController = undefined;
        this.commandLoop = undefined;
        if (!controller.signal.aborted && !this.closed && this.registered) {
          this.scheduleCommandReconnect();
        }
      });
  }

  private async runCommandLoop(signal: AbortSignal): Promise<void> {
    const query = new URLSearchParams({
      helperGenerationId: this.options.helperGenerationId,
      ownerId: this.effectiveOwnerId,
      ownerGenerationId: this.options.owner.ownerGenerationId,
    });
    const response = await this.fetch(
      `${this.options.helperUrl}/internal/data-plane/commands?${query}`,
      {
        headers: {
          Accept: "text/event-stream",
          Authorization: `Bearer ${this.options.clientSharedSecret}`,
        },
        signal,
      },
    );
    if (!response.ok)
      throw await responseError(response, "owner_command_stream");
    if (!response.body)
      throw new Error("browser_gateway_command_stream_missing_body");
    let receivedHello = false;
    await consumeSse(response.body, signal, async (event, data) => {
      if (event === "control") {
        const control = parseBrowserGatewayOwnerControl(JSON.parse(data));
        this.assertIdentity(control);
        if (control.kind === "hello") {
          if (receivedHello) {
            throw new Error("browser_gateway_duplicate_command_stream_hello");
          }
          receivedHello = true;
          this.reconnectAttempt = 0;
          if (this.publicationError !== undefined) {
            this.publicationError = undefined;
            this.flushQueued();
          }
        } else if (!receivedHello) {
          throw new Error("browser_gateway_command_stream_hello_required");
        }
        if (control.kind === "drain") this.acceptingPublications = false;
        for (const handler of this.controlHandlers) await handler(control);
        return;
      }
      if (event !== "command") {
        throw new Error(
          `browser_gateway_unknown_command_stream_event:${event}`,
        );
      }
      if (!receivedHello) {
        throw new Error("browser_gateway_command_stream_hello_required");
      }
      const command = parseBrowserGatewayOwnerCommand(JSON.parse(data));
      this.assertIdentity(command);
      if (command.deadlineAt <= this.now()) return;
      await this.dispatchCommand(command);
    });
  }

  private async dispatchCommand(
    command: BrowserGatewayOwnerCommand,
  ): Promise<void> {
    this.pruneExecutedCommands();
    const fingerprint = JSON.stringify(command);
    const existing = this.executedCommands.get(command.operationId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new Error("browser_gateway_command_operation_conflict");
      }
      if (existing.acknowledgement) {
        await this.postAcknowledgement(existing.acknowledgement);
      }
      return;
    }
    this.makeExecutedCommandCapacity();
    this.executedCommands.set(command.operationId, {
      fingerprint,
      deadlineAt: command.deadlineAt,
      updatedAt: this.now(),
    });
    for (const handler of this.commandHandlers) await handler(command);
  }

  private postAcknowledgement(
    acknowledgement: BrowserGatewayOwnerCommandAck,
  ): Promise<void> {
    return this.requestWithRetry(
      "/internal/data-plane/acknowledgements",
      acknowledgement,
      "owner_command_acknowledgement",
    ).then(async (response) => {
      if (!response.ok) {
        throw await responseError(response, "owner_command_acknowledgement");
      }
    });
  }

  private pruneExecutedCommands(): void {
    const now = this.now();
    for (const [operationId, executed] of this.executedCommands) {
      if (
        executed.deadlineAt <= now &&
        now - executed.updatedAt >=
          BROWSER_GATEWAY_DATA_PLANE_LIMITS.operationDedupeAgeMs
      ) {
        this.executedCommands.delete(operationId);
      }
    }
  }

  private makeExecutedCommandCapacity(): void {
    while (
      this.executedCommands.size >=
      BROWSER_GATEWAY_DATA_PLANE_LIMITS.operationDedupeRecords
    ) {
      const terminal = [...this.executedCommands.entries()].find(
        ([, executed]) => executed.acknowledgement !== undefined,
      );
      if (!terminal) {
        throw new Error("browser_gateway_command_dedupe_limit");
      }
      this.executedCommands.delete(terminal[0]);
    }
  }

  private scheduleCommandReconnect(): void {
    if (this.reconnectTimer || this.closed) return;
    const delay = this.reconnectDelay(this.reconnectAttempt);
    this.reconnectAttempt += 1;
    this.reconnectTimer = this.scheduleTimeout?.(() => {
      this.reconnectTimer = undefined;
      this.startCommandLoop();
    }, delay);
  }

  private async requestRawWithRetry(
    pathname: string,
    body: Uint8Array,
    operation: string,
  ): Promise<Response> {
    const attempts = Math.max(1, this.options.retryAttempts ?? 4);
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const response = await this.requestRaw(pathname, body);
        if (response.ok || response.status < 500) return response;
        lastError = await responseError(response, operation);
      } catch (error) {
        lastError = error;
        if (!isRetryableTransportError(error)) throw error;
      }
      if (attempt + 1 < attempts) await this.delay(this.retryDelay(attempt));
    }
    throw lastError;
  }

  private async requestWithRetry(
    pathname: string,
    body: unknown,
    operation: string,
  ): Promise<Response> {
    const attempts = Math.max(1, this.options.retryAttempts ?? 4);
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const response = await this.request(pathname, "POST", body);
        if (response.ok || response.status < 500) return response;
        lastError = await responseError(response, operation);
      } catch (error) {
        lastError = error;
        if (!isRetryableTransportError(error)) throw error;
      }
      if (attempt + 1 < attempts) await this.delay(this.retryDelay(attempt));
    }
    throw lastError;
  }

  private async request(
    pathname: string,
    method: "POST",
    body: unknown,
  ): Promise<Response> {
    const controller = new AbortController();
    this.requestControllers.add(controller);
    const timeoutMs = this.options.requestTimeoutMs ?? 5_000;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const timeoutError = new Error("browser_gateway_owner_transport_timeout");
    const deadline = new Promise<never>((_resolve, reject) => {
      deadlineTimer = this.scheduleTimeout?.(() => {
        controller.abort();
        reject(timeoutError);
      }, timeoutMs);
    });
    try {
      return await Promise.race([
        this.fetch(`${this.options.helperUrl}${pathname}`, {
          method,
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.options.clientSharedSecret}`,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        }),
        deadline,
      ]);
    } finally {
      if (deadlineTimer) this.cancelTimeout?.(deadlineTimer);
      this.requestControllers.delete(controller);
    }
  }

  private async requestRaw(
    pathname: string,
    body: Uint8Array,
  ): Promise<Response> {
    const controller = new AbortController();
    this.requestControllers.add(controller);
    const timeoutMs = this.options.requestTimeoutMs ?? 5_000;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const timeoutError = new Error("browser_gateway_owner_transport_timeout");
    const deadline = new Promise<never>((_resolve, reject) => {
      deadlineTimer = this.scheduleTimeout?.(() => {
        controller.abort();
        reject(timeoutError);
      }, timeoutMs);
    });
    const requestBody = Uint8Array.from(body).buffer;
    try {
      return await Promise.race([
        this.fetch(`${this.options.helperUrl}${pathname}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/octet-stream",
            Authorization: `Bearer ${this.options.clientSharedSecret}`,
          },
          body: requestBody,
          signal: controller.signal,
        }),
        deadline,
      ]);
    } finally {
      if (deadlineTimer) this.cancelTimeout?.(deadlineTimer);
      this.requestControllers.delete(controller);
    }
  }

  private retryDelay(attempt: number): number {
    const base = Math.max(1, this.options.retryBaseMs ?? 100);
    const maximum = Math.max(base, this.options.retryMaximumMs ?? 2_000);
    const exponential = Math.min(maximum, base * 2 ** attempt);
    return Math.max(0, Math.round(exponential * (0.8 + this.random() * 0.4)));
  }

  private reconnectDelay(attempt: number): number {
    const base = Math.max(1, this.options.reconnectBaseMs ?? 250);
    const maximum = Math.max(base, this.options.reconnectMaximumMs ?? 5_000);
    const exponential = Math.min(maximum, base * 2 ** attempt);
    return Math.max(0, Math.round(exponential * (0.8 + this.random() * 0.4)));
  }

  private delay(timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      this.scheduleTimeout?.(resolve, timeoutMs);
    });
  }

  private assertIdentity(identity: {
    helperGenerationId: string;
    ownerId: string;
    ownerGenerationId: string;
  }): void {
    if (identity.helperGenerationId !== this.options.helperGenerationId) {
      throw new Error("browser_gateway_helper_generation_mismatch");
    }
    if (identity.ownerId !== this.effectiveOwnerId) {
      throw new Error("browser_gateway_owner_identity_mismatch");
    }
    if (identity.ownerGenerationId !== this.options.owner.ownerGenerationId) {
      throw new Error("browser_gateway_owner_generation_mismatch");
    }
  }

  private assertRegistered(): void {
    this.assertOpen();
    if (!this.registered)
      throw new Error("browser_gateway_owner_not_registered");
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("browser_gateway_owner_transport_closed");
  }
}

async function consumeSse(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  onEvent: (event: string, data: string) => void | Promise<void>,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const cancelForAbort = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", cancelForAbort, { once: true });
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      while (true) {
        const boundary = findSseBoundary(buffer);
        if (!boundary) break;
        const frame = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary.length);
        assertSseFrameLimit(frame);
        const parsed = parseSseFrame(frame);
        if (parsed) await onEvent(parsed.event, parsed.data);
      }
      if (
        Buffer.byteLength(buffer, "utf-8") >
        BROWSER_GATEWAY_DATA_PLANE_LIMITS.ownerCommandBytes
      ) {
        throw new Error("browser_gateway_command_stream_frame_too_large");
      }
    }
  } finally {
    signal.removeEventListener("abort", cancelForAbort);
    await reader.cancel().catch(() => undefined);
  }
}

function assertSseFrameLimit(frame: string): void {
  if (
    Buffer.byteLength(frame, "utf-8") >
    BROWSER_GATEWAY_DATA_PLANE_LIMITS.ownerCommandBytes
  ) {
    throw new Error("browser_gateway_command_stream_frame_too_large");
  }
}

function findSseBoundary(
  value: string,
): { readonly index: number; readonly length: number } | null {
  const lf = value.indexOf("\n\n");
  const crlf = value.indexOf("\r\n\r\n");
  if (lf < 0 && crlf < 0) return null;
  if (crlf >= 0 && (lf < 0 || crlf < lf)) return { index: crlf, length: 4 };
  return { index: lf, length: 2 };
}

function parseSseFrame(
  frame: string,
): { readonly event: string; readonly data: string } | null {
  let event = "message";
  const data: string[] = [];
  for (const rawLine of frame.split(/\r\n|\r|\n/)) {
    if (!rawLine || rawLine.startsWith(":")) continue;
    const separator = rawLine.indexOf(":");
    const field = separator < 0 ? rawLine : rawLine.slice(0, separator);
    const rawValue = separator < 0 ? "" : rawLine.slice(separator + 1);
    const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
  if (data.length === 0) return null;
  return { event, data: data.join("\n") };
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf-8");
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function parsePublicationAck(
  value: unknown,
): BrowserGatewayOwnerTransportPublicationAck {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("browser_gateway_invalid_publication_ack");
  }
  const record = value as Record<string, unknown>;
  const allowedFields = new Set([
    "ok",
    "helperGenerationId",
    "ownerId",
    "ownerGenerationId",
    "batchId",
    "cursor",
    "duplicate",
  ]);
  for (const field of Object.keys(record)) {
    if (!allowedFields.has(field)) {
      throw new Error(`browser_gateway_unknown_publication_ack_field:${field}`);
    }
  }
  if (record.ok !== true)
    throw new Error("browser_gateway_invalid_publication_ack");
  const cursor = record.cursor;
  if (!Number.isSafeInteger(cursor) || (cursor as number) < 0) {
    throw new Error("browser_gateway_invalid_publication_cursor");
  }
  if (typeof record.duplicate !== "boolean") {
    throw new Error("browser_gateway_invalid_publication_duplicate");
  }
  return {
    helperGenerationId: requiredString(
      record.helperGenerationId,
      "helperGenerationId",
    ),
    ownerId: requiredString(record.ownerId, "ownerId"),
    ownerGenerationId: requiredString(
      record.ownerGenerationId,
      "ownerGenerationId",
    ),
    batchId: requiredString(record.batchId, "batchId"),
    cursor: cursor as number,
    duplicate: record.duplicate,
  };
}

async function responseError(
  response: Response,
  operation: string,
): Promise<Error> {
  let code = `http_${response.status}`;
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === "string" && body.error) code = body.error;
  } catch {
    // Status remains sufficient when an intermediary returns a non-JSON body.
  }
  const error = new Error(`browser_gateway_${operation}_${code}`) as Error & {
    status?: number;
  };
  error.status = response.status;
  return error;
}

function isRetryableTransportError(error: unknown): boolean {
  const status =
    error && typeof error === "object" && "status" in error
      ? (error as { status?: unknown }).status
      : undefined;
  if (typeof status === "number") return status >= 500;
  return (
    error instanceof TypeError ||
    (error instanceof Error &&
      (error.name === "AbortError" ||
        error.message === "browser_gateway_owner_transport_timeout"))
  );
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`browser_gateway_invalid_${field}`);
  }
  return value;
}

function requiredRegistrationResolution(
  value: unknown,
): BrowserGatewayCoreOwnerRegistrationResolution {
  if (
    value !== "registered" &&
    value !== "renewed" &&
    value !== "superseded" &&
    value !== "taken_over" &&
    value !== "collision_assigned"
  ) {
    throw new Error("browser_gateway_invalid_registration_resolution");
  }
  return value;
}
