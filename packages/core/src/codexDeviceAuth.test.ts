import {
  CODEX_DEVICE_AUTH,
  CodexDeviceAuthError,
  buildCodexDevicePollRequest,
  buildCodexDeviceTokenExchange,
  buildCodexDeviceUserCodeRequest,
  checkCodexDeviceAuthActive,
  parseCodexDeviceAuthChallenge,
  parseCodexDevicePollResponse,
} from "./codexDeviceAuth.js";
import { describe, expect, it } from "vitest";

describe("Codex device authentication protocol", () => {
  it("parses aliases and the official string interval without returning tokens", () => {
    const challenge = parseCodexDeviceAuthChallenge(
      { device_auth_id: "private", usercode: "ABCD-1234", interval: "5" },
      1000,
    );
    expect(challenge).toEqual({
      deviceAuthId: "private",
      userCode: "ABCD-1234",
      verificationUrl: CODEX_DEVICE_AUTH.verificationUrl,
      intervalMs: 5000,
      expiresAt: 901000,
    });
    expect(buildCodexDeviceUserCodeRequest()).toEqual({
      client_id: CODEX_DEVICE_AUTH.clientId,
    });
    expect(buildCodexDevicePollRequest(challenge)).toEqual({
      device_auth_id: "private",
      user_code: "ABCD-1234",
    });
  });
  it.each(["bad", "Infinity", -1, 61, {}, true])(
    "rejects invalid interval %s",
    (interval) => {
      expect(() =>
        parseCodexDeviceAuthChallenge({
          device_auth_id: "fixture",
          user_code: "CODE",
          interval,
        }),
      ).toThrow(CodexDeviceAuthError);
    },
  );
  it("clamps a zero interval and requires bounded nonempty fields", () => {
    expect(
      parseCodexDeviceAuthChallenge({
        device_auth_id: "fixture",
        user_code: "CODE",
        interval: "0",
      }).intervalMs,
    ).toBe(1000);
    expect(() =>
      parseCodexDeviceAuthChallenge({ device_auth_id: "", user_code: "CODE" }),
    ).toThrow();
    expect(() =>
      parseCodexDeviceAuthChallenge({
        device_auth_id: "fixture",
        user_code: "x".repeat(33),
      }),
    ).toThrow();
  });
  it("classifies official 403/404 polling as pending, not a generic OAuth grant", () => {
    expect(parseCodexDevicePollResponse(403, {})).toEqual({
      status: "pending",
    });
    expect(parseCodexDevicePollResponse(404, {})).toEqual({
      status: "pending",
    });
    expect(() =>
      parseCodexDevicePollResponse(400, { error: "private details" }),
    ).toThrow("denied");
    expect(() => parseCodexDevicePollResponse(500, {})).toThrow("unavailable");
    expect(() => parseCodexDevicePollResponse(Number.NaN, {})).toThrow(
      "invalid_response",
    );
    expect(() => parseCodexDevicePollResponse(200.5, {})).toThrow(
      "invalid_response",
    );
  });
  it("encodes the fixed token exchange and does not leak server error details", () => {
    const response = parseCodexDevicePollResponse(200, {
      authorization_code: "code+&",
      code_verifier: "verifier",
      code_challenge: "challenge",
    });
    if (response.status !== "authorized")
      throw new Error("Expected authorization");
    const form = buildCodexDeviceTokenExchange(response.authorization);
    expect(form.get("redirect_uri")).toBe(
      "https://auth.openai.com/deviceauth/callback",
    );
    expect(form.toString()).toContain("code=code%2B%26");
    expect(() =>
      parseCodexDevicePollResponse(200, { access_token: "private" }),
    ).toThrow("invalid_response");
  });
  it("checks cancellation before expiry and rejects expired challenges", () => {
    const challenge = parseCodexDeviceAuthChallenge(
      { device_auth_id: "fixture", user_code: "CODE" },
      0,
    );
    const controller = new AbortController();
    controller.abort();
    expect(() =>
      checkCodexDeviceAuthActive(challenge, {
        now: 0,
        signal: controller.signal,
      }),
    ).toThrow("cancelled");
    expect(() =>
      checkCodexDeviceAuthActive(challenge, { now: 900000 }),
    ).toThrow("expired");
  });
});
