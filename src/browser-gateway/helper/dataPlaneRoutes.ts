import type * as http from "http";

import { BrowserGatewayCoreOwnerRegistry } from "../coreOwnerRegistry.js";
import {
  BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION,
  BrowserGatewayProtocolError,
  parseBrowserGatewayDetailHandle,
  parseBrowserGatewayOwnerCommand,
  parseBrowserGatewayOwnerCommandAck,
  parseBrowserGatewayOwnerControl,
  parseBrowserGatewayOwnerPublicationBatch,
  type BrowserGatewayDetailHandle,
  type BrowserGatewayOwnerCommand,
  type BrowserGatewayOwnerControl,
  type BrowserGatewayOwnerCommandAck,
  type BrowserGatewayOwnerPublicationBatch,
} from "../dataPlane/protocol.js";
import {
  BROWSER_GATEWAY_DATA_PLANE_LIMITS,
  browserGatewayDetailResponseByteLimit,
} from "../dataPlane/limits.js";
import { readBoundedBody, readJsonBody } from "../nodeHttpPrimitives.js";
import type { HelperLifecycleCoordinator } from "./HelperLifecycleCoordinator.js";
import type { InternalDataPlaneRouteHandler } from "./helperRouteFamilies.js";

export interface BrowserGatewayOwnerPublicationAck {
  readonly ok: true;
  readonly helperGenerationId: string;
  readonly ownerId: string;
  readonly ownerGenerationId: string;
  readonly batchId: string;
  readonly cursor: number;
  readonly duplicate: boolean;
}

export interface BrowserGatewayDataPlaneRoutesOptions {
  readonly helperGenerationId: string;
  readonly ownerRegistry: BrowserGatewayCoreOwnerRegistry;
  readonly lifecycle: HelperLifecycleCoordinator;
  readonly now?: () => number;
  readonly drainDeadlineMs?: number;
  readonly commandKeepaliveIntervalMs?: number;
  readonly onPublication?: (
    batch: BrowserGatewayOwnerPublicationBatch,
    acknowledgement: BrowserGatewayOwnerPublicationAck,
  ) => void | Promise<void>;
  readonly onAcknowledgement?: (
    acknowledgement: BrowserGatewayOwnerCommandAck,
  ) => boolean | void | Promise<boolean | void>;
  readonly onDetail?: (
    handle: BrowserGatewayDetailHandle,
    content: Uint8Array,
  ) => void | Promise<void>;
}

type OwnerGenerationState = {
  cursor: number;
  hasCheckpoint: boolean;
};

type OwnerCommandStream = {
  readonly response: http.ServerResponse;
  readonly releaseLifecycle: () => void;
  readonly keepaliveTimer: NodeJS.Timeout | undefined;
};

export class BrowserGatewayDataPlaneRoutes {
  private readonly generationStates = new Map<string, OwnerGenerationState>();
  private readonly commandStreams = new Map<string, OwnerCommandStream>();
  private readonly checkpointRequests = new Map<
    string,
    {
      reason: "sequence_gap" | "subscription_changed" | "checkpoint_required";
      latestSequence: number;
    }
  >();
  private readonly subscriberCounts = new Map<string, number>();
  private readonly pendingCommands = new Map<
    string,
    Map<string, BrowserGatewayOwnerCommand>
  >();
  private readonly ingestOperations = new Map<string, Promise<void>>();
  private readonly now: () => number;
  private readonly drainDeadlineMs: number;
  private readonly commandKeepaliveIntervalMs: number;
  private acceptingPublications = true;

  constructor(private readonly options: BrowserGatewayDataPlaneRoutesOptions) {
    this.now = options.now ?? Date.now;
    this.drainDeadlineMs = options.drainDeadlineMs ?? 10_000;
    this.commandKeepaliveIntervalMs =
      options.commandKeepaliveIntervalMs ?? 15_000;
  }

  async handle(
    handler: InternalDataPlaneRouteHandler,
    req: http.IncomingMessage,
    res: http.ServerResponse,
    requestUrl: URL,
  ): Promise<void> {
    switch (handler) {
      case "publications":
        return this.handlePublication(req, res);
      case "commands":
        this.handleCommandStream(req, res, requestUrl);
        return;
      case "acknowledgements":
        return this.handleAcknowledgement(req, res);
      case "details":
        return this.handleDetail(req, res, requestUrl);
    }
  }

