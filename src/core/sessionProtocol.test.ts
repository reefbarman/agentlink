import * as legacySessionProtocol from "./sessionProtocol.js";

import { describe, expect, it } from "vitest";

const EXPECTED_RUNTIME_EXPORTS = [
  "CURRENT_CORE_SESSION_PROTOCOL_VERSION",
  "assertReplayEventsBelongToOwner",
  "createProjectlessSessionOwner",
  "isCapabilityEnabled",
  "isProjectlessOwner",
];

describe("core session protocol compatibility shim", () => {
  it("preserves the legacy runtime export contract", () => {
    expect(Object.keys(legacySessionProtocol).sort()).toEqual(
      EXPECTED_RUNTIME_EXPORTS,
    );
    expect(legacySessionProtocol.CURRENT_CORE_SESSION_PROTOCOL_VERSION).toBe(
      "2026-06.phase3.session.v1",
    );
    expect(
      legacySessionProtocol.createProjectlessSessionOwner({
        ownerId: "owner-1",
        ownerKind: "test",
        displayName: "Test owner",
        scopeId: "scope-1",
        scopeDisplayName: "Test scope",
        now: 42,
      }).scope,
    ).toEqual({
      kind: "projectless",
      scopeId: "scope-1",
      displayName: "Test scope",
    });
  });
});
