import type {
  AgentInteractionRequest,
  AgentResolvedModelSelection,
  PreparedAgentTurnRequest,
} from "./turnContracts.js";
import type {
  CoreModelMessage,
  CoreModelStopReason,
  CoreModelUsage,
} from "./modelRuntime.js";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import type { AgentPrincipal } from "./modelIdentity.js";
import type { AgentToolLoopCall } from "./agentToolLoop.js";
import type { HostToolEffect } from "./hostTools.js";
import type { TurnExecutionSnapshot } from "./turnExecution.js";
import type { TurnFencingToken } from "./turnLeases.js";

export type ToolAuthorizationDecision = "allow" | "deny";

export interface AuthorizeToolCallRequest<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
> {
  readonly principal: TPrincipal;
  readonly sessionId: string;
  readonly turnId: string;
  readonly model: AgentResolvedModelSelection;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly displayInput?: unknown;
  readonly effect: HostToolEffect | "unknown";
}

export type AuthorizeToolCallResult =
  | { readonly decision: "allow" }
  | { readonly decision: "deny"; readonly reason?: string }
  | {
      readonly decision: "require_user";
      /** Explicitly host-safe text projected into the interaction event. */
      readonly summary: string;
      /** Optional explicitly host-safe structured detail for the host UI. */
      readonly displayContent?: unknown;
    };

export type AuthorizeToolCall<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
> = (
  request: AuthorizeToolCallRequest<TPrincipal>,
) => AuthorizeToolCallResult | Promise<AuthorizeToolCallResult>;

export interface DurableToolInteractionContinuation<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
> {
  readonly prepared: PreparedAgentTurnRequest<TPrincipal>;
  /** Exact private model/tool sequence through the assistant tool turn. */
  readonly iterationMessages: readonly CoreModelMessage[];
  /** Current and subsequent calls from that exact assistant turn. */
  readonly pendingToolCalls: readonly AgentToolLoopCall[];
  /** Calls already reserved in the persisted execution snapshot. */
  readonly reservedToolCalls: readonly AgentToolLoopCall[];
  /** Calls already authorized before the suspension boundary. */
  readonly authorizedToolCallIds: readonly string[];
  readonly model: AgentResolvedModelSelection;
  readonly execution: TurnExecutionSnapshot;
  readonly usage?: CoreModelUsage;
  readonly stopReason?: CoreModelStopReason;
  /** Next event sequence after interaction.required and turn.suspended. */
  readonly nextSequence: number;
}

export interface DurableToolInteractionRecord<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
> {
  readonly schemaVersion: 1;
  readonly interactionId: string;
  readonly state: "pending";
  readonly principal: TPrincipal;
  readonly sessionId: string;
  readonly turnId: string;
  readonly expectedSessionRevision: string;
  readonly createdAt: number;
  readonly request: AgentInteractionRequest;
  readonly continuation: DurableToolInteractionContinuation<TPrincipal>;
}

export type CreateDurableToolInteractionResult =
  | {
      readonly ok: true;
      readonly interactionRevision: string;
      readonly sessionRevision: string;
    }
  | {
      readonly ok: false;
      readonly reason:
        | "session_revision_conflict"
        | "already_exists"
        | "stale_fence";
      readonly currentSessionRevision?: string;
      readonly currentFencingToken?: TurnFencingToken;
    };

export type ReadDurableToolInteractionResult<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
> =
  | {
      readonly ok: true;
      readonly record: DurableToolInteractionRecord<TPrincipal>;
      readonly interactionRevision: string;
      readonly sessionRevision: string;
    }
  | { readonly ok: false; readonly reason: "not_found" | "consumed" };

export type ConsumeDurableToolInteractionResult =
  | {
      readonly ok: true;
      readonly sessionRevision: string;
    }
  | {
      readonly ok: false;
      readonly reason:
        | "not_found"
        | "consumed"
        | "interaction_revision_conflict"
        | "session_revision_conflict"
        | "stale_fence";
      readonly currentInteractionRevision?: string;
      readonly currentSessionRevision?: string;
      readonly currentFencingToken?: TurnFencingToken;
    };

/**
 * Host-owned durable storage. Implementations must atomically compare revisions
 * on create/consume; the core never falls back to process-local interaction state.
 */
export interface DurableToolInteractionRepository<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
> {
  createInteraction(request: {
    readonly record: DurableToolInteractionRecord<TPrincipal>;
    readonly expectedSessionRevision: string;
    readonly fencingToken?: TurnFencingToken;
  }): Promise<CreateDurableToolInteractionResult>;
  readInteraction(request: {
    readonly principal: TPrincipal;
    readonly sessionId: string;
    readonly interactionId: string;
  }): Promise<ReadDurableToolInteractionResult<TPrincipal>>;
  /**
   * Atomically consume once. After success, durable adapters retain only the
   * metadata needed to reject replay and discard the private continuation.
   */
  consumeInteraction(request: {
    readonly principal: TPrincipal;
    readonly sessionId: string;
    readonly interactionId: string;
    readonly expectedInteractionRevision: string;
    readonly expectedSessionRevision: string;
    readonly fencingToken?: TurnFencingToken;
    readonly responseId: string;
    readonly decision: ToolAuthorizationDecision;
    readonly consumedAt: number;
  }): Promise<ConsumeDurableToolInteractionResult>;
}

