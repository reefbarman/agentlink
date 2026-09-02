import type { AgentPrincipal, AgentModelReference } from "./modelIdentity.js";
import type { CoreModelMessage, CoreModelUsage } from "./modelRuntime.js";
import type {
  ConsumeDurableToolInteractionResult,
  CreateDurableToolInteractionResult,
  DurableToolInteractionRecord,
  DurableToolInteractionRepository,
  ReadDurableToolInteractionResult,
  ToolAuthorizationDecision,
} from "./turnInteractions.js";
import {
  compareTurnFencingTokens,
  type TurnFencingToken,
} from "./turnLeases.js";

export type AgentSessionRevision = string;

export type AgentSessionRunState =
  | { readonly phase: "idle" }
  | {
      readonly phase: "running";
      readonly turnId: string;
      readonly startedAt: number;
    }
  | {
      readonly phase: "suspended";
      readonly turnId: string;
      readonly interactionId: string;
      readonly suspendedAt: number;
    }
  | {
      readonly phase: "resuming";
      readonly turnId: string;
      readonly interactionId: string;
      readonly responseId: string;
      readonly decision: ToolAuthorizationDecision;
      readonly resumedAt: number;
    }
  | {
      readonly phase: "interrupted";
      readonly turnId: string;
      readonly interruptedAt: number;
      readonly reason: string;
    };

/** Compact SDK-owned session state; extension coding-agent metadata stays out. */
export interface AgentSessionRecord<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
> {
  readonly schemaVersion: 1;
  readonly principal: TPrincipal;
  readonly sessionId: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly messages: readonly CoreModelMessage[];
  readonly selectedModel?: AgentModelReference;
  readonly usage?: CoreModelUsage;
  readonly runState: AgentSessionRunState;
  readonly pendingInteractionId?: string;
  readonly lastTurnId?: string;
}

export interface AgentSessionSummary<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
> {
  readonly principal: TPrincipal;
  readonly sessionId: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly selectedModel?: AgentModelReference;
  readonly runState: AgentSessionRunState;
  readonly pendingInteractionId?: string;
  readonly revision: AgentSessionRevision;
}

export type CreateAgentSessionResult =
  | { readonly ok: true; readonly revision: AgentSessionRevision }
  | { readonly ok: false; readonly reason: "already_exists" };

export type ReadAgentSessionResult<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
> =
  | {
      readonly ok: true;
      readonly record: AgentSessionRecord<TPrincipal>;
      readonly revision: AgentSessionRevision;
      readonly fencingToken?: TurnFencingToken;
    }
  | { readonly ok: false; readonly reason: "not_found" };

export type SaveAgentSessionResult =
  | { readonly ok: true; readonly revision: AgentSessionRevision }
  | {
      readonly ok: false;
      readonly reason: "not_found" | "revision_conflict" | "stale_fence";
      readonly currentRevision?: AgentSessionRevision;
      readonly currentFencingToken?: TurnFencingToken;
    };

export type DeleteAgentSessionResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: "not_found" | "revision_conflict" | "stale_fence";
      readonly currentRevision?: AgentSessionRevision;
      readonly currentFencingToken?: TurnFencingToken;
    };

/** Optimistic-concurrency repository; distributed adapters must enforce fencing atomically. */
export interface AgentSessionRepository<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
> {
  createSession(request: {
    readonly record: AgentSessionRecord<TPrincipal>;
  }): Promise<CreateAgentSessionResult>;
  readSession(request: {
    readonly principal: TPrincipal;
    readonly sessionId: string;
  }): Promise<ReadAgentSessionResult<TPrincipal>>;
  listSessions(request: {
    readonly principal: TPrincipal;
  }): Promise<readonly AgentSessionSummary<TPrincipal>[]>;
  saveSession(request: {
    readonly record: AgentSessionRecord<TPrincipal>;
    readonly expectedRevision: AgentSessionRevision;
    readonly fencingToken?: TurnFencingToken;
  }): Promise<SaveAgentSessionResult>;
  deleteSession(request: {
    readonly principal: TPrincipal;
    readonly sessionId: string;
    readonly expectedRevision: AgentSessionRevision;
    readonly fencingToken?: TurnFencingToken;
  }): Promise<DeleteAgentSessionResult>;
}

interface StoredSession<TPrincipal extends AgentPrincipal> {
  record: AgentSessionRecord<TPrincipal>;
  revisionNumber: number;
  fencingToken?: TurnFencingToken;
}

interface StoredInteraction<TPrincipal extends AgentPrincipal> {
  record: DurableToolInteractionRecord<TPrincipal>;
  revisionNumber: number;
  consumed: boolean;
  responseIds: Set<string>;
}

