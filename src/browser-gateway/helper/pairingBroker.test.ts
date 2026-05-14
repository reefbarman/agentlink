import { describe, expect, it } from "vitest";

import { PairingBroker } from "./pairingBroker.js";

describe("PairingBroker", () => {
  it("generates a 6-digit numeric code and reports pending status", () => {
    const broker = new PairingBroker({ now: () => 1_000 });
    const pairing = broker.create();

    expect(pairing.code).toMatch(/^\d{6}$/);
    expect(pairing.pairingId).toMatch(/^[0-9a-f-]{36}$/);

    const status = broker.getStatus(pairing.pairingId);
    expect(status?.status).toBe("pending");
  });

  it("consumes a valid code once and retires terminal status", () => {
    let now = 1_000;
    const broker = new PairingBroker({ now: () => now });
    const pairing = broker.create();

    const ok = broker.attempt(pairing.code, "10.0.0.5");
    expect(ok).toEqual({
      ok: true,
      pairingId: pairing.pairingId,
      label: undefined,
    });

    // Second attempt with the same code fails — it's been consumed.
    const repeat = broker.attempt(pairing.code, "10.0.0.5");
    expect(repeat).toEqual({ ok: false, reason: "invalid_code" });

    broker.markConsumed(pairing.pairingId, "dev-1", "iPhone");
    const status = broker.getStatus(pairing.pairingId);
    expect(status?.status).toBe("consumed");
    expect(status?.deviceId).toBe("dev-1");
    expect(status?.deviceLabel).toBe("iPhone");

    // Fast-forward past terminal retention — status disappears.
    now = 1_000 + 10 * 60 * 1000;
    const gone = broker.getStatus(pairing.pairingId);
    expect(gone).toBeNull();
  });

  it("returns expired when time runs out before consume", () => {
    let now = 1_000;
    const broker = new PairingBroker({ ttlMs: 2_000, now: () => now });
    const pairing = broker.create();

    now += 5_000;

    const attempt = broker.attempt(pairing.code, "10.0.0.5");
    expect(attempt).toEqual({ ok: false, reason: "invalid_code" });

    const status = broker.getStatus(pairing.pairingId);
    expect(status?.status).toBe("expired");
  });

  it("rejects malformed codes without exposing active codes", () => {
    const broker = new PairingBroker();
    broker.create();
    expect(broker.attempt("", "1.1.1.1")).toEqual({
      ok: false,
      reason: "invalid_code",
    });
    expect(broker.attempt("abc", "1.1.1.1")).toEqual({
      ok: false,
      reason: "invalid_code",
    });
    expect(broker.attempt("1234567", "1.1.1.1")).toEqual({
      ok: false,
      reason: "invalid_code",
    });
  });

  it("rate-limits after repeated bad attempts from the same remote", () => {
    const broker = new PairingBroker({
      maxFailuresPerRemote: 3,
      failuresWindowMs: 60_000,
      now: () => 1_000,
    });
    broker.create();

    for (let i = 0; i < 3; i++) {
      const result = broker.attempt("000000", "10.0.0.9");
      expect(result).toEqual({ ok: false, reason: "invalid_code" });
    }

    const rateLimited = broker.attempt("000000", "10.0.0.9");
    expect(rateLimited).toEqual({ ok: false, reason: "rate_limited" });

    // Different remote is unaffected.
    const otherRemote = broker.attempt("000000", "10.0.0.10");
    expect(otherRemote).toEqual({ ok: false, reason: "invalid_code" });
  });

  it("cancel removes active pairings and reports cancelled", () => {
    const broker = new PairingBroker();
    const pairing = broker.create();
    expect(broker.cancel(pairing.pairingId)).toBe(true);

    const status = broker.getStatus(pairing.pairingId);
    expect(status?.status).toBe("cancelled");

    const attempt = broker.attempt(pairing.code, "10.0.0.5");
    expect(attempt).toEqual({ ok: false, reason: "invalid_code" });
  });
});
