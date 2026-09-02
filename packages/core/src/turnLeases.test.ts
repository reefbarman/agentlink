import {
  InMemoryAgentTurnLeaseProvider,
  compareTurnFencingTokens,
} from "./turnLeases.js";
import { describe, expect, it } from "vitest";

const PRINCIPAL = { tenantId: "tenant-a", subjectId: "subject-a" };

describe("in-memory turn leases", () => {
  it("excludes concurrent owners and issues monotonic fencing tokens after release", async () => {
    let leaseId = 0;
    const leases = new InMemoryAgentTurnLeaseProvider({
      now: () => 100,
      createLeaseId: () => `lease-${++leaseId}`,
    });
    const first = await leases.acquireTurnLease({
      principal: PRINCIPAL,
      sessionId: "session-1",
      turnId: "turn-1",
      ownerId: "owner-a",
      ttlMs: 1_000,
    });
    expect(first).toMatchObject({
      ok: true,
      lease: { leaseId: "lease-1", fencingToken: "1", expiresAt: 1_100 },
    });

    await expect(
      leases.acquireTurnLease({
        principal: PRINCIPAL,
        sessionId: "session-1",
        turnId: "turn-2",
        ownerId: "owner-b",
        ttlMs: 1_000,
      }),
    ).resolves.toMatchObject({
      ok: false,
      reason: "held",
      holder: { ownerId: "owner-a", turnId: "turn-1" },
    });

    if (!first.ok) throw new Error("expected first lease");
    await expect(
      leases.releaseTurnLease({
        principal: PRINCIPAL,
        sessionId: "session-1",
        leaseId: first.lease.leaseId,
        ownerId: first.lease.ownerId,
        fencingToken: first.lease.fencingToken,
      }),
    ).resolves.toEqual({ ok: true });
    const second = await leases.acquireTurnLease({
      principal: PRINCIPAL,
      sessionId: "session-1",
      turnId: "turn-2",
      ownerId: "owner-b",
      ttlMs: 1_000,
    });
    expect(second).toMatchObject({
      ok: true,
      lease: { leaseId: "lease-2", fencingToken: "2" },
    });
    if (!second.ok) throw new Error("expected second lease");
    expect(
      compareTurnFencingTokens(
        first.lease.fencingToken,
        second.lease.fencingToken,
      ),
    ).toBe(-1);
  });

  it("renews only the exact live lease and rejects stale holders after takeover", async () => {
    let now = 100;
    let leaseId = 0;
    const leases = new InMemoryAgentTurnLeaseProvider({
      now: () => now,
      createLeaseId: () => `lease-${++leaseId}`,
    });
    const first = await leases.acquireTurnLease({
      principal: PRINCIPAL,
      sessionId: "session-1",
      turnId: "turn-1",
      ownerId: "owner-a",
      ttlMs: 100,
    });
    if (!first.ok) throw new Error("expected first lease");
    now = 150;
    const renewed = await leases.renewTurnLease({
      principal: PRINCIPAL,
      sessionId: "session-1",
      leaseId: first.lease.leaseId,
      ownerId: first.lease.ownerId,
      fencingToken: first.lease.fencingToken,
      ttlMs: 200,
    });
    expect(renewed).toMatchObject({ ok: true, lease: { expiresAt: 350 } });

    now = 350;
    await expect(
      leases.validateTurnLease({
        principal: PRINCIPAL,
        sessionId: "session-1",
        leaseId: first.lease.leaseId,
        ownerId: first.lease.ownerId,
        fencingToken: first.lease.fencingToken,
      }),
    ).resolves.toEqual({ ok: false, reason: "expired" });
    const second = await leases.acquireTurnLease({
      principal: PRINCIPAL,
      sessionId: "session-1",
      turnId: "turn-2",
      ownerId: "owner-b",
      ttlMs: 100,
    });
    if (!second.ok) throw new Error("expected takeover lease");

    await expect(
      leases.releaseTurnLease({
        principal: PRINCIPAL,
        sessionId: "session-1",
        leaseId: first.lease.leaseId,
        ownerId: first.lease.ownerId,
        fencingToken: first.lease.fencingToken,
      }),
    ).resolves.toEqual({ ok: false, reason: "lost" });
    await expect(
      leases.validateTurnLease({
        principal: PRINCIPAL,
        sessionId: "session-1",
        leaseId: second.lease.leaseId,
        ownerId: second.lease.ownerId,
        fencingToken: second.lease.fencingToken,
      }),
    ).resolves.toEqual({ ok: true, expiresAt: 450 });
  });

  it("rejects expiry arithmetic outside the safe integer range", async () => {
    const leases = new InMemoryAgentTurnLeaseProvider({
      now: () => Number.MAX_SAFE_INTEGER,
      createLeaseId: () => "lease-overflow",
    });

    await expect(
      leases.acquireTurnLease({
        principal: PRINCIPAL,
        sessionId: "session-1",
        turnId: "turn-1",
        ownerId: "owner-a",
        ttlMs: 1,
      }),
    ).rejects.toThrow("expiry exceeds the safe integer range");
  });

  it("isolates identical session IDs across principals", async () => {
    let leaseId = 0;
    const leases = new InMemoryAgentTurnLeaseProvider({
      now: () => 100,
      createLeaseId: () => `lease-${++leaseId}`,
    });

    const [first, second] = await Promise.all([
      leases.acquireTurnLease({
        principal: PRINCIPAL,
        sessionId: "shared",
        turnId: "turn-a",
        ownerId: "owner-a",
        ttlMs: 100,
      }),
      leases.acquireTurnLease({
        principal: { tenantId: "tenant-b", subjectId: "subject-a" },
        sessionId: "shared",
        turnId: "turn-b",
        ownerId: "owner-b",
        ttlMs: 100,
      }),
    ]);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
  });
});