/**
 * Shared deterministic test adapter for E6 contract tests. It is process-local,
 * but models the atomic session+interaction transitions required of real stores.
 */
export class InMemoryAgentStateRepository<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
>
  implements
    AgentSessionRepository<TPrincipal>,
    DurableToolInteractionRepository<TPrincipal>
{
  private readonly sessions = new Map<string, StoredSession<TPrincipal>>();
  private readonly interactions = new Map<
    string,
    StoredInteraction<TPrincipal>
  >();

  async createSession(request: {
    readonly record: AgentSessionRecord<TPrincipal>;
  }): Promise<CreateAgentSessionResult> {
    validateSessionRecord(request.record);
    const key = sessionKey(request.record.principal, request.record.sessionId);
    if (this.sessions.has(key)) return { ok: false, reason: "already_exists" };
    this.sessions.set(key, {
      record: structuredClone(request.record),
      revisionNumber: 1,
    });
    return { ok: true, revision: revision(1) };
  }

  async readSession(request: {
    readonly principal: TPrincipal;
    readonly sessionId: string;
  }): Promise<ReadAgentSessionResult<TPrincipal>> {
    validateScope(request.principal, request.sessionId);
    const stored = this.sessions.get(
      sessionKey(request.principal, request.sessionId),
    );
    if (!stored) return { ok: false, reason: "not_found" };
    return {
      ok: true,
      record: structuredClone(stored.record),
      revision: revision(stored.revisionNumber),
      ...(stored.fencingToken ? { fencingToken: stored.fencingToken } : {}),
    };
  }

  async listSessions(request: {
    readonly principal: TPrincipal;
  }): Promise<readonly AgentSessionSummary<TPrincipal>[]> {
    validatePrincipal(request.principal);
    return [...this.sessions.values()]
      .filter((stored) =>
        samePrincipal(stored.record.principal, request.principal),
      )
      .map((stored) => ({
        principal: structuredClone(stored.record.principal),
        sessionId: stored.record.sessionId,
        createdAt: stored.record.createdAt,
        updatedAt: stored.record.updatedAt,
        ...(stored.record.selectedModel
          ? { selectedModel: structuredClone(stored.record.selectedModel) }
          : {}),
        runState: structuredClone(stored.record.runState),
        ...(stored.record.pendingInteractionId
          ? { pendingInteractionId: stored.record.pendingInteractionId }
          : {}),
        revision: revision(stored.revisionNumber),
      }))
      .sort(
        (first, second) =>
          second.updatedAt - first.updatedAt ||
          first.sessionId.localeCompare(second.sessionId),
      );
  }

  async saveSession(request: {
    readonly record: AgentSessionRecord<TPrincipal>;
    readonly expectedRevision: AgentSessionRevision;
    readonly fencingToken?: TurnFencingToken;
  }): Promise<SaveAgentSessionResult> {
    validateSessionRecord(request.record);
    validateOptionalFence(request.fencingToken);
    const key = sessionKey(request.record.principal, request.record.sessionId);
    const stored = this.sessions.get(key);
    if (!stored) return { ok: false, reason: "not_found" };
    const conflict = mutationConflict(stored, request);
    if (conflict) return conflict;

    stored.revisionNumber += 1;
    stored.record = structuredClone(request.record);
    if (request.fencingToken) stored.fencingToken = request.fencingToken;
    return { ok: true, revision: revision(stored.revisionNumber) };
  }

  async deleteSession(request: {
    readonly principal: TPrincipal;
    readonly sessionId: string;
    readonly expectedRevision: AgentSessionRevision;
    readonly fencingToken?: TurnFencingToken;
  }): Promise<DeleteAgentSessionResult> {
    validateScope(request.principal, request.sessionId);
    validateOptionalFence(request.fencingToken);
    const key = sessionKey(request.principal, request.sessionId);
    const stored = this.sessions.get(key);
    if (!stored) return { ok: false, reason: "not_found" };
    const conflict = mutationConflict(stored, request);
    if (conflict) return conflict;

    this.sessions.delete(key);
    for (const [interactionKey, interaction] of this.interactions) {
      if (
        samePrincipal(interaction.record.principal, request.principal) &&
        interaction.record.sessionId === request.sessionId
      ) {
        this.interactions.delete(interactionKey);
      }
    }
    return { ok: true };
  }

  async createInteraction(request: {
    readonly record: DurableToolInteractionRecord<TPrincipal>;
    readonly expectedSessionRevision: string;
    readonly fencingToken?: TurnFencingToken;
  }): Promise<CreateDurableToolInteractionResult> {
    validateInteractionRecord(request.record);
    if (
      request.record.expectedSessionRevision !== request.expectedSessionRevision
    ) {
      throw new Error(
        "Interaction record revision does not match its create precondition",
      );
    }
    if (
      request.record.continuation.prepared.turnFencingToken !==
      request.fencingToken
    ) {
      throw new Error(
        "Interaction continuation fence does not match its create precondition",
      );
    }
    const session = this.sessions.get(
      sessionKey(request.record.principal, request.record.sessionId),
    );
    if (!session) {
      return {
        ok: false,
        reason: "session_revision_conflict",
        currentSessionRevision: undefined,
      };
    }
    if (revision(session.revisionNumber) !== request.expectedSessionRevision) {
      return {
        ok: false,
        reason: "session_revision_conflict",
        currentSessionRevision: revision(session.revisionNumber),
      };
    }
    if (
      session.record.pendingInteractionId &&
      session.record.pendingInteractionId !== request.record.interactionId
    ) {
      return { ok: false, reason: "already_exists" };
    }
    const key = interactionKey(
      request.record.principal,
      request.record.sessionId,
      request.record.interactionId,
    );
    if (this.interactions.has(key)) {
      return { ok: false, reason: "already_exists" };
    }
    const fenceConflict = interactionFenceConflict(
      session,
      request.fencingToken,
    );
    if (fenceConflict) return fenceConflict;

    this.interactions.set(key, {
      record: structuredClone(request.record),
      revisionNumber: 1,
      consumed: false,
      responseIds: new Set(),
    });
    session.revisionNumber += 1;
    session.record = {
      ...session.record,
      updatedAt: Math.max(session.record.updatedAt, request.record.createdAt),
      lastTurnId: request.record.turnId,
      pendingInteractionId: request.record.interactionId,
      runState: {
        phase: "suspended",
        turnId: request.record.turnId,
        interactionId: request.record.interactionId,
        suspendedAt: request.record.createdAt,
      },
    };
    return {
      ok: true,
      interactionRevision: revision(1),
      sessionRevision: revision(session.revisionNumber),
    };
  }

  async readInteraction(request: {
    readonly principal: TPrincipal;
    readonly sessionId: string;
    readonly interactionId: string;
  }): Promise<ReadDurableToolInteractionResult<TPrincipal>> {
    validateInteractionScope(request);
    const stored = this.interactions.get(
      interactionKey(
        request.principal,
        request.sessionId,
        request.interactionId,
      ),
    );
    if (!stored) return { ok: false, reason: "not_found" };
    if (stored.consumed) return { ok: false, reason: "consumed" };
    const session = this.sessions.get(
      sessionKey(request.principal, request.sessionId),
    );
    if (!session) return { ok: false, reason: "not_found" };
    return {
      ok: true,
      record: structuredClone(stored.record),
      interactionRevision: revision(stored.revisionNumber),
      sessionRevision: revision(session.revisionNumber),
    };
  }

  async consumeInteraction(request: {
    readonly principal: TPrincipal;
    readonly sessionId: string;
    readonly interactionId: string;
    readonly expectedInteractionRevision: string;
    readonly expectedSessionRevision: string;
    readonly fencingToken?: TurnFencingToken;
    readonly responseId: string;
    readonly decision: ToolAuthorizationDecision;
    readonly consumedAt: number;
  }): Promise<ConsumeDurableToolInteractionResult> {
    validateInteractionScope(request);
    requiredText(request.responseId, "responseId");
    validateDecision(request.decision);
    nonNegativeInteger(request.consumedAt, "Interaction consumedAt");
    const key = interactionKey(
      request.principal,
      request.sessionId,
      request.interactionId,
    );
    const stored = this.interactions.get(key);
    if (!stored) return { ok: false, reason: "not_found" };
    if (stored.consumed || stored.responseIds.has(request.responseId)) {
      return { ok: false, reason: "consumed" };
    }
    if (
      revision(stored.revisionNumber) !== request.expectedInteractionRevision
    ) {
      return {
        ok: false,
        reason: "interaction_revision_conflict",
        currentInteractionRevision: revision(stored.revisionNumber),
      };
    }
    const session = this.sessions.get(
      sessionKey(request.principal, request.sessionId),
    );
    if (!session) return { ok: false, reason: "not_found" };
    if (revision(session.revisionNumber) !== request.expectedSessionRevision) {
      return {
        ok: false,
        reason: "session_revision_conflict",
        currentSessionRevision: revision(session.revisionNumber),
      };
    }
    const fenceConflict = interactionFenceConflict(
      session,
      request.fencingToken,
    );
    if (fenceConflict) return fenceConflict;

    stored.consumed = true;
    stored.responseIds.add(request.responseId);
    stored.revisionNumber += 1;
    session.revisionNumber += 1;
    session.record = {
      ...session.record,
      updatedAt: Math.max(session.record.updatedAt, request.consumedAt),
      pendingInteractionId: undefined,
      lastTurnId: stored.record.turnId,
      runState: {
        phase: "resuming",
        turnId: stored.record.turnId,
        interactionId: stored.record.interactionId,
        responseId: request.responseId,
        decision: request.decision,
        resumedAt: request.consumedAt,
      },
    };
    return { ok: true, sessionRevision: revision(session.revisionNumber) };
  }
}

