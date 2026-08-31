import {
  BROWSER_GATEWAY_ASK_AGENT_OWNER_GENERATION_ID,
  BROWSER_GATEWAY_ASK_AGENT_OWNER_ID,
  BROWSER_GATEWAY_ASK_AGENT_SCOPE_ID,
  BROWSER_GATEWAY_ASK_AGENT_SESSION_ID,
  BROWSER_GATEWAY_ASK_AGENT_SESSION_ID_PREFIX,
  isBrowserGatewayAskAgentSessionId,
} from "./browserGatewayAskAgentIdentity.js";
import { describe, expect, it } from "vitest";

describe("browser gateway Ask Agent identity", () => {
  it("keeps the default wire identities in one namespace", () => {
    expect(BROWSER_GATEWAY_ASK_AGENT_OWNER_ID).toBe(
      "browser-gateway:ask-agent",
    );
    expect(BROWSER_GATEWAY_ASK_AGENT_SESSION_ID).toBe(
      `${BROWSER_GATEWAY_ASK_AGENT_SESSION_ID_PREFIX}default`,
    );
    expect(BROWSER_GATEWAY_ASK_AGENT_OWNER_GENERATION_ID).toBe(
      `${BROWSER_GATEWAY_ASK_AGENT_SESSION_ID_PREFIX}default-generation`,
    );
    expect(BROWSER_GATEWAY_ASK_AGENT_SCOPE_ID).toBe("default-ask-agent");
  });

  it("accepts client-minted session ids with bounded safe suffixes", () => {
    expect(
      isBrowserGatewayAskAgentSessionId(BROWSER_GATEWAY_ASK_AGENT_SESSION_ID),
    ).toBe(true);
    expect(
      isBrowserGatewayAskAgentSessionId(
        `${BROWSER_GATEWAY_ASK_AGENT_SESSION_ID_PREFIX}${"a".repeat(64)}`,
      ),
    ).toBe(true);
    expect(
      isBrowserGatewayAskAgentSessionId(
        `${BROWSER_GATEWAY_ASK_AGENT_SESSION_ID_PREFIX}chat-123`,
      ),
    ).toBe(true);
    // Preserve the existing shared namespace until a versioned wire change can
    // move owner-generation identities without breaking mixed-version clients.
    expect(
      isBrowserGatewayAskAgentSessionId(
        BROWSER_GATEWAY_ASK_AGENT_OWNER_GENERATION_ID,
      ),
    ).toBe(true);
  });

  it("rejects foreign, empty, oversized, and unsafe session ids", () => {
    for (const value of [
      "session-1",
      BROWSER_GATEWAY_ASK_AGENT_SESSION_ID_PREFIX,
      `${BROWSER_GATEWAY_ASK_AGENT_SESSION_ID_PREFIX}${"a".repeat(65)}`,
      `${BROWSER_GATEWAY_ASK_AGENT_SESSION_ID_PREFIX}has_underscore`,
      `${BROWSER_GATEWAY_ASK_AGENT_SESSION_ID_PREFIX}has/slash`,
    ]) {
      expect(isBrowserGatewayAskAgentSessionId(value), value).toBe(false);
    }
  });
});
