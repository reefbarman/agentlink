import { isCoreReasoningEffort } from "@agentlink/protocol/model-catalog";

import {
  compareTurnFencingTokens,
  type AcquireAgentTurnLeaseResult,
  type AgentPrincipal,
  type AgentSessionRecord,
  type AgentSessionRepository,
  type AgentSessionSummary,
  type AgentTurnLease,
  type AgentTurnLeaseProvider,
  type ConsumeDurableToolInteractionResult,
  type CreateDurableToolInteractionResult,
  type CreateAgentSessionResult,
  type DeleteAgentSessionResult,
  type DurableToolInteractionRecord,
  type DurableToolInteractionRepository,
  type ReadAgentSessionResult,
  type ReadDurableToolInteractionResult,
  type ReleaseAgentTurnLeaseResult,
  type RenewAgentTurnLeaseResult,
  type SaveAgentSessionResult,
  type ToolAuthorizationDecision,
  type TurnFencingToken,
  type ValidateAgentTurnLeaseResult,
} from "@agentlink/core";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const STATE_FILENAME = "agent-state.json";
const LOCK_FILENAME = ".agent-state.lock";
const DEFAULT_MAX_STATE_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_RECOVERY_STATE_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_SESSIONS = 1_000;
const DEFAULT_MAX_INTERACTIONS = 4_000;
const DEFAULT_CONSUMED_INTERACTION_RETENTION_MS = 24 * 60 * 60 * 1_000;

interface StoredSession<TPrincipal extends AgentPrincipal> {
  record: AgentSessionRecord<TPrincipal>;
  revisionNumber: number;
  fencingToken?: TurnFencingToken;
}

interface StoredInteraction<TPrincipal extends AgentPrincipal> {
  record?: DurableToolInteractionRecord<TPrincipal>;
  principal: TPrincipal;
  sessionId: string;
  interactionId: string;
  revisionNumber: number;
  consumed: boolean;
  consumedAt?: number;
  responseIds: string[];
}

interface StoredTurnLease<TPrincipal extends AgentPrincipal> {
  lease: AgentTurnLease<TPrincipal>;
}

interface FileAgentStateV1<TPrincipal extends AgentPrincipal> {
  schemaVersion: 1;
  sessions: Record<string, StoredSession<TPrincipal>>;
  interactions: Record<string, StoredInteraction<TPrincipal>>;
}

interface FileAgentState<TPrincipal extends AgentPrincipal> {
  schemaVersion: 2;
  sessions: Record<string, StoredSession<TPrincipal>>;
  interactions: Record<string, StoredInteraction<TPrincipal>>;
  turnLeases: Record<string, StoredTurnLease<TPrincipal>>;
  nextFencingTokens: Record<string, TurnFencingToken>;
}

interface FileAgentStateCapacitySnapshot {
  readonly stateBytes: number;
  readonly sessionCount: number;
  readonly interactionCount: number;
}

export type FileAgentStateCapacityErrorCode =
  | "state_too_large"
  | "session_limit"
  | "interaction_limit";

export class FileAgentStateCapacityError extends Error {
  readonly code: FileAgentStateCapacityErrorCode;

  constructor(code: FileAgentStateCapacityErrorCode, message: string) {
    super(message);
    this.name = "FileAgentStateCapacityError";
    this.code = code;
  }
}

export interface CreateFileAgentStateRepositoryOptions {
  /** Absolute host-owned directory; no implicit current working directory exists. */
  readonly directory: string;
  /** Bounded retry policy for another local process committing the same store. */
  readonly lockRetryMs?: number;
  readonly maxLockAttempts?: number;
  /** Maximum encoded snapshot size accepted for ordinary commits. Defaults to 16 MiB. */
  readonly maxStateBytes?: number;
  /** Hard bounded read/commit ceiling used only to shrink over-capacity state. Defaults to 64 MiB. */
  readonly maxRecoveryStateBytes?: number;
  /** Maximum sessions retained in the shared snapshot. Defaults to 1,000. */
  readonly maxSessions?: number;
  /** Maximum pending interactions plus replay tombstones. Defaults to 4,000. */
  readonly maxInteractions?: number;
  /** Replay-tombstone retention after consumption. Defaults to 24 hours; zero prunes immediately. */
  readonly consumedInteractionRetentionMs?: number;
  /** Stable identity for this local host's dead-PID recovery scope. Defaults to the OS hostname. */
  readonly lockHostId?: string;
  /** Injectable lease ID factory for deterministic tests. */
  readonly createLeaseId?: () => string;
  /** Injectable wall clock for deterministic retention behavior. */
  readonly now?: () => number;
}

/**
 * Durable local-file adapter for the core session and interaction repositories.
 *
 * Every mutation acquires an exclusive state-file lock, checks all relevant
 * revisions and fences, and atomically replaces one fsynced JSON snapshot. It
 * is appropriate for a local single-machine Node host. Distributed turn leases
 * remain a separate host dependency because filesystem locking is not a
 * cross-machine lease protocol.
 */