export interface ResumeToolInteractionRequest<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
> {
  readonly principal: TPrincipal;
  readonly sessionId: string;
  readonly turnId: string;
  readonly interactionId: string;
  readonly interactionRevision: string;
  readonly expectedSessionRevision: string;
  readonly fencingToken?: TurnFencingToken;
  readonly decision: ToolAuthorizationDecision;
  readonly responseToken: string;
}

export class TurnInteractionResumeError extends Error {
  readonly retryable = false;

  constructor(
    readonly code:
      | "interaction_not_found"
      | "interaction_consumed"
      | "interaction_scope_mismatch"
      | "interaction_revision_conflict"
      | "session_revision_conflict"
      | "turn_lease_lost",
    message: string,
  ) {
    super(message);
    this.name = "TurnInteractionResumeError";
  }
}

export interface TurnInteractionResponseTokenClaims {
  readonly schemaVersion: 1;
  readonly responseId: string;
  readonly interactionId: string;
  readonly interactionRevision: string;
  readonly tenantId: string;
  readonly subjectId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly expectedSessionRevision: string;
  readonly fencingToken?: TurnFencingToken;
  readonly decision: ToolAuthorizationDecision;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export interface IssueTurnInteractionResponseTokenRequest<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
> {
  readonly interactionId: string;
  readonly interactionRevision: string;
  readonly principal: TPrincipal;
  readonly sessionId: string;
  readonly turnId: string;
  readonly expectedSessionRevision: string;
  readonly fencingToken?: TurnFencingToken;
  readonly decision: ToolAuthorizationDecision;
}

export interface VerifyTurnInteractionResponseTokenRequest {
  readonly token: string;
  readonly interactionId: string;
  readonly interactionRevision: string;
  readonly principal: AgentPrincipal;
  readonly sessionId: string;
  readonly turnId: string;
  readonly expectedSessionRevision: string;
  readonly fencingToken?: TurnFencingToken;
  readonly decision: ToolAuthorizationDecision;
}

export interface TurnInteractionTokenService {
  issue(request: IssueTurnInteractionResponseTokenRequest): string;
  verify(
    request: VerifyTurnInteractionResponseTokenRequest,
  ): TurnInteractionResponseTokenClaims;
}

export class TurnInteractionTokenError extends Error {
  readonly retryable = false;

  constructor(
    readonly code:
      | "interaction_token_invalid"
      | "interaction_token_expired"
      | "interaction_token_scope_mismatch",
    message: string,
  ) {
    super(message);
    this.name = "TurnInteractionTokenError";
  }
}

const DEFAULT_TOKEN_TTL_MS = 10 * 60_000;
const MIN_SECRET_BYTES = 32;

/** Create HMAC-SHA256 response tokens bound to one principal/session/revision. */
export function createTurnInteractionTokenService(options: {
  readonly secret: string | Uint8Array;
  readonly ttlMs?: number;
  readonly now?: () => number;
  readonly createResponseId?: () => string;
}): TurnInteractionTokenService {
  const secret = normalizeSecret(options.secret);
  const ttlMs = options.ttlMs ?? DEFAULT_TOKEN_TTL_MS;
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    throw new Error("Turn interaction token ttlMs must be a positive integer");
  }
  const now = options.now ?? Date.now;
  const createResponseId = options.createResponseId ?? randomUUID;

