import {
  BROWSER_GATEWAY_CLIENT_ORIGIN_HEADER,
  BROWSER_GATEWAY_HELPER_SECRET_HEADER,
  applyBrowserGatewayMcpClientCapabilities,
  buildBrowserGatewayHelperTrustHeaders,
  classifyBrowserGatewayClientOrigin,
  hasBrowserGatewayMcpSecretWrite,
  verifyBrowserGatewayHelperTrust,
} from "./browserGatewayRequestTrust.js";
import { describe, expect, it } from "vitest";

describe("browserGatewayRequestTrust", () => {
  it.each([
    "127.0.0.1",
    "127.42.0.1",
    "::1",
    "::ffff:127.0.0.1",
    "::FFFF:127.0.0.1",
  ])("classifies %s as loopback", (address) => {
    expect(classifyBrowserGatewayClientOrigin(address)).toBe("loopback");
  });

  it.each([undefined, "", "192.168.1.10", "10.0.0.2", "fe80::1", "invalid"])(
    "classifies %s as non-loopback",
    (address) => {
      expect(classifyBrowserGatewayClientOrigin(address)).toBe("non-loopback");
    },
  );

  it("projects non-loopback MCP write capabilities without mutating the response", () => {
    const response = {
      ok: true,
      configSnapshot: {
        profile: "ask-agent",
        capabilities: {
          canEditConfig: true,
          canWriteSecrets: true,
          canConfigureLocalProcess: true,
        },
      },
    };

    expect(
      applyBrowserGatewayMcpClientCapabilities(response, "non-loopback"),
    ).toEqual({
      ok: true,
      configSnapshot: {
        profile: "ask-agent",
        capabilities: {
          canEditConfig: true,
          canWriteSecrets: false,
          canConfigureLocalProcess: false,
        },
      },
    });
    expect(response.configSnapshot.capabilities).toMatchObject({
      canWriteSecrets: true,
      canConfigureLocalProcess: true,
    });
    expect(applyBrowserGatewayMcpClientCapabilities(response, "loopback")).toBe(
      response,
    );
  });

  it("distinguishes preserve-only MCP secret metadata from secret mutations", () => {
    expect(
      hasBrowserGatewayMcpSecretWrite({
        type: "http",
        env: { mode: "preserve" },
        headers: { mode: "preserve" },
      }),
    ).toBe(false);
    expect(
      hasBrowserGatewayMcpSecretWrite({
        type: "http",
        headers: { mode: "patch", set: { Authorization: "secret" } },
      }),
    ).toBe(true);
    expect(
      hasBrowserGatewayMcpSecretWrite({
        type: "http",
        env: { mode: "remove" },
      }),
    ).toBe(true);
    expect(hasBrowserGatewayMcpSecretWrite({ type: "http", env: {} })).toBe(
      true,
    );
  });

  it("accepts helper-built trust headers with the expected secret", () => {
    const headers = buildBrowserGatewayHelperTrustHeaders(
      "shared-secret",
      "loopback",
    );

    expect(verifyBrowserGatewayHelperTrust(headers, "shared-secret")).toBe(
      "loopback",
    );
  });

  it("rejects missing, forged, or malformed trust headers", () => {
    expect(verifyBrowserGatewayHelperTrust({}, "shared-secret")).toBeNull();
    expect(
      verifyBrowserGatewayHelperTrust(
        {
          [BROWSER_GATEWAY_HELPER_SECRET_HEADER]: "forged",
          [BROWSER_GATEWAY_CLIENT_ORIGIN_HEADER]: "loopback",
        },
        "shared-secret",
      ),
    ).toBeNull();
    expect(
      verifyBrowserGatewayHelperTrust(
        {
          [BROWSER_GATEWAY_HELPER_SECRET_HEADER]: "shared-secret",
          [BROWSER_GATEWAY_CLIENT_ORIGIN_HEADER]: "trusted-lan",
        },
        "shared-secret",
      ),
    ).toBeNull();
    expect(
      verifyBrowserGatewayHelperTrust(
        buildBrowserGatewayHelperTrustHeaders("shared-secret", "loopback"),
        null,
      ),
    ).toBeNull();
  });
});