export class FileAgentStateRepository<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
>
  implements
    AgentSessionRepository<TPrincipal>,
    DurableToolInteractionRepository<TPrincipal>,
    AgentTurnLeaseProvider<TPrincipal>
{
  private readonly directory: string;
  private readonly statePath: string;
  private readonly lockPath: string;
  private readonly lockRetryMs: number;
  private readonly maxLockAttempts: number;
  private readonly maxStateBytes: number;
  private readonly maxRecoveryStateBytes: number;
  private readonly maxSessions: number;
  private readonly maxInteractions: number;
  private readonly consumedInteractionRetentionMs: number;
  private readonly lockHostId: string;
  private readonly createLeaseId: () => string;
  private readonly now: () => number;

  constructor(options: CreateFileAgentStateRepositoryOptions) {
    if (!path.isAbsolute(options.directory)) {
      throw new Error("File agent state directory must be absolute");
    }
    this.directory = path.resolve(options.directory);
    this.statePath = path.join(this.directory, STATE_FILENAME);
    this.lockPath = path.join(this.directory, LOCK_FILENAME);
    this.lockRetryMs = positiveInteger(
      options.lockRetryMs ?? 10,
      "lockRetryMs",
    );
    this.maxLockAttempts = positiveInteger(
      options.maxLockAttempts ?? 100,
      "maxLockAttempts",
    );
    this.maxStateBytes = positiveInteger(
      options.maxStateBytes ?? DEFAULT_MAX_STATE_BYTES,
      "maxStateBytes",
    );
    this.maxRecoveryStateBytes = positiveInteger(
      options.maxRecoveryStateBytes ??
        Math.max(DEFAULT_MAX_RECOVERY_STATE_BYTES, this.maxStateBytes),
      "maxRecoveryStateBytes",
    );
    if (this.maxRecoveryStateBytes < this.maxStateBytes) {
      throw new Error(
        "File agent state maxRecoveryStateBytes must be at least maxStateBytes",
      );
    }
    this.maxSessions = positiveInteger(
      options.maxSessions ?? DEFAULT_MAX_SESSIONS,
      "maxSessions",
    );
    this.maxInteractions = positiveInteger(
      options.maxInteractions ?? DEFAULT_MAX_INTERACTIONS,
      "maxInteractions",
    );
    this.consumedInteractionRetentionMs = nonNegativeIntegerValue(
      options.consumedInteractionRetentionMs ??
        DEFAULT_CONSUMED_INTERACTION_RETENTION_MS,
      "consumedInteractionRetentionMs",
    );
    const lockHostId = options.lockHostId ?? os.hostname();
    requiredText(lockHostId, "lockHostId");
    this.lockHostId = lockHostId;
    this.createLeaseId = options.createLeaseId ?? randomUUID;
    this.now = options.now ?? Date.now;
  }

  async acquireTurnLease(request: {
    readonly principal: TPrincipal;
    readonly sessionId: string;
    readonly turnId: string;
    readonly ownerId: string;
    readonly ttlMs: number;
  }): Promise<AcquireAgentTurnLeaseResult<TPrincipal>> {
    validateLeaseScope(request);
    const ttlMs = positiveInteger(request.ttlMs, "Turn lease ttlMs");
    return this.mutate<AcquireAgentTurnLeaseResult<TPrincipal>>((state) => {
      const key = sessionKey(request.principal, request.sessionId);
      const now = readClock(this.now);
      const current = state.turnLeases[key]?.lease;
      if (current && now < current.expiresAt) {
        return {
          result: {
            ok: false,
            reason: "held",
            holder: {
              ownerId: current.ownerId,
              turnId: current.turnId,
              expiresAt: current.expiresAt,
            },
          },
        };
      }
      const sessionFence = state.sessions[key]?.fencingToken;
      const next = nextFencingToken(
        state.nextFencingTokens[key],
        sessionFence,
        current?.fencingToken,
      );
      const lease: AgentTurnLease<TPrincipal> = {
        leaseId: requiredTextValue(this.createLeaseId(), "leaseId"),
        principal: clone(request.principal),
        sessionId: request.sessionId,
        turnId: request.turnId,
        ownerId: request.ownerId,
        fencingToken: next,
        acquiredAt: now,
        expiresAt: safeLeaseExpiry(now, ttlMs),
      };
      state.turnLeases[key] = { lease };
      state.nextFencingTokens[key] = next;
      return { changed: true, result: { ok: true, lease: clone(lease) } };
    });
  }

  async renewTurnLease(request: {
    readonly principal: TPrincipal;
    readonly sessionId: string;
    readonly leaseId: string;
    readonly ownerId: string;
    readonly fencingToken: TurnFencingToken;
    readonly ttlMs: number;
  }): Promise<RenewAgentTurnLeaseResult<TPrincipal>> {
    validateLeaseIdentity(request);
    const ttlMs = positiveInteger(request.ttlMs, "Turn lease ttlMs");
    return this.mutate<RenewAgentTurnLeaseResult<TPrincipal>>((state) => {
      const key = sessionKey(request.principal, request.sessionId);
      const current = state.turnLeases[key]?.lease;
      if (!current) return { result: { ok: false, reason: "not_found" } };
      if (!sameLease(current, request)) {
        return { result: { ok: false, reason: "lost" } };
      }
      const now = readClock(this.now);
      if (now >= current.expiresAt) {
        return { result: { ok: false, reason: "expired" } };
      }
      const lease: AgentTurnLease<TPrincipal> = {
        ...current,
        expiresAt: safeLeaseExpiry(now, ttlMs),
      };
      state.turnLeases[key] = { lease };
      return { changed: true, result: { ok: true, lease: clone(lease) } };
    });
  }

  async releaseTurnLease(request: {
    readonly principal: TPrincipal;
    readonly sessionId: string;
    readonly leaseId: string;
    readonly ownerId: string;
    readonly fencingToken: TurnFencingToken;
  }): Promise<ReleaseAgentTurnLeaseResult> {
    validateLeaseIdentity(request);
    return this.mutate<ReleaseAgentTurnLeaseResult>((state) => {
      const key = sessionKey(request.principal, request.sessionId);
      const current = state.turnLeases[key]?.lease;
      if (!current) return { result: { ok: false, reason: "not_found" } };
      if (!sameLease(current, request)) {
        return { result: { ok: false, reason: "lost" } };
      }
      delete state.turnLeases[key];
      return { changed: true, result: { ok: true } };
    });
  }

  async validateTurnLease(request: {
    readonly principal: TPrincipal;
    readonly sessionId: string;
    readonly leaseId: string;
    readonly ownerId: string;
    readonly fencingToken: TurnFencingToken;
  }): Promise<ValidateAgentTurnLeaseResult> {
    validateLeaseIdentity(request);
    const state = await this.readState();
    const current =
      state.turnLeases[sessionKey(request.principal, request.sessionId)]?.lease;
    if (!current) return { ok: false, reason: "not_found" };
    if (!sameLease(current, request)) return { ok: false, reason: "lost" };
    if (readClock(this.now) >= current.expiresAt) {
      return { ok: false, reason: "expired" };
    }
    return { ok: true, expiresAt: current.expiresAt };
  }

  async createSession(request: {
    readonly record: AgentSessionRecord<TPrincipal>;
  }): Promise<CreateAgentSessionResult> {
    validateSessionRecord(request.record);
    return this.mutate<CreateAgentSessionResult>((state) => {
      const key = sessionKey(
        request.record.principal,
        request.record.sessionId,
      );
      if (state.sessions[key])
        return { result: { ok: false, reason: "already_exists" } };
      state.sessions[key] = {
        record: clone(request.record),
        revisionNumber: 1,
      };
      return { changed: true, result: { ok: true, revision: revision(1) } };
    });
  }

  async readSession(request: {
    readonly principal: TPrincipal;
    readonly sessionId: string;
  }): Promise<ReadAgentSessionResult<TPrincipal>> {
    validateScope(request.principal, request.sessionId);
    const state = await this.readState();
    const stored =
      state.sessions[sessionKey(request.principal, request.sessionId)];
    if (!stored) return { ok: false, reason: "not_found" };
    return {
      ok: true,
      record: clone(stored.record),
      revision: revision(stored.revisionNumber),
      ...(stored.fencingToken ? { fencingToken: stored.fencingToken } : {}),
    };
  }

  async listSessions(request: {
    readonly principal: TPrincipal;
  }): Promise<readonly AgentSessionSummary<TPrincipal>[]> {
    validatePrincipal(request.principal);
    const state = await this.readState();
    return Object.values(state.sessions)
      .filter((stored) =>
        samePrincipal(stored.record.principal, request.principal),
      )
      .map((stored) => ({
        principal: clone(stored.record.principal),
        sessionId: stored.record.sessionId,
        createdAt: stored.record.createdAt,
        updatedAt: stored.record.updatedAt,
        ...(stored.record.selectedModel
          ? { selectedModel: clone(stored.record.selectedModel) }
          : {}),
        ...(stored.record.reasoningEffort !== undefined
          ? { reasoningEffort: stored.record.reasoningEffort }
          : {}),
        runState: clone(stored.record.runState),
        ...(stored.record.pendingInteractionId
          ? { pendingInteractionId: stored.record.pendingInteractionId }
          : {}),
        revision: revision(stored.revisionNumber),
      }))
      .sort(
        (left, right) =>
          right.updatedAt - left.updatedAt ||
          left.sessionId.localeCompare(right.sessionId),
      );
  }

  async saveSession(request: {
    readonly record: AgentSessionRecord<TPrincipal>;
    readonly expectedRevision: string;
    readonly fencingToken?: TurnFencingToken;
  }): Promise<SaveAgentSessionResult> {
    validateSessionRecord(request.record);
    validateFence(request.fencingToken);
    return this.mutate<SaveAgentSessionResult>((state) => {
      const stored =
        state.sessions[
          sessionKey(request.record.principal, request.record.sessionId)
        ];
      if (!stored) return { result: { ok: false, reason: "not_found" } };
      const conflict = sessionMutationConflict(stored, request);
      if (conflict) return { result: conflict };
      stored.revisionNumber += 1;
      stored.record = clone(request.record);
      if (request.fencingToken) stored.fencingToken = request.fencingToken;
      return {
        changed: true,
        result: { ok: true, revision: revision(stored.revisionNumber) },
      };
    });
  }

  async deleteSession(request: {
    readonly principal: TPrincipal;
    readonly sessionId: string;
    readonly expectedRevision: string;
    readonly fencingToken?: TurnFencingToken;
  }): Promise<DeleteAgentSessionResult> {
    validateScope(request.principal, request.sessionId);
    validateFence(request.fencingToken);
    return this.mutate<DeleteAgentSessionResult>((state) => {
      const key = sessionKey(request.principal, request.sessionId);
      const stored = state.sessions[key];
      if (!stored) return { result: { ok: false, reason: "not_found" } };
      const conflict = sessionMutationConflict(stored, request);
      if (conflict) return { result: conflict };
      delete state.sessions[key];
      for (const [interactionKey, interaction] of Object.entries(
        state.interactions,
      )) {
        if (
          samePrincipal(interaction.principal, request.principal) &&
          interaction.sessionId === request.sessionId
        ) {
          delete state.interactions[interactionKey];
        }
      }
      return { changed: true, result: { ok: true } };
    });
  }

  async createInteraction(request: {
    readonly record: DurableToolInteractionRecord<TPrincipal>;
    readonly expectedSessionRevision: string;
    readonly fencingToken?: TurnFencingToken;
  }): Promise<CreateDurableToolInteractionResult> {
    validateInteractionRecord(request.record);
    validateFence(request.fencingToken);
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
    return this.mutate<CreateDurableToolInteractionResult>((state) => {
      const session =
        state.sessions[
          sessionKey(request.record.principal, request.record.sessionId)
        ];
      if (
        !session ||
        revision(session.revisionNumber) !== request.expectedSessionRevision
      ) {
        return {
          result: {
            ok: false,
            reason: "session_revision_conflict",
            ...(session
              ? { currentSessionRevision: revision(session.revisionNumber) }
              : {}),
          },
        };
      }
      if (
        session.record.pendingInteractionId &&
        session.record.pendingInteractionId !== request.record.interactionId
      ) {
        return { result: { ok: false, reason: "already_exists" } };
      }
      const key = interactionKey(
        request.record.principal,
        request.record.sessionId,
        request.record.interactionId,
      );
      if (state.interactions[key]) {
        return { result: { ok: false, reason: "already_exists" } };
      }
      const fenceConflict = interactionFenceConflict(
        session,
        request.fencingToken,
      );
      if (fenceConflict) return { result: fenceConflict };
      if (request.fencingToken) session.fencingToken = request.fencingToken;
      state.interactions[key] = {
        record: clone(request.record),
        principal: clone(request.record.principal),
        sessionId: request.record.sessionId,
        interactionId: request.record.interactionId,
        revisionNumber: 1,
        consumed: false,
        responseIds: [],
      };
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
        changed: true,
        result: {
          ok: true,
          interactionRevision: revision(1),
          sessionRevision: revision(session.revisionNumber),
        },
      };
    });
  }

  async readInteraction(request: {
    readonly principal: TPrincipal;
    readonly sessionId: string;
    readonly interactionId: string;
  }): Promise<ReadDurableToolInteractionResult<TPrincipal>> {
    validateInteractionScope(request);
    const state = await this.readState();
    const stored =
      state.interactions[
        interactionKey(
          request.principal,
          request.sessionId,
          request.interactionId,
        )
      ];
    if (!stored) return { ok: false, reason: "not_found" };
    if (stored.consumed) return { ok: false, reason: "consumed" };
    if (!stored.record) return { ok: false, reason: "not_found" };
    const session =
      state.sessions[sessionKey(request.principal, request.sessionId)];
    if (!session) return { ok: false, reason: "not_found" };
    return {
      ok: true,
      record: clone(stored.record),
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
    validateFence(request.fencingToken);
    requiredText(request.responseId, "responseId");
    validateDecision(request.decision);
    nonNegativeInteger(request.consumedAt, "Interaction consumedAt");
    return this.mutate<ConsumeDurableToolInteractionResult>((state) => {
      const stored =
        state.interactions[
          interactionKey(
            request.principal,
            request.sessionId,
            request.interactionId,
          )
        ];
      if (!stored) return { result: { ok: false, reason: "not_found" } };
      if (stored.consumed || stored.responseIds.includes(request.responseId)) {
        return { result: { ok: false, reason: "consumed" } };
      }
      if (
        revision(stored.revisionNumber) !== request.expectedInteractionRevision
      ) {
        return {
          result: {
            ok: false,
            reason: "interaction_revision_conflict",
            currentInteractionRevision: revision(stored.revisionNumber),
          },
        };
      }
      const session =
        state.sessions[sessionKey(request.principal, request.sessionId)];
      if (!session) return { result: { ok: false, reason: "not_found" } };
      if (
        revision(session.revisionNumber) !== request.expectedSessionRevision
      ) {
        return {
          result: {
            ok: false,
            reason: "session_revision_conflict",
            currentSessionRevision: revision(session.revisionNumber),
          },
        };
      }
      const fenceConflict = interactionFenceConflict(
        session,
        request.fencingToken,
      );
      if (fenceConflict) return { result: fenceConflict };
      const interaction = stored.record;
      if (!interaction) return { result: { ok: false, reason: "not_found" } };
      if (request.fencingToken) session.fencingToken = request.fencingToken;
      stored.consumed = true;
      stored.consumedAt = request.consumedAt;
      stored.responseIds.push(request.responseId);
      stored.revisionNumber += 1;
      stored.record = undefined;
      session.revisionNumber += 1;
      session.record = {
        ...session.record,
        updatedAt: Math.max(session.record.updatedAt, request.consumedAt),
        pendingInteractionId: undefined,
        lastTurnId: interaction.turnId,
        runState: {
          phase: "resuming",
          turnId: interaction.turnId,
          interactionId: interaction.interactionId,
          responseId: request.responseId,
          decision: request.decision,
          resumedAt: request.consumedAt,
        },
      };
      return {
        changed: true,
        result: { ok: true, sessionRevision: revision(session.revisionNumber) },
      };
    });
  }

  private async mutate<TResult>(
    operation: (state: FileAgentState<TPrincipal>) => {
      readonly changed?: boolean;
      readonly result: TResult;
    },
  ): Promise<TResult> {
    return this.withLock(async () => {
      const state = await this.readState();
      const before = capacitySnapshot(state);
      const prunedBefore = this.pruneConsumedInteractions(state);
      const outcome = operation(state);
      const prunedAfter = this.pruneConsumedInteractions(state);
      const after = capacitySnapshot(state);
      const capacityError = this.capacityError(after);
      if (capacityError && !strictlyReducesCapacity(before, after)) {
        throw capacityError;
      }
      if (outcome.changed || prunedBefore || prunedAfter) {
        await this.writeState(state, capacityError !== undefined);
      }
      return outcome.result;
    });
  }

  private async readState(): Promise<FileAgentState<TPrincipal>> {
    try {
      const stat = await fs.stat(this.statePath);
      if (stat.size > this.maxRecoveryStateBytes) {
        throw new FileAgentStateCapacityError(
          "state_too_large",
          `File agent state exceeds maxRecoveryStateBytes (${this.maxRecoveryStateBytes})`,
        );
      }
      const raw = await fs.readFile(this.statePath, "utf8");
      if (Buffer.byteLength(raw, "utf8") > this.maxRecoveryStateBytes) {
        throw new FileAgentStateCapacityError(
          "state_too_large",
          `File agent state exceeds maxRecoveryStateBytes (${this.maxRecoveryStateBytes})`,
        );
      }
      const parsed = JSON.parse(raw) as Partial<
        FileAgentState<TPrincipal> | FileAgentStateV1<TPrincipal>
      >;
      if (
        (parsed.schemaVersion !== 1 && parsed.schemaVersion !== 2) ||
        !parsed.sessions ||
        !parsed.interactions ||
        typeof parsed.sessions !== "object" ||
        Array.isArray(parsed.sessions) ||
        typeof parsed.interactions !== "object" ||
        Array.isArray(parsed.interactions)
      ) {
        throw new Error("File agent state is malformed or unsupported");
      }
      return migrateFileAgentState(
        parsed as FileAgentState<TPrincipal> | FileAgentStateV1<TPrincipal>,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return {
          schemaVersion: 2,
          sessions: {},
          interactions: {},
          turnLeases: {},
          nextFencingTokens: {},
        };
      }
      throw error;
    }
  }

  private async writeState(
    state: FileAgentState<TPrincipal>,
    allowOverCapacity = false,
  ): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    await fs.chmod(this.directory, 0o700);
    const serialized = serializeState(state);
    const stateBytes = Buffer.byteLength(serialized, "utf8");
    const maximumBytes = allowOverCapacity
      ? this.maxRecoveryStateBytes
      : this.maxStateBytes;
    if (stateBytes > maximumBytes) {
      throw new FileAgentStateCapacityError(
        "state_too_large",
        `File agent state would exceed ${allowOverCapacity ? "maxRecoveryStateBytes" : "maxStateBytes"} (${maximumBytes})`,
      );
    }
    const temporaryPath = path.join(
      this.directory,
      `.${STATE_FILENAME}.${process.pid}.${randomUUID()}.tmp`,
    );
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      handle = await fs.open(temporaryPath, "wx", 0o600);
      await handle.chmod(0o600);
      await handle.writeFile(serialized, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await fs.rename(temporaryPath, this.statePath);
      await syncDirectory(this.directory);
    } finally {
      await handle?.close().catch(() => undefined);
      await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }

  private async withLock<TResult>(
    operation: () => Promise<TResult>,
  ): Promise<TResult> {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    await fs.chmod(this.directory, 0o700);
    const ownerToken = randomUUID();
    const preparedLockPath = `${this.lockPath}.owner.${process.pid}.${ownerToken}`;
    let lockHandle: Awaited<ReturnType<typeof fs.open>> | undefined;
    let acquired = false;
    try {
      lockHandle = await fs.open(preparedLockPath, "wx", 0o600);
      await lockHandle.writeFile(
        `${JSON.stringify({
          token: ownerToken,
          pid: process.pid,
          hostId: this.lockHostId,
        })}\n`,
        "utf8",
      );
      await lockHandle.sync();
      for (let attempt = 0; attempt < this.maxLockAttempts; attempt += 1) {
        try {
          // Publishing a hard link is one atomic step and the linked inode is
          // already fully initialized, so contenders never observe a partial owner.
          await fs.link(preparedLockPath, this.lockPath);
          acquired = true;
          await fs.rm(preparedLockPath);
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          if (await this.reclaimDeadLock()) continue;
          await delay(this.lockRetryMs);
        }
      }
      if (!acquired) throw new Error("File agent state lock is held");
      await this.removeOrphanTemporaryFiles();
      return await operation();
    } finally {
      const ownedStat = await lockHandle?.stat().catch(() => undefined);
      await lockHandle?.close().catch(() => undefined);
      await fs.rm(preparedLockPath, { force: true }).catch(() => undefined);
      if (acquired && ownedStat) {
        const currentStat = await fs.stat(this.lockPath).catch(() => undefined);
        if (
          currentStat &&
          currentStat.dev === ownedStat.dev &&
          currentStat.ino === ownedStat.ino
        ) {
          await fs.rm(this.lockPath).catch(() => undefined);
        }
      }
    }
  }

  private async reclaimDeadLock(): Promise<boolean> {
    const reclaimLockPath = `${this.lockPath}.reclaim`;
    const claimPath = `${reclaimLockPath}.${process.pid}.${randomUUID()}`;
    let reclaimHandle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      // Only one contender may inspect/remove a dead lock. A crashed reclaim
      // guard fails closed for operator recovery rather than risking a successor.
      reclaimHandle = await fs.open(reclaimLockPath, "wx", 0o600);
      const raw = await fs.readFile(this.lockPath, "utf8");
      const owner = JSON.parse(raw) as {
        token?: unknown;
        pid?: unknown;
        hostId?: unknown;
      };
      if (
        typeof owner.token !== "string" ||
        !owner.token ||
        owner.hostId !== this.lockHostId ||
        !Number.isSafeInteger(owner.pid) ||
        Number(owner.pid) <= 0 ||
        isProcessAlive(Number(owner.pid))
      ) {
        return false;
      }

      // Link preserves the inspected inode. Only unlink the public lock path when
      // it still names that exact inode, so a successor can never be displaced.
      await fs.link(this.lockPath, claimPath);
      const [claimStat, currentStat] = await Promise.all([
        fs.stat(claimPath),
        fs.stat(this.lockPath),
      ]);
      if (
        claimStat.dev !== currentStat.dev ||
        claimStat.ino !== currentStat.ino
      ) {
        return false;
      }
      const confirmed = JSON.parse(await fs.readFile(claimPath, "utf8")) as {
        token?: unknown;
      };
      if (confirmed.token !== owner.token) return false;
      await fs.rm(this.lockPath);
      return true;
    } catch {
      return false;
    } finally {
      await fs.rm(claimPath, { force: true }).catch(() => undefined);
      await reclaimHandle?.close().catch(() => undefined);
      if (reclaimHandle) {
        await fs.rm(reclaimLockPath, { force: true }).catch(() => undefined);
      }
    }
  }

  private async removeOrphanTemporaryFiles(): Promise<void> {
    const prefix = `.${STATE_FILENAME}.`;
    const entries = await fs.readdir(this.directory);
    await Promise.all(
      entries
        .filter((entry) => entry.startsWith(prefix) && entry.endsWith(".tmp"))
        .map((entry) =>
          fs.rm(path.join(this.directory, entry), { force: true }),
        ),
    );
  }

  private pruneConsumedInteractions(
    state: FileAgentState<TPrincipal>,
  ): boolean {
    const cutoff = readClock(this.now) - this.consumedInteractionRetentionMs;
    let changed = false;
    for (const [key, stored] of Object.entries(state.interactions)) {
      if (
        stored.consumed &&
        stored.consumedAt !== undefined &&
        stored.consumedAt <= cutoff
      ) {
        delete state.interactions[key];
        changed = true;
      }
    }
    return changed;
  }

  private capacityError(
    capacity: FileAgentStateCapacitySnapshot,
  ): FileAgentStateCapacityError | undefined {
    if (capacity.sessionCount > this.maxSessions) {
      return new FileAgentStateCapacityError(
        "session_limit",
        `File agent state exceeds maxSessions (${this.maxSessions})`,
      );
    }
    if (capacity.interactionCount > this.maxInteractions) {
      return new FileAgentStateCapacityError(
        "interaction_limit",
        `File agent state exceeds maxInteractions (${this.maxInteractions})`,
      );
    }
    if (capacity.stateBytes > this.maxStateBytes) {
      return new FileAgentStateCapacityError(
        "state_too_large",
        `File agent state exceeds maxStateBytes (${this.maxStateBytes})`,
      );
    }
    return undefined;
  }
}