  ownerRegistered(ownerId: string, ownerGenerationId: string): void {
    for (const key of this.keysForOwner(ownerId)) {
      if (key === ownerKey(ownerId, ownerGenerationId)) continue;
      this.closeCommandStreams(key);
      this.generationStates.delete(key);
      this.checkpointRequests.delete(key);
      this.subscriberCounts.delete(key);
      this.pendingCommands.delete(key);
    }
  }

  async ingestPublication(
    value: unknown,
  ): Promise<BrowserGatewayOwnerPublicationAck> {
    if (!this.acceptingPublications) {
      throw new DataPlaneRouteError(503, "helper_draining");
    }
    const batch = parseBrowserGatewayOwnerPublicationBatch(value);
    this.assertCurrentIdentity(batch);
    return this.ingest(batch);
  }

  publishControl(value: unknown): boolean {
    const control = parseBrowserGatewayOwnerControl(value);
    this.assertCurrentIdentity(control);
    const key = ownerKey(control.ownerId, control.ownerGenerationId);
    if (control.kind === "demand.changed") {
      this.subscriberCounts.set(key, control.payload.subscriberCount);
    } else if (control.kind === "checkpoint.requested") {
      this.checkpointRequests.set(key, control.payload);
    }
    const stream = this.commandStreams.get(key);
    return stream ? this.writeControl(stream.response, control) : false;
  }

