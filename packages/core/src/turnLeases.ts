import type { AgentPrincipal } from "./modelIdentity.js";
import { randomUUID } from "node:crypto";

/** Positive base-10 integer; counters must remain monotonic per principal/session. */
export type TurnFencingToken = string;

export interface AgentTurnLease<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
> {
  readonly leaseId: string;
  readonly principal: TPrincipal;
  readonly sessionId: string;
  readonly turnId: string;
  readonly ownerId: string;
  readonly fencingToken: TurnFencingToken;
  readonly acquiredAt: number;
  readonly expiresAt: number;
}

export type AcquireAgentTurnLeaseResult<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
> =
  | { readonly ok: true; readonly lease: AgentTurnLease<TPrincipal> }
  | {
      readonly ok: false;
      readonly reason: "held";
      readonly holder: {
        readonly ownerId: string;
        readonly turnId: string;
        readonly expiresAt: number;
      };
    };

export type RenewAgentTurnLeaseResult<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
> =
  | { readonly ok: true; readonly lease: AgentTurnLease<TPrincipal> }
  | { readonly ok: false; readonly reason: "not_found" | "lost" | "expired" };

export type ReleaseAgentTurnLeaseResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "not_found" | "lost" };

export type ValidateAgentTurnLeaseResult =
  | { readonly ok: true; readonly expiresAt: number }
  | { readonly ok: false; readonly reason: "not_found" | "lost" | "expired" };

/**
 * Distributed implementations must make acquire/renew/release atomic per session.
 * The positive-decimal fencing counter must survive release and remain strictly
 * monotonic independently of whether a live lease record currently exists.
 */
export interface AgentTurnLeaseProvider<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
> {
  acquireTurnLease(request: {
    readonly principal: TPrincipal;
    readonly sessionId: string;
    readonly turnId: string;
    readonly ownerId: string;
    readonly ttlMs: number;
  }): Promise<AcquireAgentTurnLeaseResult<TPrincipal>>;
  renewTurnLease(request: {
    readonly principal: TPrincipal;
    readonly sessionId: string;
    readonly leaseId: string;
    readonly ownerId: string;
    readonly fencingToken: TurnFencingToken;
    readonly ttlMs: number;
  }): Promise<RenewAgentTurnLeaseResult<TPrincipal>>;
  releaseTurnLease(request: {
    readonly principal: TPrincipal;
    readonly sessionId: string;
    readonly leaseId: string;
    readonly ownerId: string;
    readonly fencingToken: TurnFencingToken;
  }): Promise<ReleaseAgentTurnLeaseResult>;
  validateTurnLease(request: {
    readonly principal: TPrincipal;
    readonly sessionId: string;
    readonly leaseId: string;
    readonly ownerId: string;
    readonly fencingToken: TurnFencingToken;
  }): Promise<ValidateAgentTurnLeaseResult>;
}

interface StoredLease<TPrincipal extends AgentPrincipal> {
  lease: AgentTurnLease<TPrincipal>;
}