/** Pair durable local state with its restart-stable lease provider or an explicit override. */
export function createFileNodeHostPersistence<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
>(options: {
  readonly state: CreateFileAgentStateRepositoryOptions;
  /** Override only when the host needs a shared distributed lease provider. */
  readonly turnLeases?: AgentTurnLeaseProvider<TPrincipal>;
}): {
  readonly sessions: FileAgentStateRepository<TPrincipal>;
  readonly interactions: FileAgentStateRepository<TPrincipal>;
  readonly turnLeases: AgentTurnLeaseProvider<TPrincipal>;
} {
  const state = new FileAgentStateRepository<TPrincipal>(options.state);
  return {
    sessions: state,
    interactions: state,
    turnLeases: options.turnLeases ?? state,
  };
}

function migrateFileAgentState<TPrincipal extends AgentPrincipal>(
  source: FileAgentState<TPrincipal> | FileAgentStateV1<TPrincipal>,
): FileAgentState<TPrincipal> {
  const state: FileAgentState<TPrincipal> = {
    schemaVersion: 2,
    sessions: source.sessions,
    interactions: source.interactions,
    turnLeases:
      "turnLeases" in source && source.turnLeases ? source.turnLeases : {},
    nextFencingTokens:
      "nextFencingTokens" in source && source.nextFencingTokens
        ? source.nextFencingTokens
        : {},
  };
  for (const stored of Object.values(state.interactions)) {
    const record = stored.record;
    if (record) {
      stored.principal ??= clone(record.principal);
      stored.sessionId ??= record.sessionId;
      stored.interactionId ??= record.interactionId;
    }
    if (stored.consumed) {
      stored.record = undefined;
      // V1 did not retain a consumption timestamp. Treat its already-private
      // tombstones as immediately eligible for pruning on the next mutation.
      stored.consumedAt ??= 0;
    }
  }
  return state;
}

