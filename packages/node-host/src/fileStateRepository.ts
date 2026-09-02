import {
  compareTurnFencingTokens,
  type AgentPrincipal,
  type AgentSessionRecord,
  type AgentSessionRepository,
  type AgentSessionSummary,
  type AgentTurnLeaseProvider,
  type ConsumeDurableToolInteractionResult,
  type CreateDurableToolInteractionResult,
  type CreateAgentSessionResult,
  type DeleteAgentSessionResult,
  type DurableToolInteractionRecord,
  type DurableToolInteractionRepository,
  type ReadAgentSessionResult,
  type ReadDurableToolInteractionResult,
  type SaveAgentSessionResult,
  type ToolAuthorizationDecision,
  type TurnFencingToken,
} from "@agentlink/core";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const STATE_FILENAME = "agent-state.json";
const LOCK_FILENAME = ".agent-state.lock";

interface StoredSession<TPrincipal extends AgentPrincipal> {
  record: AgentSessionRecord<TPrincipal>;
  revisionNumber: number;
  fencingToken?: TurnFencingToken;
}

interface StoredInteraction<TPrincipal extends AgentPrincipal> {
  record: DurableToolInteractionRecord<TPrincipal>;
  revisionNumber: number;
  consumed: boolean;
  responseIds: string[];
}

interface FileAgentState<TPrincipal extends AgentPrincipal> {
  schemaVersion: 1;
  sessions: Record<string, StoredSession<TPrincipal>>;
  interactions: Record<string, StoredInteraction<TPrincipal>>;
}

export interface CreateFileAgentStateRepositoryOptions {
  /** Absolute host-owned directory; no implicit current working directory exists. */
  readonly directory: string;
  /** Bounded retry policy for another local process committing the same store. */
  readonly lockRetryMs?: number;
  readonly maxLockAttempts?: number;
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
    DurableToolInteractionRepository<TPrincipal>
{
  private readonly directory: string;
  private readonly statePath: string;
  private readonly lockPath: string;
  private readonly lockRetryMs: number;
  private readonly maxLockAttempts: number;

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
          samePrincipal(interaction.record.principal, request.principal) &&
          interaction.record.sessionId === request.sessionId
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
      if (request.fencingToken) session.fencingToken = request.fencingToken;
      stored.consumed = true;
      stored.responseIds.push(request.responseId);
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
      const outcome = operation(state);
      if (outcome.changed) await this.writeState(state);
      return outcome.result;
    });
  }

  private async readState(): Promise<FileAgentState<TPrincipal>> {
    try {
      const raw = await fs.readFile(this.statePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<FileAgentState<TPrincipal>>;
      if (
        parsed.schemaVersion !== 1 ||
        !parsed.sessions ||
        !parsed.interactions ||
        typeof parsed.sessions !== "object" ||
        typeof parsed.interactions !== "object"
      ) {
        throw new Error("File agent state is malformed");
      }
      return parsed as FileAgentState<TPrincipal>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { schemaVersion: 1, sessions: {}, interactions: {} };
      }
      throw error;
    }
  }

  private async writeState(state: FileAgentState<TPrincipal>): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    await fs.chmod(this.directory, 0o700);
    const temporaryPath = path.join(
      this.directory,
      `.${STATE_FILENAME}.${process.pid}.${randomUUID()}.tmp`,
    );
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      handle = await fs.open(temporaryPath, "w", 0o600);
      await handle.chmod(0o600);
      await handle.writeFile(serializeState(state), "utf8");
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
    let acquired = false;
    for (let attempt = 0; attempt < this.maxLockAttempts; attempt += 1) {
      try {
        // A directory is an atomic ownership token: only its successful removal
        // releases it, so a previous owner cannot remove a new owner's lock.
        await fs.mkdir(this.lockPath, { mode: 0o700 });
        acquired = true;
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        await delay(this.lockRetryMs);
      }
    }
    if (!acquired) throw new Error("File agent state lock is held");
    try {
      return await operation();
    } finally {
      await fs.rmdir(this.lockPath);
    }
  }
}

/** Pair a durable local state repository with an explicitly supplied lease provider. */
export function createFileNodeHostPersistence<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
>(options: {
  readonly state: CreateFileAgentStateRepositoryOptions;
  readonly turnLeases: AgentTurnLeaseProvider<TPrincipal>;
}): {
  readonly sessions: FileAgentStateRepository<TPrincipal>;
  readonly interactions: FileAgentStateRepository<TPrincipal>;
  readonly turnLeases: AgentTurnLeaseProvider<TPrincipal>;
} {
  const state = new FileAgentStateRepository<TPrincipal>(options.state);
  return {
    sessions: state,
    interactions: state,
    turnLeases: options.turnLeases,
  };
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

function requiredText(value: string, field: string): void {
  if (!value.trim())
    throw new Error(`File agent state ${field} must not be empty`);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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
