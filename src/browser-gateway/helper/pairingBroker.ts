import { randomInt, randomUUID, timingSafeEqual } from "crypto";

import type {
  BrowserGatewayPairingStatusKind,
  BrowserGatewayPairingStatusResponse,
} from "../protocol.js";

export interface PairingCreateOptions {
  /** Optional label applied to the device when the code is consumed. */
  label?: string;
}

export interface PendingPairing {
  pairingId: string;
  code: string;
  expiresAt: number;
  attemptsRemaining: number;
  label?: string;
  terminalStatus?: BrowserGatewayPairingStatusKind;
  terminalDeviceId?: string;
  terminalDeviceLabel?: string;
}

export type ConsumeResult =
  | { ok: true; pairingId: string; label?: string }
  | {
      ok: false;
      reason: "rate_limited" | "invalid_code" | "expired" | "no_pending";
      attemptsRemaining?: number;
    };

export interface PairingBrokerOptions {
  /** Default 2 minutes. */
  ttlMs?: number;
  /** Default 5. */
  maxAttemptsPerCode?: number;
  /** Default 5 failures per 10 minutes per remote. */
  maxFailuresPerRemote?: number;
  failuresWindowMs?: number;
  /**
   * How long to retain terminal status (consumed / expired / cancelled) so the
   * extension can poll and observe the final state. Default 60s.
   */
  terminalRetentionMs?: number;
  now?: () => number;
}

const DEFAULT_TTL_MS = 2 * 60 * 1000;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_MAX_FAILURES_PER_REMOTE = 5;
const DEFAULT_FAILURES_WINDOW_MS = 10 * 60 * 1000;
const DEFAULT_TERMINAL_RETENTION_MS = 60 * 1000;

/**
 * Generates a zero-padded 6-digit code using cryptographic randomness.
 * 1,000,000 possible values is sufficient given:
 *   - 2-minute TTL,
 *   - 5 attempts per code,
 *   - 5 failures per remote IP per 10 minutes.
 */
function generateCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const aBuf = Buffer.from(a, "utf-8");
  const bBuf = Buffer.from(b, "utf-8");
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

export class PairingBroker {
  private readonly ttlMs: number;
  private readonly maxAttemptsPerCode: number;
  private readonly maxFailuresPerRemote: number;
  private readonly failuresWindowMs: number;
  private readonly terminalRetentionMs: number;
  private readonly now: () => number;

  private readonly active = new Map<string, PendingPairing>();
  private readonly terminal = new Map<
    string,
    PendingPairing & { retainUntil: number }
  >();
  private readonly remoteFailures = new Map<string, number[]>();

  constructor(options: PairingBrokerOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.maxAttemptsPerCode = options.maxAttemptsPerCode ?? DEFAULT_MAX_ATTEMPTS;
    this.maxFailuresPerRemote =
      options.maxFailuresPerRemote ?? DEFAULT_MAX_FAILURES_PER_REMOTE;
    this.failuresWindowMs =
      options.failuresWindowMs ?? DEFAULT_FAILURES_WINDOW_MS;
    this.terminalRetentionMs =
      options.terminalRetentionMs ?? DEFAULT_TERMINAL_RETENTION_MS;
    this.now = options.now ?? (() => Date.now());
  }

  create(options: PairingCreateOptions = {}): PendingPairing {
    this.pruneExpired();
    const now = this.now();
    const pairing: PendingPairing = {
      pairingId: randomUUID(),
      code: generateCode(),
      expiresAt: now + this.ttlMs,
      attemptsRemaining: this.maxAttemptsPerCode,
      label: options.label,
    };
    this.active.set(pairing.pairingId, pairing);
    return pairing;
  }

  cancel(pairingId: string): boolean {
    const entry = this.active.get(pairingId);
    if (!entry) return false;
    this.active.delete(pairingId);
    this.retire(entry, "cancelled");
    return true;
  }

