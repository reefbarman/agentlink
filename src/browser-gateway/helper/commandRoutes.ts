import type { BrowserGatewayCoreOwnerRegistry } from "../coreOwnerRegistry.js";
import { BROWSER_GATEWAY_DATA_PLANE_LIMITS } from "../dataPlane/limits.js";
import {
  BROWSER_GATEWAY_COMMAND_IDEMPOTENCY,
  BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION,
  BrowserGatewayProtocolError,
  parseBrowserGatewayOwnerCommand,
  type BrowserGatewayCommandDeadlineClass,
  type BrowserGatewayOperationState,
  type BrowserGatewayOwnerCommand,
  type BrowserGatewayOwnerCommandAck,
  type BrowserGatewayOwnerCommandBody,
} from "../dataPlane/protocol.js";

export interface BrowserGatewayCommandContext {
  readonly sessionKey: string;
  readonly browserConnectionId: string;
  readonly subscriptionId: string;
  readonly ownerId: string;
  readonly ownerGenerationId: string;
}

export interface BrowserGatewayCommandRoutesOptions {
  readonly helperGenerationId: string;
  readonly ownerRegistry: BrowserGatewayCoreOwnerRegistry;
  readonly publishCommand: (command: BrowserGatewayOwnerCommand) => boolean;
  readonly cancelCommand?: (command: BrowserGatewayOwnerCommand) => void;
  readonly emitOperation: (
    browserConnectionId: string,
    ownerId: string,
    ownerGenerationId: string,
    operation: BrowserGatewayOperationState,
  ) => void;
  readonly now?: () => number;
  readonly setTimeout?: typeof globalThis.setTimeout;
  readonly clearTimeout?: typeof globalThis.clearTimeout;
}

export interface BrowserGatewayCommandRouteResult {
  readonly status: number;
  readonly payload: unknown;
}

export type BrowserGatewayOperationLookupContext = Pick<
  BrowserGatewayCommandContext,
  "sessionKey" | "browserConnectionId" | "ownerId" | "ownerGenerationId"
>;

type BrowserCommandRequest = {
  browserConnectionId: string;
  csrfNonce: string;
  subscriptionId: string;
  operationId: string;
  deadlineClass: BrowserGatewayCommandDeadlineClass;
  command: BrowserGatewayOwnerCommandBody;
};

type RateBucket = {
  tokens: number;
  updatedAt: number;
};

type OperationRecord = {
  readonly key: string;
  readonly sessionKey: string;
  readonly ownerId: string;
  readonly ownerGenerationId: string;
  readonly fingerprint: string;
  readonly command: BrowserGatewayOwnerCommand;
  readonly browserConnectionIds: Set<string>;
  operation: BrowserGatewayOperationState;
  helperTerminal: boolean;
  updatedAt: number;
  deadlineTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
};

export class BrowserGatewayCommandRoutes {
  private readonly operations = new Map<string, OperationRecord>();
  private readonly connectionRateBuckets = new Map<string, RateBucket>();
  private readonly sessionRateBuckets = new Map<string, RateBucket>();
  private readonly now: () => number;
  private readonly setTimer: typeof globalThis.setTimeout;
  private readonly clearTimer: typeof globalThis.clearTimeout;
  private acceptingCommands = true;

  constructor(private readonly options: BrowserGatewayCommandRoutesOptions) {
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimeout ?? globalThis.setTimeout;
    this.clearTimer = options.clearTimeout ?? globalThis.clearTimeout;
  }

