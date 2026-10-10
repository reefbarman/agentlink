import {
  DEFAULT_ASSISTANT_ORIGIN,
  normalizeAssistantOrigin,
} from "./assistantAddress";
import { describe, expect, it } from "vitest";

describe("normalizeAssistantOrigin", () => {
  it("keeps only the HTTPS origin of an address", () => {
    expect(normalizeAssistantOrigin(DEFAULT_ASSISTANT_ORIGIN)).toBe(
      DEFAULT_ASSISTANT_ORIGIN,
    );
    expect(
      normalizeAssistantOrigin(" https://Framework16.local:8443/devices?x=1 "),
    ).toBe("https://framework16.local:8443");
    expect(normalizeAssistantOrigin("192.168.50.160:8443")).toBe(
      "https://192.168.50.160:8443",
    );
  });

  it("refuses plain HTTP, other schemes, credentials and junk", () => {
    for (const value of [
      "http://agentlink-assistant.local:8443",
      "javascript:alert(1)",
      "file:///etc/passwd",
      "https://user:pass@agentlink-assistant.local:8443",
      "",
      "   ",
      "https://",
      42,
      undefined,
    ]) {
      expect(normalizeAssistantOrigin(value)).toBeUndefined();
    }
  });
});