  attempt(code: string, remoteAddress: string): ConsumeResult {
    this.pruneExpired();

    if (this.isRemoteRateLimited(remoteAddress)) {
      return { ok: false, reason: "rate_limited" };
    }

    const trimmed = code.trim();
    if (!/^\d{6}$/.test(trimmed)) {
      this.recordFailure(remoteAddress);
      return { ok: false, reason: "invalid_code" };
    }

    let matched: PendingPairing | null = null;
    for (const entry of this.active.values()) {
      if (constantTimeEqual(entry.code, trimmed)) {
        matched = entry;
        break;
      }
    }

    if (!matched) {
      this.recordFailure(remoteAddress);
      return { ok: false, reason: "invalid_code" };
    }

    if (matched.expiresAt <= this.now()) {
      this.active.delete(matched.pairingId);
      this.retire(matched, "expired");
      return { ok: false, reason: "expired" };
    }

    matched.attemptsRemaining -= 1;
    if (matched.attemptsRemaining <= 0) {
      // Brute-force attempts exhausted — force-expire this code.
      this.active.delete(matched.pairingId);
      this.retire(matched, "expired");
      this.recordFailure(remoteAddress);
      return { ok: false, reason: "expired" };
    }

    // Success: remove from active and return details. The caller is
    // responsible for calling `markConsumed` once the device record has
    // actually been persisted so status polling reports it correctly.
    this.active.delete(matched.pairingId);
    return {
      ok: true,
      pairingId: matched.pairingId,
      label: matched.label,
    };
  }

  markConsumed(
    pairingId: string,
    deviceId: string,
    deviceLabel: string,
  ): void {
    this.retire(
      {
        pairingId,
        code: "",
        expiresAt: this.now(),
        attemptsRemaining: 0,
      },
      "consumed",
      { deviceId, deviceLabel },
    );
  }

  getStatus(pairingId: string): BrowserGatewayPairingStatusResponse | null {
    this.pruneExpired();
    const active = this.active.get(pairingId);
    if (active) {
      return {
        pairingId,
        status: "pending",
        expiresAt: new Date(active.expiresAt).toISOString(),
      };
    }
    const done = this.terminal.get(pairingId);
    if (done) {
      return {
        pairingId,
        status: done.terminalStatus ?? "expired",
        deviceId: done.terminalDeviceId,
        deviceLabel: done.terminalDeviceLabel,
        expiresAt: new Date(done.expiresAt).toISOString(),
      };
    }
    return null;
  }

  /** Test / introspection helper — returns the active pending pairing, if any. */
  peekActive(pairingId: string): PendingPairing | null {
    return this.active.get(pairingId) ?? null;
  }

  private retire(
    entry: PendingPairing,
    status: BrowserGatewayPairingStatusKind,
    opts: { deviceId?: string; deviceLabel?: string } = {},
  ): void {
    this.terminal.set(entry.pairingId, {
      ...entry,
      terminalStatus: status,
      terminalDeviceId: opts.deviceId,
      terminalDeviceLabel: opts.deviceLabel,
      retainUntil: this.now() + this.terminalRetentionMs,
    });
  }

  private pruneExpired(): void {
    const now = this.now();
    for (const [id, entry] of this.active) {
      if (entry.expiresAt <= now) {
        this.active.delete(id);
        this.retire(entry, "expired");
      }
    }
    for (const [id, entry] of this.terminal) {
      if (entry.retainUntil <= now) {
        this.terminal.delete(id);
      }
    }
    for (const [remote, failures] of this.remoteFailures) {
      const cutoff = now - this.failuresWindowMs;
      const filtered = failures.filter((ts) => ts > cutoff);
      if (filtered.length === 0) {
        this.remoteFailures.delete(remote);
      } else if (filtered.length !== failures.length) {
        this.remoteFailures.set(remote, filtered);
      }
    }
  }

  private isRemoteRateLimited(remoteAddress: string): boolean {
    const failures = this.remoteFailures.get(remoteAddress);
    if (!failures) return false;
    const cutoff = this.now() - this.failuresWindowMs;
    const recent = failures.filter((ts) => ts > cutoff);
    if (recent.length !== failures.length) {
      this.remoteFailures.set(remoteAddress, recent);
    }
    return recent.length >= this.maxFailuresPerRemote;
  }

  private recordFailure(remoteAddress: string): void {
    const existing = this.remoteFailures.get(remoteAddress) ?? [];
    existing.push(this.now());
    this.remoteFailures.set(remoteAddress, existing);
  }
}
