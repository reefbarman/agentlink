import type {
  AgentSessionRecord,
  AgentSessionRepository,
} from "./sessionRepository.js";

import type { AgentPrincipal } from "./modelIdentity.js";
import type { AgentTurnLeaseProvider } from "./turnLeases.js";

export interface AgentRepositoryContractAdapter<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
> {
  readonly repository: AgentSessionRepository<TPrincipal>;
  readonly principal: TPrincipal;
  readonly otherPrincipal: TPrincipal;
  readonly createSessionId: (label: string) => string;
  readonly now?: () => number;
}

export interface AgentTurnLeaseContractAdapter<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
> {
  readonly provider: AgentTurnLeaseProvider<TPrincipal>;
  readonly principal: TPrincipal;
  readonly otherPrincipal: TPrincipal;
  readonly createSessionId: (label: string) => string;
  /** Advance a deterministic adapter clock; required for expiry/takeover checks. */
  readonly advanceTime: (milliseconds: number) => void | Promise<void>;
}

/**
 * Reusable E6 repository conformance runner for database/file adapters. It throws
 * on contract violations and intentionally depends on no test framework.
 */
export async function runAgentSessionRepositoryContract<
  TPrincipal extends AgentPrincipal,
>(adapter: AgentRepositoryContractAdapter<TPrincipal>): Promise<void> {
  const now = adapter.now ?? Date.now;
  const sessionId = adapter.createSessionId("session");
  const record = session(adapter.principal, sessionId, now());
  const created = await adapter.repository.createSession({ record });
  assert(created.ok, "repository must create a new scoped session");
  assert(
    !(await adapter.repository.createSession({ record })).ok,
    "repository must reject duplicate creation",
  );
  const read = await adapter.repository.readSession({
    principal: adapter.principal,
    sessionId,
  });
  assert(read.ok, "repository must read its created session");
  if (!read.ok) return;
  (read.record.messages as Array<{ role: "user"; content: string }>).push({
    role: "user",
    content: "mutated clone",
  });
  const reread = await adapter.repository.readSession({
    principal: adapter.principal,
    sessionId,
  });
  assert(
    reread.ok && reread.record.messages.length === 0,
    "repository reads must be clone-safe",
  );
  const isolated = await adapter.repository.readSession({
    principal: adapter.otherPrincipal,
    sessionId,
  });
  assert(!isolated.ok, "repository must isolate identical IDs by principal");
  const listed = await adapter.repository.listSessions({
    principal: adapter.principal,
  });
  assert(
    listed.some((entry) => entry.sessionId === sessionId),
    "repository list must include the principal's session",
  );
  const otherListed = await adapter.repository.listSessions({
    principal: adapter.otherPrincipal,
  });
  assert(
    !otherListed.some((entry) => entry.sessionId === sessionId),
    "repository list must isolate principals",
  );

  const updated: AgentSessionRecord<TPrincipal> = {
    ...read.record,
    updatedAt: read.record.updatedAt + 1,
    messages: [{ role: "user", content: "saved" }],
  };
  const saved = await adapter.repository.saveSession({
    record: updated,
    expectedRevision: read.revision,
  });
  assert(saved.ok, "repository must save at the current revision");
  const stale = await adapter.repository.saveSession({
    record: updated,
    expectedRevision: read.revision,
  });
  assert(
    !stale.ok && stale.reason === "revision_conflict",
    "repository must reject stale revisions",
  );
  if (!saved.ok) return;
  const fenced = await adapter.repository.saveSession({
    record: { ...updated, updatedAt: updated.updatedAt + 1 },
    expectedRevision: saved.revision,
    fencingToken: "2",
  });
  assert(fenced.ok, "repository must accept a current fencing token");
  if (!fenced.ok) return;
  const staleFence = await adapter.repository.saveSession({
    record: { ...updated, updatedAt: updated.updatedAt + 2 },
    expectedRevision: fenced.revision,
    fencingToken: "1",
  });
  assert(
    !staleFence.ok && staleFence.reason === "stale_fence",
    "repository must reject a stale fencing token",
  );
  const fencedRead = await adapter.repository.readSession({
    principal: adapter.principal,
    sessionId,
  });
  assert(
    fencedRead.ok && fencedRead.fencingToken === "2",
    "repository read must return the latest fencing token",
  );
  const deleted = await adapter.repository.deleteSession({
    principal: adapter.principal,
    sessionId,
    expectedRevision: fenced.revision,
    fencingToken: "2",
  });
  assert(
    deleted.ok,
    "repository must delete at the current revision and fence",
  );
  const saveDeleted = await adapter.repository.saveSession({
    record: updated,
    expectedRevision: fenced.revision,
    fencingToken: "2",
  });
  assert(
    !saveDeleted.ok && saveDeleted.reason === "not_found",
    "repository must report not_found after deletion",
  );
}