function validateLeaseScope(request: {
  readonly principal: AgentPrincipal;
  readonly sessionId: string;
  readonly turnId: string;
  readonly ownerId: string;
}): void {
  validateScope(request.principal, request.sessionId);
  requiredText(request.turnId, "turnId");
  requiredText(request.ownerId, "ownerId");
}

function validateLeaseIdentity(request: {
  readonly principal: AgentPrincipal;
  readonly sessionId: string;
  readonly leaseId: string;
  readonly ownerId: string;
  readonly fencingToken: TurnFencingToken;
}): void {
  validateScope(request.principal, request.sessionId);
  requiredText(request.leaseId, "leaseId");
  requiredText(request.ownerId, "ownerId");
  compareTurnFencingTokens(request.fencingToken, request.fencingToken);
}

function sameLease(
  current: AgentTurnLease,
  request: {
    readonly leaseId: string;
    readonly ownerId: string;
    readonly fencingToken: TurnFencingToken;
  },
): boolean {
  return (
    current.leaseId === request.leaseId &&
    current.ownerId === request.ownerId &&
    current.fencingToken === request.fencingToken
  );
}

function nextFencingToken(
  ...values: Array<TurnFencingToken | undefined>
): TurnFencingToken {
  let maximum = 0n;
  for (const value of values) {
    if (value !== undefined) {
      compareTurnFencingTokens(value, value);
      const parsed = BigInt(value);
      if (parsed > maximum) maximum = parsed;
    }
  }
  return (maximum + 1n).toString(10);
}