  publishCommand(value: unknown): boolean {
    const command = parseBrowserGatewayOwnerCommand(value);
    this.assertCurrentIdentity(command);
    if (command.deadlineAt <= this.now()) return false;

    const key = ownerKey(command.ownerId, command.ownerGenerationId);
    let pending = this.pendingCommands.get(key);
    if (!pending) {
      pending = new Map();
      this.pendingCommands.set(key, pending);
    }
    const existing = pending.get(command.operationId);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(command)) {
        throw new DataPlaneRouteError(409, "operation_conflict");
      }
      return true;
    }
    pending.set(command.operationId, command);
    this.writeCommandToStreams(key, command);
    return true;
  }

  cancelCommand(value: unknown): boolean {
    const command = parseBrowserGatewayOwnerCommand(value);
    this.assertCurrentIdentity(command);
    const key = ownerKey(command.ownerId, command.ownerGenerationId);
    const pending = this.pendingCommands.get(key);
    pending?.delete(command.operationId);
    if (pending?.size === 0) this.pendingCommands.delete(key);
    return this.publishControl({
      protocolVersion: BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION,
      helperGenerationId: command.helperGenerationId,
      ownerId: command.ownerId,
      ownerGenerationId: command.ownerGenerationId,
      kind: "command.cancelled",
      emittedAt: this.now(),
      payload: { operationId: command.operationId },
    });
  }

  beginDrain(): void {
    if (!this.acceptingPublications) return;
    this.acceptingPublications = false;
    for (const [key, stream] of this.commandStreams) {
      const [ownerId, ownerGenerationId] = splitOwnerKey(key);
      const emittedAt = this.now();
      this.writeControl(stream.response, {
        protocolVersion: BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION,
        helperGenerationId: this.options.helperGenerationId,
        ownerId,
        ownerGenerationId,
        kind: "drain",
        emittedAt,
        payload: { deadlineAt: emittedAt + this.drainDeadlineMs },
      });
    }
  }

  close(): void {
    this.acceptingPublications = false;
    for (const key of this.commandStreams.keys()) this.closeCommandStreams(key);
    this.generationStates.clear();
    this.checkpointRequests.clear();
    this.subscriberCounts.clear();
    this.pendingCommands.clear();
  }

  private async handlePublication(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    if (!this.acceptingPublications) {
      writeJson(res, 503, { error: "helper_draining" });
      return;
    }
    try {
      const acknowledgement = await this.ingestPublication(
        await readJsonBody(
          req,
          BROWSER_GATEWAY_DATA_PLANE_LIMITS.ownerPublicationRequestBytes,
        ),
      );
      writeJson(res, 200, acknowledgement);
    } catch (error) {
      this.writeProtocolError(res, error);
    }
  }

  private handleCommandStream(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    requestUrl: URL,
  ): void {
    const identity = {
      helperGenerationId:
        requestUrl.searchParams.get("helperGenerationId") ?? "",
      ownerId: requestUrl.searchParams.get("ownerId") ?? "",
      ownerGenerationId: requestUrl.searchParams.get("ownerGenerationId") ?? "",
    };
    try {
      this.assertCurrentIdentity(identity);
    } catch (error) {
      this.writeProtocolError(res, error);
      return;
    }

    req.socket.setTimeout(0);
    res.socket?.setTimeout(0);
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders?.();

    const key = ownerKey(identity.ownerId, identity.ownerGenerationId);
    this.closeCommandStreams(key);
    const stream = {} as OwnerCommandStream;
    const remove = (): void => {
      if (this.commandStreams.get(key) === stream) {
        this.commandStreams.delete(key);
      }
      if (stream.keepaliveTimer) clearInterval(stream.keepaliveTimer);
      stream.releaseLifecycle();
    };
    Object.assign(stream, {
      response: res,
      releaseLifecycle: this.options.lifecycle.trackStream(
        res,
        () => {
          if (!res.destroyed && !res.writableEnded) res.end();
        },
        null,
      ),
      keepaliveTimer:
        this.commandKeepaliveIntervalMs > 0
          ? setInterval(() => {
              this.writeRaw(res, `: keepalive ${this.now()}\n\n`);
            }, this.commandKeepaliveIntervalMs)
          : undefined,
    });
    stream.keepaliveTimer?.unref();
    this.commandStreams.set(key, stream);
    this.writeControl(res, {
      protocolVersion: BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION,
      helperGenerationId: this.options.helperGenerationId,
      ownerId: identity.ownerId,
      ownerGenerationId: identity.ownerGenerationId,
      kind: "hello",
      emittedAt: this.now(),
      payload: {
        publicationCursor: this.generationStates.get(key)?.cursor ?? 0,
        subscriberCount: this.subscriberCounts.get(key) ?? 0,
      },
    });
    const checkpointRequest = this.checkpointRequests.get(key);
    if (checkpointRequest) {
      this.writeControl(res, {
        protocolVersion: BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION,
        helperGenerationId: this.options.helperGenerationId,
        ownerId: identity.ownerId,
        ownerGenerationId: identity.ownerGenerationId,
        kind: "checkpoint.requested",
        emittedAt: this.now(),
        payload: checkpointRequest,
      });
    }
    req.once("aborted", remove);
    req.once("close", remove);
    res.once("close", remove);
    res.once("error", remove);

    this.pruneExpiredCommands(key);
    for (const command of this.pendingCommands.get(key)?.values() ?? []) {
      if (!this.writeEvent(res, "command", JSON.stringify(command))) break;
    }
  }

  private async handleDetail(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    requestUrl: URL,
  ): Promise<void> {
    try {
      const encodedHandle = requestUrl.searchParams.get("handle");
      if (!encodedHandle)
        throw new DataPlaneRouteError(400, "invalid_detail_handle");
      let handleValue: unknown;
      try {
        handleValue = JSON.parse(encodedHandle);
      } catch {
        throw new DataPlaneRouteError(400, "invalid_detail_handle");
      }
      const handle = parseBrowserGatewayDetailHandle(handleValue);
      this.assertCurrentIdentity(handle);
      if (handle.expiresAt <= this.now()) {
        throw new DataPlaneRouteError(409, "detail_expired");
      }
      let content: Buffer;
      try {
        content = await readBoundedBody(
          req,
          browserGatewayDetailResponseByteLimit(handle.kind),
        );
      } catch {
        throw new DataPlaneRouteError(413, "detail_body_limit_exceeded");
      }
      if (content.byteLength !== handle.byteLength) {
        throw new DataPlaneRouteError(400, "detail_size_mismatch");
      }
      if (!this.options.onDetail) {
        throw new DataPlaneRouteError(503, "detail_store_unavailable");
      }
      try {
        await this.options.onDetail(handle, content);
      } catch (error) {
        const message = String(error);
        if (message.includes("detail_expired")) {
          throw new DataPlaneRouteError(409, "detail_expired");
        }
        if (message.includes("detail_size_mismatch")) {
          throw new DataPlaneRouteError(413, "detail_size_mismatch");
        }
        throw error;
      }
      writeJson(res, 201, {
        ok: true,
        helperGenerationId: handle.helperGenerationId,
        ownerId: handle.ownerId,
        ownerGenerationId: handle.ownerGenerationId,
        handleId: handle.handleId,
      });
    } catch (error) {
      if (!req.readableEnded) req.resume();
      this.writeProtocolError(res, error);
    }
  }

  private async handleAcknowledgement(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    try {
      const acknowledgement = parseBrowserGatewayOwnerCommandAck(
        await readJsonBody(
          req,
          BROWSER_GATEWAY_DATA_PLANE_LIMITS.ownerCommandBytes,
        ),
      );
      this.assertCurrentIdentity(acknowledgement);
      const key = ownerKey(
        acknowledgement.ownerId,
        acknowledgement.ownerGenerationId,
      );
      const pending = this.pendingCommands.get(key);
      const command = pending?.get(acknowledgement.operation.operationId);
      if (command && command.command.kind !== acknowledgement.operation.kind) {
        writeJson(res, 409, { error: "operation_kind_mismatch" });
        return;
      }
      const accepted = await this.options.onAcknowledgement?.(acknowledgement);
      if (accepted === false) {
        writeJson(res, 409, { error: "operation_kind_mismatch" });
        return;
      }
      if (acknowledgement.operation.state !== "accepted") {
        pending?.delete(acknowledgement.operation.operationId);
        if (pending?.size === 0) this.pendingCommands.delete(key);
      }
      writeJson(res, 200, {
        ok: true,
        operation: acknowledgement.operation,
      });
    } catch (error) {
      this.writeProtocolError(res, error);
    }
  }

  private ingest(
    batch: BrowserGatewayOwnerPublicationBatch,
  ): Promise<BrowserGatewayOwnerPublicationAck> {
    const key = ownerKey(batch.ownerId, batch.ownerGenerationId);
    return this.serializeIngest(key, async () => {
      const current = this.generationStates.get(key);
      const cursor = current?.cursor ?? 0;

      if (current && batch.lastSequence <= cursor) {
        return this.publicationAck(batch, cursor, true);
      }
      if (current && batch.firstSequence <= cursor) {
        throw new DataPlaneRouteError(409, "sequence_overlap", {
          cursor,
          expectedSequence: cursor + 1,
        });
      }
      if (!current && !batch.checkpoint) {
        this.requestCheckpoint(key, batch, "checkpoint_required", 0);
        throw new DataPlaneRouteError(409, "checkpoint_required", {
          cursor: 0,
        });
      }
      if (!batch.checkpoint && batch.firstSequence !== cursor + 1) {
        this.requestCheckpoint(key, batch, "sequence_gap", cursor);
        throw new DataPlaneRouteError(409, "sequence_gap", {
          cursor,
          expectedSequence: cursor + 1,
        });
      }
      if (batch.checkpoint && batch.checkpoint.checkpointSequence < cursor) {
        throw new DataPlaneRouteError(409, "stale_checkpoint", { cursor });
      }

      const nextCursor = batch.lastSequence;
      const acknowledgement = this.publicationAck(batch, nextCursor, false);
      await this.options.onPublication?.(batch, acknowledgement);
      this.generationStates.set(key, {
        cursor: nextCursor,
        hasCheckpoint:
          current?.hasCheckpoint === true || batch.checkpoint !== null,
      });
      if (batch.checkpoint) this.checkpointRequests.delete(key);
      return acknowledgement;
    });
  }

  private serializeIngest<T>(
    key: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.ingestOperations.get(key) ?? Promise.resolve();
    const current = previous.then(operation, operation);
    const settled = current.then(
      () => undefined,
      () => undefined,
    );
    this.ingestOperations.set(key, settled);
    void settled.finally(() => {
      if (this.ingestOperations.get(key) === settled) {
        this.ingestOperations.delete(key);
      }
    });
    return current;
  }

  private requestCheckpoint(
    key: string,
    batch: BrowserGatewayOwnerPublicationBatch,
    reason: "sequence_gap" | "checkpoint_required",
    latestSequence: number,
  ): void {
    if (this.checkpointRequests.has(key)) return;
    this.publishControl({
      protocolVersion: BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION,
      helperGenerationId: this.options.helperGenerationId,
      ownerId: batch.ownerId,
      ownerGenerationId: batch.ownerGenerationId,
      kind: "checkpoint.requested",
      emittedAt: this.now(),
      payload: { reason, latestSequence },
    });
  }

  private publicationAck(
    batch: BrowserGatewayOwnerPublicationBatch,
    cursor: number,
    duplicate: boolean,
  ): BrowserGatewayOwnerPublicationAck {
    return {
      ok: true,
      helperGenerationId: this.options.helperGenerationId,
      ownerId: batch.ownerId,
      ownerGenerationId: batch.ownerGenerationId,
      batchId: batch.batchId,
      cursor,
      duplicate,
    };
  }

  private assertCurrentIdentity(identity: {
    helperGenerationId: string;
    ownerId: string;
    ownerGenerationId: string;
  }): void {
    if (identity.helperGenerationId !== this.options.helperGenerationId) {
      throw new DataPlaneRouteError(409, "helper_generation_mismatch");
    }
    const owner = this.options.ownerRegistry.get(identity.ownerId);
    if (!owner || owner.status !== "connected") {
      throw new DataPlaneRouteError(409, "owner_not_registered");
    }
    if (owner.ownerGenerationId !== identity.ownerGenerationId) {
      throw new DataPlaneRouteError(409, "owner_generation_mismatch");
    }
  }

  private writeCommandToStreams(
    key: string,
    command: BrowserGatewayOwnerCommand,
  ): void {
    const stream = this.commandStreams.get(key);
    if (stream) {
      this.writeEvent(stream.response, "command", JSON.stringify(command));
    }
  }

  private writeControl(
    response: http.ServerResponse,
    control: BrowserGatewayOwnerControl,
  ): boolean {
    return this.writeEvent(
      response,
      "control",
      JSON.stringify(parseBrowserGatewayOwnerControl(control)),
    );
  }

  private writeEvent(
    response: http.ServerResponse,
    event: string,
    serialized: string,
  ): boolean {
    const data = serialized
      .split(/\r\n|\r|\n/)
      .map((line) => `data: ${line}`)
      .join("\n");
    return this.writeRaw(response, `event: ${event}\n${data}\n\n`);
  }

  private writeRaw(response: http.ServerResponse, data: string): boolean {
    if (response.destroyed || response.writableEnded) return false;
    try {
      const writable = response.write(data);
      if (!writable && !response.writableEnded) response.end();
      return writable;
    } catch {
      if (!response.destroyed) response.destroy();
      return false;
    }
  }

  private pruneExpiredCommands(key: string): void {
    const pending = this.pendingCommands.get(key);
    if (!pending) return;
    const now = this.now();
    for (const [operationId, command] of pending) {
      if (command.deadlineAt <= now) pending.delete(operationId);
    }
    if (pending.size === 0) this.pendingCommands.delete(key);
  }

  private closeCommandStreams(key: string): void {
    const stream = this.commandStreams.get(key);
    if (!stream) return;
    this.commandStreams.delete(key);
    if (stream.keepaliveTimer) clearInterval(stream.keepaliveTimer);
    if (!stream.response.destroyed && !stream.response.writableEnded) {
      stream.response.end();
    }
    stream.releaseLifecycle();
  }

  private keysForOwner(ownerId: string): string[] {
    const prefix = `${ownerId}\u0000`;
    return [
      ...new Set([
        ...this.generationStates.keys(),
        ...this.commandStreams.keys(),
        ...this.pendingCommands.keys(),
      ]),
    ].filter((key) => key.startsWith(prefix));
  }

  private writeProtocolError(res: http.ServerResponse, error: unknown): void {
    if (error instanceof DataPlaneRouteError) {
      writeJson(res, error.status, { error: error.code, ...error.details });
      return;
    }
    if (error instanceof BrowserGatewayProtocolError) {
      writeJson(res, error.code === "resource_limit" ? 413 : 400, {
        error: error.code,
        path: error.path,
      });
      return;
    }
    const invalidJson = String(error) === "Error: invalid_json";
    writeJson(res, invalidJson ? 400 : 500, {
      error: invalidJson ? "invalid_json" : "internal_error",
    });
  }
}

class DataPlaneRouteError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(code);
  }
}

function ownerKey(ownerId: string, ownerGenerationId: string): string {
  return `${ownerId}\u0000${ownerGenerationId}`;
}

function splitOwnerKey(key: string): [string, string] {
  const separator = key.indexOf("\u0000");
  return [key.slice(0, separator), key.slice(separator + 1)];
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