/** Deterministic test adapter; multiple engine instances may share one instance. */
export class InMemoryAgentTurnLeaseProvider<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
> implements AgentTurnLeaseProvider<TPrincipal> {
  private readonly leases = new Map<string, StoredLease<TPrincipal>>();
  private readonly nextFencingToken = new Map<string, bigint>();
  private readonly now: () => number;
  private readonly createLeaseId: () => string;

  constructor(
    options: {
      readonly now?: () => number;
      readonly createLeaseId?: () => string;
    } = {},
  ) {
    this.now = options.now ?? Date.now;
    this.createLeaseId = options.createLeaseId ?? randomUUID;
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
    const now = readClock(this.now);
    const key = sessionScopeKey(request.principal, request.sessionId);
    const current = this.leases.get(key)?.lease;
    if (current && now < current.expiresAt) {
      return {
        ok: false,
        reason: "held",
        holder: {
          ownerId: current.ownerId,
          turnId: current.turnId,
          expiresAt: current.expiresAt,
        },
      };
    }

    const next = (this.nextFencingToken.get(key) ?? 0n) + 1n;
    this.nextFencingToken.set(key, next);
    const lease: AgentTurnLease<TPrincipal> = Object.freeze({
      leaseId: requiredText(this.createLeaseId(), "leaseId"),
      principal: structuredClone(request.principal),
      sessionId: request.sessionId,
      turnId: request.turnId,
      ownerId: request.ownerId,
      fencingToken: next.toString(10),
      acquiredAt: now,
      expiresAt: safeExpiry(now, ttlMs),
    });
    this.leases.set(key, { lease });
    return { ok: true, lease: structuredClone(lease) };
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
    const now = readClock(this.now);
    const key = sessionScopeKey(request.principal, request.sessionId);
    const current = this.leases.get(key)?.lease;
    if (!current) return { ok: false, reason: "not_found" };
    if (!sameLease(current, request)) return { ok: false, reason: "lost" };
    if (now >= current.expiresAt) return { ok: false, reason: "expired" };

    const lease: AgentTurnLease<TPrincipal> = Object.freeze({
      ...current,
      expiresAt: safeExpiry(now, ttlMs),
    });
    this.leases.set(key, { lease });
    return { ok: true, lease: structuredClone(lease) };
  }

  async releaseTurnLease(request: {
    readonly principal: TPrincipal;
    readonly sessionId: string;
    readonly leaseId: string;
    readonly ownerId: string;
    readonly fencingToken: TurnFencingToken;
  }): Promise<ReleaseAgentTurnLeaseResult> {
    validateLeaseIdentity(request);
    const key = sessionScopeKey(request.principal, request.sessionId);
    const current = this.leases.get(key)?.lease;
    if (!current) return { ok: false, reason: "not_found" };
    if (!sameLease(current, request)) return { ok: false, reason: "lost" };
    this.leases.delete(key);
    return { ok: true };
  }

  async validateTurnLease(request: {
    readonly principal: TPrincipal;
    readonly sessionId: string;
    readonly leaseId: string;
    readonly ownerId: string;
    readonly fencingToken: TurnFencingToken;
  }): Promise<ValidateAgentTurnLeaseResult> {
    validateLeaseIdentity(request);
    const key = sessionScopeKey(request.principal, request.sessionId);
    const current = this.leases.get(key)?.lease;
    if (!current) return { ok: false, reason: "not_found" };
    if (!sameLease(current, request)) return { ok: false, reason: "lost" };
    if (readClock(this.now) >= current.expiresAt) {
      return { ok: false, reason: "expired" };
    }
    return { ok: true, expiresAt: current.expiresAt };
  }
}

export function compareTurnFencingTokens(
  first: TurnFencingToken,
  second: TurnFencingToken,
): -1 | 0 | 1 {
  const left = parseFencingToken(first);
  const right = parseFencingToken(second);
  return left < right ? -1 : left > right ? 1 : 0;
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

function validateLeaseScope(request: {
  readonly principal: AgentPrincipal;
  readonly sessionId: string;
  readonly turnId: string;
  readonly ownerId: string;
}): void {
  validatePrincipal(request.principal);
  requiredText(request.sessionId, "sessionId");
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
  validatePrincipal(request.principal);
  requiredText(request.sessionId, "sessionId");
  requiredText(request.leaseId, "leaseId");
  requiredText(request.ownerId, "ownerId");
  parseFencingToken(request.fencingToken);
}

function validatePrincipal(principal: AgentPrincipal): void {
  requiredText(principal.tenantId, "principal.tenantId");
  requiredText(principal.subjectId, "principal.subjectId");
}

function sessionScopeKey(principal: AgentPrincipal, sessionId: string): string {
  return JSON.stringify([principal.tenantId, principal.subjectId, sessionId]);
}

function parseFencingToken(token: TurnFencingToken): bigint {
  if (!/^[1-9][0-9]*$/.test(token)) {
    throw new Error("Turn fencing token must be a positive decimal integer");
  }
  return BigInt(token);
}

function safeExpiry(now: number, ttlMs: number): number {
  const expiresAt = now + ttlMs;
  if (!Number.isSafeInteger(expiresAt)) {
    throw new Error("Turn lease expiry exceeds the safe integer range");
  }
  return expiresAt;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function requiredText(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`Turn lease ${field} must not be empty`);
  return trimmed;
}

function readClock(now: () => number): number {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Turn lease clock must return a non-negative integer");
  }
  return value;
}