/** Reusable distributed lease conformance runner for Redis/database adapters. */
export async function runAgentTurnLeaseProviderContract<
  TPrincipal extends AgentPrincipal,
>(adapter: AgentTurnLeaseContractAdapter<TPrincipal>): Promise<void> {
  const sessionId = adapter.createSessionId("lease-session");
  const first = await adapter.provider.acquireTurnLease({
    principal: adapter.principal,
    sessionId,
    turnId: "turn-1",
    ownerId: "owner-1",
    ttlMs: 100,
  });
  assert(first.ok, "lease provider must acquire an available session");
  if (!first.ok) return;
  const held = await adapter.provider.acquireTurnLease({
    principal: adapter.principal,
    sessionId,
    turnId: "turn-2",
    ownerId: "owner-2",
    ttlMs: 100,
  });
  assert(
    !held.ok && held.reason === "held",
    "lease provider must exclude a concurrent owner",
  );
  const isolated = await adapter.provider.acquireTurnLease({
    principal: adapter.otherPrincipal,
    sessionId,
    turnId: "turn-other",
    ownerId: "owner-other",
    ttlMs: 100,
  });
  assert(isolated.ok, "lease provider must isolate the same ID by principal");
  if (isolated.ok) await release(adapter.provider, isolated.lease);

  await adapter.advanceTime(100);
  const takeover = await adapter.provider.acquireTurnLease({
    principal: adapter.principal,
    sessionId,
    turnId: "turn-2",
    ownerId: "owner-2",
    ttlMs: 100,
  });
  assert(takeover.ok, "lease provider must permit takeover after expiry");
  if (!takeover.ok) return;
  assert(
    BigInt(takeover.lease.fencingToken) > BigInt(first.lease.fencingToken),
    "takeover must issue a strictly newer fencing token",
  );
  const stale = await adapter.provider.validateTurnLease({
    principal: first.lease.principal,
    sessionId: first.lease.sessionId,
    leaseId: first.lease.leaseId,
    ownerId: first.lease.ownerId,
    fencingToken: first.lease.fencingToken,
  });
  assert(!stale.ok, "expired holder must not validate after takeover");
  const renewed = await adapter.provider.renewTurnLease({
    principal: takeover.lease.principal,
    sessionId: takeover.lease.sessionId,
    leaseId: takeover.lease.leaseId,
    ownerId: takeover.lease.ownerId,
    fencingToken: takeover.lease.fencingToken,
    ttlMs: 100,
  });
  assert(renewed.ok, "current lease holder must renew atomically");
  await release(adapter.provider, takeover.lease);
  const reacquired = await adapter.provider.acquireTurnLease({
    principal: adapter.principal,
    sessionId,
    turnId: "turn-3",
    ownerId: "owner-3",
    ttlMs: 100,
  });
  assert(reacquired.ok, "lease provider must reacquire after explicit release");
  if (!reacquired.ok) return;
  assertDecimalFence(reacquired.lease.fencingToken);
  assert(
    BigInt(reacquired.lease.fencingToken) > BigInt(takeover.lease.fencingToken),
    "release/reacquire must issue a strictly newer fencing token",
  );
  await release(adapter.provider, reacquired.lease);
}

function session<TPrincipal extends AgentPrincipal>(
  principal: TPrincipal,
  sessionId: string,
  timestamp: number,
): AgentSessionRecord<TPrincipal> {
  return {
    schemaVersion: 1,
    principal: structuredClone(principal),
    sessionId,
    createdAt: timestamp,
    updatedAt: timestamp,
    messages: [],
    runState: { phase: "idle" },
  };
}

async function release<TPrincipal extends AgentPrincipal>(
  provider: AgentTurnLeaseProvider<TPrincipal>,
  lease: {
    readonly principal: TPrincipal;
    readonly sessionId: string;
    readonly leaseId: string;
    readonly ownerId: string;
    readonly fencingToken: string;
  },
): Promise<void> {
  await provider.releaseTurnLease(lease);
}

function assertDecimalFence(token: string): void {
  assert(
    /^[1-9][0-9]*$/.test(token),
    "lease fencing tokens must be positive decimal integers",
  );
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition)
    throw new Error(`Agent host-adapter contract failed: ${message}`);
}
