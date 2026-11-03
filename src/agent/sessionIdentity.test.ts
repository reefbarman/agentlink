import {
  buildSessionIdentitySection,
  sessionIdentitiesEqual,
  shortSessionId,
} from "./sessionIdentity.js";
import { describe, expect, it } from "vitest";

const SESSION_ID = "1a2b3c4d-5e6f-7a8b-9c0d-ef1234567890";

describe("sessionIdentity", () => {
  it("shortens session ids to eight hex characters", () => {
    expect(shortSessionId(SESSION_ID)).toBe("1a2b3c4d");
  });

  it("renders foreground and background identity lines", () => {
    expect(
      buildSessionIdentitySection(SESSION_ID, {
        tabNumber: 2,
        background: false,
      }),
    ).toBe(
      "## Session Identity\n\nYou are AgentLink chat tab 2 (session `1a2b3c4d`).",
    );
    expect(
      buildSessionIdentitySection(SESSION_ID, {
        tabNumber: 2,
        background: true,
      }),
    ).toBe(
      "## Session Identity\n\nYou are a background agent (session `1a2b3c4d`) started from AgentLink chat tab 2.",
    );
  });

  it("does not mention coordination or messaging", () => {
    const text = buildSessionIdentitySection(SESSION_ID, {
      tabNumber: 1,
      background: false,
    });
    expect(text).not.toMatch(/messag|coordinat|agent-comms/i);
  });

  it("compares identities by value", () => {
    expect(
      sessionIdentitiesEqual(
        { tabNumber: 1, background: false },
        { tabNumber: 1, background: false },
      ),
    ).toBe(true);
    expect(
      sessionIdentitiesEqual({ tabNumber: 1, background: false }, undefined),
    ).toBe(false);
  });
});