function safeLeaseExpiry(now: number, ttlMs: number): number {
  const expiresAt = now + ttlMs;
  if (!Number.isSafeInteger(expiresAt)) {
    throw new Error("Turn lease expiry exceeds the safe integer range");
  }
  return expiresAt;
}

function sessionMutationConflict(
  stored: StoredSession<AgentPrincipal>,
  request: {
    readonly expectedRevision: string;
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
  return undefined;
}

function validateSessionRecord(record: AgentSessionRecord): void {
  validateScope(record.principal, record.sessionId);
  nonNegativeInteger(record.createdAt, "Session createdAt");
  nonNegativeInteger(record.updatedAt, "Session updatedAt");
  if (record.updatedAt < record.createdAt) {
    throw new Error("Session updatedAt must not precede createdAt");
  }
  if (record.schemaVersion !== 1)
    throw new Error("Session schemaVersion must be 1");
  if (
    record.reasoningEffort !== undefined &&
    !isCoreReasoningEffort(record.reasoningEffort)
  ) {
    throw new Error("Session reasoningEffort must be supported");
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

function validateFence(token: TurnFencingToken | undefined): void {
  if (token !== undefined) compareTurnFencingTokens(token, token);
}

function validateDecision(decision: ToolAuthorizationDecision): void {
  if (decision !== "allow" && decision !== "deny") {
    throw new Error("Interaction decision must be allow or deny");
  }
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

function revision(value: number): string {
  return String(value);
}

function serializeState(state: FileAgentState<AgentPrincipal>): string {
  assertJsonCompatible(state, "state");
  return `${JSON.stringify(state)}\n`;
}

function capacitySnapshot(
  state: FileAgentState<AgentPrincipal>,
): FileAgentStateCapacitySnapshot {
  return {
    stateBytes: Buffer.byteLength(serializeState(state), "utf8"),
    sessionCount: Object.keys(state.sessions).length,
    interactionCount: Object.keys(state.interactions).length,
  };
}

function strictlyReducesCapacity(
  before: FileAgentStateCapacitySnapshot,
  after: FileAgentStateCapacitySnapshot,
): boolean {
  return (
    after.stateBytes <= before.stateBytes &&
    after.sessionCount <= before.sessionCount &&
    after.interactionCount <= before.interactionCount &&
    (after.stateBytes < before.stateBytes ||
      after.sessionCount < before.sessionCount ||
      after.interactionCount < before.interactionCount)
  );
}

/** Optional object fields may be omitted; all persisted values must otherwise survive JSON unchanged. */
function assertJsonCompatible(
  value: unknown,
  field: string,
  ancestors = new Set<object>(),
): void {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return;
  }
  if (typeof value === "number") {
    if (Number.isFinite(value)) return;
    throw new Error(
      `File agent state ${field} must not contain a non-finite number`,
    );
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) {
      throw new Error(`File agent state ${field} must not contain a cycle`);
    }
    ancestors.add(value);
    value.forEach((item, index) => {
      if (item === undefined) {
        throw new Error(
          `File agent state ${field}[${index}] must not be undefined`,
        );
      }
      assertJsonCompatible(item, `${field}[${index}]`, ancestors);
    });
    ancestors.delete(value);
    return;
  }
  if (value && typeof value === "object") {
    if (Object.getPrototypeOf(value) !== Object.prototype) {
      throw new Error(
        `File agent state ${field} must contain plain JSON objects`,
      );
    }
    if (ancestors.has(value)) {
      throw new Error(`File agent state ${field} must not contain a cycle`);
    }
    ancestors.add(value);
    for (const [key, item] of Object.entries(value)) {
      // Optional fields are intentionally omitted by JSON serialization.
      if (item !== undefined)
        assertJsonCompatible(item, `${field}.${key}`, ancestors);
    }
    ancestors.delete(value);
    return;
  }
  throw new Error(`File agent state ${field} must be JSON-serializable`);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`File agent state ${field} must be a positive integer`);
  }
  return value;
}

function nonNegativeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`File agent state ${field} must be a non-negative integer`);
  }
}

function nonNegativeIntegerValue(value: number, field: string): number {
  nonNegativeInteger(value, field);
  return value;
}

function requiredText(value: string, field: string): void {
  if (!value.trim())
    throw new Error(`File agent state ${field} must not be empty`);
}

function requiredTextValue(value: string, field: string): string {
  requiredText(value, field);
  return value.trim();
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function readClock(now: () => number): number {
  const value = now();
  nonNegativeInteger(value, "clock");
  return value;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(directory, "r");
    await handle.sync();
  } catch {
    // Directory fsync is not supported by every local filesystem.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