  handle(
    context: BrowserGatewayCommandContext,
    value: unknown,
  ): BrowserGatewayCommandRouteResult {
    if (!this.acceptingCommands) {
      return failure(503, "helper_draining");
    }

    const now = this.now();
    this.pruneOperations(now);
    let request: BrowserCommandRequest;
    try {
      request = parseBrowserCommandRequest(
        value,
        this.options.helperGenerationId,
        context.ownerId,
        context.ownerGenerationId,
        now,
      );
    } catch (error) {
      return protocolFailure(error);
    }

    if (!this.consumeCommandRate(context, now)) {
      return failure(429, "command_rate_limited");
    }
    const key = request.operationId;
    const fingerprint = JSON.stringify({
      ownerId: context.ownerId,
      ownerGenerationId: context.ownerGenerationId,
      deadlineClass: request.deadlineClass,
      command: request.command,
    });
    const existing = this.operations.get(key);
    if (existing) {
      if (
        existing.sessionKey !== context.sessionKey ||
        existing.fingerprint !== fingerprint
      ) {
        return failure(409, "operation_conflict");
      }
      existing.browserConnectionIds.add(context.browserConnectionId);
      this.emit(existing);
      return accepted(existing, true);
    }

    if (
      !hasCurrentDetailHandles(
        request.command,
        context,
        this.options.helperGenerationId,
        now,
      )
    ) {
      return failure(409, "detail_handle_unavailable");
    }

    const owner = this.options.ownerRegistry
      .refreshStatuses(now)
      .find((candidate) => candidate.owner.ownerId === context.ownerId);
    if (
      !owner ||
      owner.status !== "connected" ||
      owner.ownerGenerationId !== context.ownerGenerationId
    ) {
      return failure(409, "owner_generation_unavailable");
    }
    const capabilities = owner.capabilities.filter(
      (candidate) => candidate.capabilityId === request.command.kind,
    );
    const capability = capabilities[0];
    if (capabilities.length !== 1 || capability?.state !== "enabled") {
      return {
        status: 409,
        payload: {
          error: "capability_unavailable",
          capabilityId: request.command.kind,
          state: capability?.state ?? "unavailable",
          ...(capability?.reason ? { reason: capability.reason } : {}),
        },
      };
    }
    if (
      this.pendingCount() >=
      BROWSER_GATEWAY_DATA_PLANE_LIMITS.pendingCommandsPerHelper
    ) {
      return failure(429, "helper_pending_command_limit");
    }
    if (
      this.pendingCount(context.ownerId, context.ownerGenerationId) >=
      BROWSER_GATEWAY_DATA_PLANE_LIMITS.pendingCommandsPerOwner
    ) {
      return failure(429, "owner_pending_command_limit");
    }
    if (!this.makeOperationCapacity(now)) {
      return failure(429, "operation_dedupe_limit");
    }

    const duration =
      request.deadlineClass === "long"
        ? BROWSER_GATEWAY_DATA_PLANE_LIMITS.maximumLongCommandDeadlineMs
        : BROWSER_GATEWAY_DATA_PLANE_LIMITS.commandDeadlineMs;
    const command = parseBrowserGatewayOwnerCommand({
      protocolVersion: BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION,
      helperGenerationId: this.options.helperGenerationId,
      ownerId: context.ownerId,
      ownerGenerationId: context.ownerGenerationId,
      operationId: request.operationId,
      emittedAt: now,
      deadlineAt: now + duration,
      deadlineClass: request.deadlineClass,
      idempotency: BROWSER_GATEWAY_COMMAND_IDEMPOTENCY[request.command.kind],
      command: request.command,
    });
    const record: OperationRecord = {
      key,
      sessionKey: context.sessionKey,
      ownerId: context.ownerId,
      ownerGenerationId: context.ownerGenerationId,
      fingerprint,
      command,
      browserConnectionIds: new Set([context.browserConnectionId]),
      operation: {
        operationId: command.operationId,
        kind: command.command.kind,
        state: "accepted",
      },
      helperTerminal: false,
      updatedAt: now,
      deadlineTimer: undefined,
    };
    this.operations.set(key, record);
    try {
      if (!this.options.publishCommand(command)) {
        this.operations.delete(key);
        return failure(409, "command_deadline_expired");
      }
    } catch {
      this.operations.delete(key);
      return failure(409, "owner_generation_unavailable");
    }
    record.deadlineTimer = this.setTimer(
      () => this.expireOperation(key),
      Math.max(1, command.deadlineAt - this.now()),
    );
    record.deadlineTimer.unref?.();
    this.emit(record);
    return accepted(record, false);
  }