function interactionFenceConflict(
  stored: StoredSession<AgentPrincipal>,
  fencingToken: TurnFencingToken | undefined,
):
  | {
      readonly ok: false;
      readonly reason: "stale_fence";
      readonly currentSessionRevision: string;
      readonly currentFencingToken: TurnFencingToken;
    }
  | undefined {
  validateOptionalFence(fencingToken);
  if (
    stored.fencingToken &&
    (!fencingToken ||
      compareTurnFencingTokens(fencingToken, stored.fencingToken) < 0)
  ) {
    return {
      ok: false,
      reason: "stale_fence",
      currentSessionRevision: revision(stored.revisionNumber),
      currentFencingToken: stored.fencingToken,
    };
  }
  if (fencingToken) stored.fencingToken = fencingToken;
  return undefined;
}

function mutationConflict(
  stored: StoredSession<AgentPrincipal>,
  request: {
    readonly expectedRevision: AgentSessionRevision;
    readonly fencingToken?: TurnFencingToken;
  },
): Extract<SaveAgentSessionResult, { ok: false }> | undefined {
  if (revision(stored.revisionNumber) !== request.expectedRevision) {
    return {
      ok: false,
      reason: "revision_conflict",
      currentRevision: revision(stored.revisionNumber),
    };
  }
  if (
    stored.fencingToken &&
    (!request.fencingToken ||
      compareTurnFencingTokens(request.fencingToken, stored.fencingToken) < 0)
  ) {
    return {
      ok: false,
      reason: "stale_fence",
      currentRevision: revision(stored.revisionNumber),
      currentFencingToken: stored.fencingToken,
    };
  }
  return undefined;
}