  return Object.freeze({
    issue(request: IssueTurnInteractionResponseTokenRequest): string {
      validateTokenScope(request);
      const issuedAt = readClock(now);
      const claims: TurnInteractionResponseTokenClaims = {
        schemaVersion: 1,
        responseId: requiredText(createResponseId(), "responseId"),
        interactionId: request.interactionId,
        interactionRevision: request.interactionRevision,
        tenantId: request.principal.tenantId,
        subjectId: request.principal.subjectId,
        sessionId: request.sessionId,
        turnId: request.turnId,
        expectedSessionRevision: request.expectedSessionRevision,
        ...(request.fencingToken ? { fencingToken: request.fencingToken } : {}),
        decision: request.decision,
        issuedAt,
        expiresAt: issuedAt + ttlMs,
      };
      const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
      return `${payload}.${sign(payload, secret)}`;
    },
    verify(
      request: VerifyTurnInteractionResponseTokenRequest,
    ): TurnInteractionResponseTokenClaims {
      validateTokenScope(request);
      const segments = request.token.split(".");
      if (segments.length !== 2 || !segments[0] || !segments[1]) {
        throw invalidToken();
      }
      const [payload, signature] = segments;
      const expectedSignature = sign(payload, secret);
      const actualBytes = Buffer.from(signature, "base64url");
      const expectedBytes = Buffer.from(expectedSignature, "base64url");
      if (
        actualBytes.length !== expectedBytes.length ||
        !timingSafeEqual(actualBytes, expectedBytes)
      ) {
        throw invalidToken();
      }
      const claims = parseClaims(payload);
      if (claims.expiresAt <= readClock(now)) {
        throw new TurnInteractionTokenError(
          "interaction_token_expired",
          "Interaction response token has expired",
        );
      }
      if (
        claims.interactionId !== request.interactionId ||
        claims.interactionRevision !== request.interactionRevision ||
        claims.tenantId !== request.principal.tenantId ||
        claims.subjectId !== request.principal.subjectId ||
        claims.sessionId !== request.sessionId ||
        claims.turnId !== request.turnId ||
        claims.expectedSessionRevision !== request.expectedSessionRevision ||
        claims.fencingToken !== request.fencingToken ||
        claims.decision !== request.decision
      ) {
        throw new TurnInteractionTokenError(
          "interaction_token_scope_mismatch",
          "Interaction response token does not match this principal, session, revision, or decision",
        );
      }
      return claims;
    },
  });
}

function parseClaims(payload: string): TurnInteractionResponseTokenClaims {
  try {
    const value = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    );
    if (!isClaims(value)) throw invalidToken();
    return value;
  } catch (error) {
    if (error instanceof TurnInteractionTokenError) throw error;
    throw invalidToken();
  }
}

function isClaims(value: unknown): value is TurnInteractionResponseTokenClaims {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const claims = value as Partial<TurnInteractionResponseTokenClaims>;
  return (
    claims.schemaVersion === 1 &&
    nonEmpty(claims.responseId) &&
    nonEmpty(claims.interactionId) &&
    nonEmpty(claims.interactionRevision) &&
    nonEmpty(claims.tenantId) &&
    nonEmpty(claims.subjectId) &&
    nonEmpty(claims.sessionId) &&
    nonEmpty(claims.turnId) &&
    nonEmpty(claims.expectedSessionRevision) &&
    (claims.fencingToken === undefined ||
      validFencingToken(claims.fencingToken)) &&
    (claims.decision === "allow" || claims.decision === "deny") &&
    Number.isSafeInteger(claims.issuedAt) &&
    Number.isSafeInteger(claims.expiresAt) &&
    (claims.expiresAt ?? 0) > (claims.issuedAt ?? 0)
  );
}

function validateTokenScope(request: {
  readonly interactionId: string;
  readonly interactionRevision: string;
  readonly principal: AgentPrincipal;
  readonly sessionId: string;
  readonly turnId: string;
  readonly expectedSessionRevision: string;
  readonly fencingToken?: TurnFencingToken;
  readonly decision: ToolAuthorizationDecision;
}): void {
  requiredText(request.interactionId, "interactionId");
  requiredText(request.interactionRevision, "interactionRevision");
  requiredText(request.principal.tenantId, "principal.tenantId");
  requiredText(request.principal.subjectId, "principal.subjectId");
  requiredText(request.sessionId, "sessionId");
  requiredText(request.turnId, "turnId");
  requiredText(request.expectedSessionRevision, "expectedSessionRevision");
  if (
    request.fencingToken !== undefined &&
    !validFencingToken(request.fencingToken)
  ) {
    throw new Error(
      "Turn interaction fencingToken must be a positive decimal integer",
    );
  }
  if (request.decision !== "allow" && request.decision !== "deny") {
    throw new Error("Turn interaction decision must be allow or deny");
  }
}

function validFencingToken(value: unknown): value is TurnFencingToken {
  return typeof value === "string" && /^[1-9][0-9]*$/.test(value);
}

function normalizeSecret(value: string | Uint8Array): Buffer {
  const secret =
    typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value);
  if (secret.byteLength < MIN_SECRET_BYTES) {
    throw new Error(
      `Turn interaction token secret must contain at least ${MIN_SECRET_BYTES} bytes`,
    );
  }
  return secret;
}

function sign(payload: string, secret: Buffer): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function requiredText(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`Turn interaction ${field} must not be empty`);
  return trimmed;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function readClock(now: () => number): number {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(
      "Turn interaction clock must return a non-negative integer",
    );
  }
  return value;
}

function invalidToken(): TurnInteractionTokenError {
  return new TurnInteractionTokenError(
    "interaction_token_invalid",
    "Interaction response token is invalid",
  );
}
