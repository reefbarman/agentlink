import {
  TurnInteractionTokenError,
  createTurnInteractionTokenService,
} from "./turnInteractions.js";
import { describe, expect, it } from "vitest";

const SECRET = "s".repeat(32);
const SCOPE = {
  interactionId: "interaction-1",
  interactionRevision: "interaction-revision-1",
  principal: { tenantId: "tenant-a", subjectId: "subject-a" },
  sessionId: "session-1",
  turnId: "turn-1",
  expectedSessionRevision: "session-revision-2",
  decision: "allow" as const,
};

describe("turn interaction response tokens", () => {
  it("issues and verifies a principal, turn, revision, and decision-bound token", () => {
    const tokens = createTurnInteractionTokenService({
      secret: SECRET,
      ttlMs: 1_000,
      now: () => 100,
      createResponseId: () => "response-1",
    });

    const token = tokens.issue(SCOPE);

    expect(tokens.verify({ token, ...SCOPE })).toEqual({
      schemaVersion: 1,
      responseId: "response-1",
      interactionId: "interaction-1",
      interactionRevision: "interaction-revision-1",
      tenantId: "tenant-a",
      subjectId: "subject-a",
      sessionId: "session-1",
      turnId: "turn-1",
      expectedSessionRevision: "session-revision-2",
      decision: "allow",
      issuedAt: 100,
      expiresAt: 1_100,
    });
  });

  it("rejects tampering, expiry, cross-principal use, and decision changes", () => {
    let now = 100;
    const tokens = createTurnInteractionTokenService({
      secret: SECRET,
      ttlMs: 10,
      now: () => now,
      createResponseId: () => "response-1",
    });
    const token = tokens.issue(SCOPE);

    expect(() => tokens.verify({ token: `${token}x`, ...SCOPE })).toThrowError(
      expect.objectContaining({ code: "interaction_token_invalid" }),
    );
    expect(() =>
      tokens.verify({
        token,
        ...SCOPE,
        principal: { tenantId: "tenant-a", subjectId: "subject-b" },
      }),
    ).toThrowError(
      expect.objectContaining({ code: "interaction_token_scope_mismatch" }),
    );
    expect(() =>
      tokens.verify({ token, ...SCOPE, decision: "deny" }),
    ).toThrowError(
      expect.objectContaining({ code: "interaction_token_scope_mismatch" }),
    );

    now = 110;
    expect(() => tokens.verify({ token, ...SCOPE })).toThrowError(
      expect.objectContaining({ code: "interaction_token_expired" }),
    );
  });

  it("requires a high-entropy secret and bounded positive ttl", () => {
    expect(() =>
      createTurnInteractionTokenService({ secret: "short" }),
    ).toThrow("at least 32 bytes");
    expect(() =>
      createTurnInteractionTokenService({ secret: SECRET, ttlMs: 0 }),
    ).toThrow("ttlMs must be a positive integer");
    expect(
      new TurnInteractionTokenError("interaction_token_invalid", "bad"),
    ).toMatchObject({ retryable: false, code: "interaction_token_invalid" });
  });
});