function validateOptionalFence(token: TurnFencingToken | undefined): void {
  if (token !== undefined) compareTurnFencingTokens(token, token);
}

function validateDecision(decision: ToolAuthorizationDecision): void {
  if (decision !== "allow" && decision !== "deny") {
    throw new Error("Interaction decision must be allow or deny");
  }
}

function validateSessionRecord(record: AgentSessionRecord): void {
  validateScope(record.principal, record.sessionId);
  nonNegativeInteger(record.createdAt, "Session createdAt");
  nonNegativeInteger(record.updatedAt, "Session updatedAt");
  if (record.updatedAt < record.createdAt) {
    throw new Error("Session updatedAt must not precede createdAt");
  }
  if (record.schemaVersion !== 1) {
    throw new Error("Session schemaVersion must be 1");
  }
}

function validateInteractionRecord(record: DurableToolInteractionRecord): void {
  validateInteractionScope(record);
  if (
    !samePrincipal(
      record.principal,
      record.continuation.prepared.request.principal,
    )
  ) {
    throw new Error(
      "Interaction continuation principal does not match its record",
    );
  }
  if (
    record.sessionId !== record.continuation.prepared.request.sessionId ||
    record.turnId !== record.continuation.prepared.turnId
  ) {
    throw new Error(
      "Interaction continuation session or turn does not match its record",
    );
  }
}

function validateInteractionScope(request: {
  readonly principal: AgentPrincipal;
  readonly sessionId: string;
  readonly interactionId: string;
}): void {
  validateScope(request.principal, request.sessionId);
  requiredText(request.interactionId, "interactionId");
}

function validateScope(principal: AgentPrincipal, sessionId: string): void {
  validatePrincipal(principal);
  requiredText(sessionId, "sessionId");
}

function validatePrincipal(principal: AgentPrincipal): void {
  requiredText(principal.tenantId, "principal.tenantId");
  requiredText(principal.subjectId, "principal.subjectId");
}

function samePrincipal(first: AgentPrincipal, second: AgentPrincipal): boolean {
  return (
    first.tenantId === second.tenantId && first.subjectId === second.subjectId
  );
}

function sessionKey(principal: AgentPrincipal, sessionId: string): string {
  return JSON.stringify([principal.tenantId, principal.subjectId, sessionId]);
}

function interactionKey(
  principal: AgentPrincipal,
  sessionId: string,
  interactionId: string,
): string {
  return JSON.stringify([
    principal.tenantId,
    principal.subjectId,
    sessionId,
    interactionId,
  ]);
}

function revision(value: number): AgentSessionRevision {
  return String(value);
}

function requiredText(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`Agent state ${field} must not be empty`);
  return trimmed;
}

function nonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
}