  lookupOperation(
    context: BrowserGatewayOperationLookupContext,
    operationId: string,
  ): BrowserGatewayCommandRouteResult {
    this.pruneOperations(this.now());
    const record = this.operations.get(operationId);
    if (
      !record ||
      record.sessionKey !== context.sessionKey ||
      record.ownerId !== context.ownerId ||
      record.ownerGenerationId !== context.ownerGenerationId
    ) {
      return failure(404, "operation_not_found");
    }
    record.browserConnectionIds.add(context.browserConnectionId);
    return {
      status: 200,
      payload: {
        ok: true,
        protocolVersion: BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION,
        helperGenerationId: this.options.helperGenerationId,
        ownerId: record.ownerId,
        ownerGenerationId: record.ownerGenerationId,
        operation: record.operation,
        idempotency: record.command.idempotency,
        deadlineAt: record.command.deadlineAt,
      },
    };
  }

  onAcknowledgement(acknowledgement: BrowserGatewayOwnerCommandAck): boolean {
    const matching = [...this.operations.values()].filter(
      (record) =>
        record.command.operationId === acknowledgement.operation.operationId &&
        record.ownerId === acknowledgement.ownerId &&
        record.ownerGenerationId === acknowledgement.ownerGenerationId,
    );
    if (matching.length === 0) return true;
    if (
      matching.some(
        (record) =>
          record.command.command.kind !== acknowledgement.operation.kind,
      )
    ) {
      return false;
    }
    for (const record of matching) {
      if (acknowledgement.operation.state === "accepted") {
        if (record.operation.state === "accepted") {
          this.updateOperation(record, acknowledgement.operation);
        }
      } else if (
        record.operation.state === "accepted" ||
        record.helperTerminal
      ) {
        record.helperTerminal = false;
        this.updateOperation(record, acknowledgement.operation);
      }
    }
    return true;
  }

  ownerRegistered(ownerId: string, ownerGenerationId: string): void {
    for (const record of this.operations.values()) {
      if (
        record.ownerId === ownerId &&
        record.ownerGenerationId !== ownerGenerationId &&
        record.operation.state === "accepted"
      ) {
        this.failPending(record, "owner_generation_changed");
      }
    }
  }

  closeBrowserConnection(browserConnectionId: string): void {
    this.connectionRateBuckets.delete(browserConnectionId);
    for (const record of this.operations.values()) {
      record.browserConnectionIds.delete(browserConnectionId);
    }
  }

  closeSession(sessionKey: string): void {
    this.sessionRateBuckets.delete(sessionKey);
  }

  beginDrain(): void {
    if (!this.acceptingCommands) return;
    this.acceptingCommands = false;
    for (const record of this.operations.values()) {
      if (record.operation.state === "accepted") {
        this.failPending(record, "helper_draining");
      }
    }
  }

  close(): void {
    this.acceptingCommands = false;
    for (const record of this.operations.values()) {
      if (record.deadlineTimer) this.clearTimer(record.deadlineTimer);
    }
    this.operations.clear();
    this.connectionRateBuckets.clear();
    this.sessionRateBuckets.clear();
  }

  private expireOperation(key: string): void {
    const record = this.operations.get(key);
    if (!record || record.operation.state !== "accepted") return;
    this.failPending(record, "command_deadline_exceeded");
  }

  private failPending(record: OperationRecord, message: string): void {
    try {
      this.options.cancelCommand?.(record.command);
    } catch {
      // Owner generation changes can race local terminal transitions.
    }
    record.helperTerminal = true;
    this.updateOperation(record, {
      operationId: record.command.operationId,
      kind: record.command.command.kind,
      state:
        record.command.idempotency === "idempotent" ? "failed" : "uncertain",
      message,
    });
  }

