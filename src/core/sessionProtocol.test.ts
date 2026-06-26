import { describe, expect, it } from "vitest";

import {
  assertReplayEventsBelongToOwner,
  createProjectlessSessionOwner,
  CURRENT_CORE_SESSION_PROTOCOL_VERSION,
  isCapabilityEnabled,
  isProjectlessOwner,
  type CoreCapabilityStatusDto,
  type CoreSessionEventEnvelope,
} from "./sessionProtocol.js";

describe("core session protocol", () => {
  it("uses a string protocol version so compatibility tests can exercise unknown versions", () => {
    expect(CURRENT_CORE_SESSION_PROTOCOL_VERSION).toMatch(/^2026-06\.phase3\./);
    expect(typeof CURRENT_CORE_SESSION_PROTOCOL_VERSION).toBe("string");
  });

  it("creates projectless owners without surface-specific tab semantics", () => {
    const owner = createProjectlessSessionOwner({
      ownerId: "owner-1",
      ownerKind: "browser-gateway",
      displayName: "Gateway helper",
      scopeId: "global-ask",
      scopeDisplayName: "Global ask scope",
      now: 123,
      instanceId: "helper-1",
      processId: 456,
    });

    expect(owner).toEqual({
      ownerId: "owner-1",
      ownerKind: "browser-gateway",
      displayName: "Gateway helper",
      instanceId: "helper-1",
      processId: 456,
      scope: {
        kind: "projectless",
        scopeId: "global-ask",
        displayName: "Global ask scope",
      },
      acquiredAt: 123,
      lastHeartbeatAt: 123,
    });
    expect(isProjectlessOwner(owner)).toBe(true);
  });

  it("treats capability state as enabled only when explicitly enabled", () => {
    const capabilities: CoreCapabilityStatusDto[] = [
      { capabilityId: "local.read", state: "requires_approval" },
      { capabilityId: "model", state: "enabled" },
      { capabilityId: "local.write", state: "disabled" },
    ];

    expect(isCapabilityEnabled(capabilities, "model")).toBe(true);
    expect(isCapabilityEnabled(capabilities, "local.read")).toBe(false);
    expect(isCapabilityEnabled(capabilities, "local.write")).toBe(false);
    expect(isCapabilityEnabled(capabilities, "missing")).toBe(false);
  });

  it("guards replay against cross-owner event merging", () => {
    const events: CoreSessionEventEnvelope[] = [
      {
        protocolVersion: CURRENT_CORE_SESSION_PROTOCOL_VERSION,
        eventId: "event-1",
        ownerId: "owner-1",
        sequence: 1,
        kind: "session.state.updated",
        emittedAt: 100,
        payload: {},
      },
      {
        protocolVersion: CURRENT_CORE_SESSION_PROTOCOL_VERSION,
        eventId: "event-2",
        ownerId: "owner-2",
        sequence: 1,
        kind: "session.state.updated",
        emittedAt: 101,
        payload: {},
      },
    ];

    expect(() =>
      assertReplayEventsBelongToOwner("owner-1", [events[0]]),
    ).not.toThrow();
    expect(() => assertReplayEventsBelongToOwner("owner-1", events)).toThrow(
      "core_session_replay_owner_mismatch",
    );
  });
});