  private updateOperation(
    record: OperationRecord,
    operation: BrowserGatewayOperationState,
  ): void {
    if (sameOperation(record.operation, operation)) return;
    if (record.deadlineTimer && operation.state !== "accepted") {
      this.clearTimer(record.deadlineTimer);
      record.deadlineTimer = undefined;
    }
    record.operation = operation;
    record.updatedAt = this.now();
    this.operations.delete(record.key);
    this.operations.set(record.key, record);
    this.emit(record);
  }

  private emit(record: OperationRecord): void {
    for (const browserConnectionId of record.browserConnectionIds) {
      this.options.emitOperation(
        browserConnectionId,
        record.ownerId,
        record.ownerGenerationId,
        record.operation,
      );
    }
  }

  private consumeCommandRate(
    context: BrowserGatewayCommandContext,
    now: number,
  ): boolean {
    const connection = refillBucket(
      this.connectionRateBuckets.get(context.browserConnectionId),
      now,
    );
    const session = refillBucket(
      this.sessionRateBuckets.get(context.sessionKey),
      now,
    );
    this.connectionRateBuckets.set(context.browserConnectionId, connection);
    this.sessionRateBuckets.set(context.sessionKey, session);
    if (connection.tokens < 1 || session.tokens < 1) return false;
    connection.tokens -= 1;
    session.tokens -= 1;
    return true;
  }

  private pendingCount(ownerId?: string, ownerGenerationId?: string): number {
    let count = 0;
    for (const record of this.operations.values()) {
      if (
        record.operation.state === "accepted" &&
        (ownerId === undefined ||
          (record.ownerId === ownerId &&
            record.ownerGenerationId === ownerGenerationId))
      ) {
        count += 1;
      }
    }
    return count;
  }

  private pruneOperations(now: number): void {
    for (const [key, record] of this.operations) {
      if (
        record.operation.state !== "accepted" &&
        now - record.updatedAt >=
          BROWSER_GATEWAY_DATA_PLANE_LIMITS.operationDedupeAgeMs
      ) {
        this.operations.delete(key);
      }
    }
  }

  private makeOperationCapacity(now: number): boolean {
    this.pruneOperations(now);
    while (
      this.operations.size >=
      BROWSER_GATEWAY_DATA_PLANE_LIMITS.operationDedupeRecords
    ) {
      const terminal = [...this.operations.entries()].find(
        ([, record]) => record.operation.state !== "accepted",
      );
      if (!terminal) return false;
      this.operations.delete(terminal[0]);
    }
    return true;
  }
}

function parseBrowserCommandRequest(
  value: unknown,
  helperGenerationId: string,
  ownerId: string,
  ownerGenerationId: string,
  now: number,
): BrowserCommandRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BrowserGatewayProtocolError(
      "invalid_type",
      "$",
      "expected object",
    );
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set([
    "browserConnectionId",
    "csrfNonce",
    "subscriptionId",
    "operationId",
    "deadlineClass",
    "command",
  ]);
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    throw new BrowserGatewayProtocolError(
      "unknown_field",
      "$",
      "unknown field",
    );
  }
  for (const key of [
    "browserConnectionId",
    "csrfNonce",
    "subscriptionId",
    "operationId",
  ] as const) {
    if (
      typeof record[key] !== "string" ||
      !record[key].trim() ||
      Buffer.byteLength(record[key]) > 256
    ) {
      throw new BrowserGatewayProtocolError(
        "invalid_value",
        `$.${key}`,
        "invalid string",
      );
    }
  }
  if (record.deadlineClass !== "default" && record.deadlineClass !== "long") {
    throw new BrowserGatewayProtocolError(
      "invalid_value",
      "$.deadlineClass",
      "unsupported deadline class",
    );
  }
  const duration =
    record.deadlineClass === "long"
      ? BROWSER_GATEWAY_DATA_PLANE_LIMITS.maximumLongCommandDeadlineMs
      : BROWSER_GATEWAY_DATA_PLANE_LIMITS.commandDeadlineMs;
  const parsed = parseBrowserGatewayOwnerCommand({
    protocolVersion: BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION,
    helperGenerationId,
    ownerId,
    ownerGenerationId,
    operationId: (record.operationId as string).trim(),
    emittedAt: now,
    deadlineAt: now + duration,
    deadlineClass: record.deadlineClass,
    idempotency:
      commandKind(record.command) === undefined
        ? "idempotent"
        : BROWSER_GATEWAY_COMMAND_IDEMPOTENCY[commandKind(record.command)!],
    command: record.command,
  });
  return {
    browserConnectionId: (record.browserConnectionId as string).trim(),
    csrfNonce: (record.csrfNonce as string).trim(),
    subscriptionId: (record.subscriptionId as string).trim(),
    operationId: parsed.operationId,
    deadlineClass: parsed.deadlineClass,
    command: parsed.command,
  };
}

function hasCurrentDetailHandles(
  command: BrowserGatewayOwnerCommandBody,
  context: Pick<BrowserGatewayCommandContext, "ownerId" | "ownerGenerationId">,
  helperGenerationId: string,
  now: number,
): boolean {
  const handles =
    command.kind === "session.send"
      ? command.detailHandles
      : command.kind === "question.respond"
        ? [command.responseHandle]
        : [];
  return handles.every(
    (handle) =>
      handle.helperGenerationId === helperGenerationId &&
      handle.ownerId === context.ownerId &&
      handle.ownerGenerationId === context.ownerGenerationId &&
      handle.expiresAt > now,
  );
}

function commandKind(
  value: unknown,
): keyof typeof BROWSER_GATEWAY_COMMAND_IDEMPOTENCY | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const kind = (value as Record<string, unknown>).kind;
  return typeof kind === "string" && kind in BROWSER_GATEWAY_COMMAND_IDEMPOTENCY
    ? (kind as keyof typeof BROWSER_GATEWAY_COMMAND_IDEMPOTENCY)
    : undefined;
}

function refillBucket(
  current: RateBucket | undefined,
  now: number,
): RateBucket {
  const bucket = current ?? {
    tokens: BROWSER_GATEWAY_DATA_PLANE_LIMITS.browserCommandBurst,
    updatedAt: now,
  };
  const elapsed = Math.max(0, now - bucket.updatedAt);
  bucket.tokens = Math.min(
    BROWSER_GATEWAY_DATA_PLANE_LIMITS.browserCommandBurst,
    bucket.tokens +
      (elapsed / 1_000) *
        BROWSER_GATEWAY_DATA_PLANE_LIMITS.browserCommandsPerSecond,
  );
  bucket.updatedAt = now;
  return bucket;
}

function sameOperation(
  first: BrowserGatewayOperationState,
  second: BrowserGatewayOperationState,
): boolean {
  return JSON.stringify(first) === JSON.stringify(second);
}

function accepted(
  record: OperationRecord,
  duplicate: boolean,
): BrowserGatewayCommandRouteResult {
  return {
    status: 202,
    payload: {
      ok: true,
      protocolVersion: BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION,
      operation: record.operation,
      ownerId: record.ownerId,
      ownerGenerationId: record.ownerGenerationId,
      deadlineAt: record.command.deadlineAt,
      duplicate,
    },
  };
}

function failure(
  status: number,
  error: string,
): BrowserGatewayCommandRouteResult {
  return { status, payload: { error } };
}

function protocolFailure(error: unknown): BrowserGatewayCommandRouteResult {
  if (error instanceof BrowserGatewayProtocolError) {
    return {
      status: error.code === "resource_limit" ? 413 : 400,
      payload: { error: error.code, path: error.path },
    };
  }
  return failure(400, "invalid_request");
}
