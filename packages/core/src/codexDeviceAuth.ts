/** Codex-specific device-auth protocol. Hosts own HTTP, polling, token exchange and storage.
 * Private challenge/authorization fields must not be exposed to an untrusted renderer.
 * Verified against openai/codex codex-rs/login/src/device_code_auth.rs.
 */
export const CODEX_DEVICE_AUTH = Object.freeze({
  clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
  userCodeUrl: "https://auth.openai.com/api/accounts/deviceauth/usercode",
  pollUrl: "https://auth.openai.com/api/accounts/deviceauth/token",
  verificationUrl: "https://auth.openai.com/codex/device",
  tokenUrl: "https://auth.openai.com/oauth/token",
  redirectUri: "https://auth.openai.com/deviceauth/callback",
  expiresAfterMs: 15 * 60 * 1000,
});
export type CodexDeviceAuthFailure =
  | "invalid_response"
  | "cancelled"
  | "expired"
  | "denied"
  | "unavailable";
export class CodexDeviceAuthError extends Error {
  constructor(readonly code: CodexDeviceAuthFailure) {
    super(`Codex device sign-in: ${code}`);
    this.name = "CodexDeviceAuthError";
  }
}
export interface CodexDeviceAuthChallenge {
  deviceAuthId: string;
  userCode: string;
  verificationUrl: string;
  intervalMs: number;
  expiresAt: number;
}
export interface CodexDeviceAuthorization {
  authorizationCode: string;
  codeVerifier: string;
  codeChallenge: string;
}
export function buildCodexDeviceUserCodeRequest(
  clientId: string = CODEX_DEVICE_AUTH.clientId,
): { client_id: string } {
  return { client_id: boundedString(clientId, 1024) };
}
export function parseCodexDeviceAuthChallenge(
  value: unknown,
  now: number = Date.now(),
): CodexDeviceAuthChallenge {
  const body = object(value);
  const raw = body.interval ?? "5";
  if (
    (typeof raw !== "string" && typeof raw !== "number") ||
    (typeof raw === "string" && !/^\d+$/.test(raw.trim()))
  ) {
    throw new CodexDeviceAuthError("invalid_response");
  }
  const seconds = Number(raw);
  if (
    !Number.isFinite(now) ||
    !Number.isFinite(seconds) ||
    seconds < 0 ||
    seconds > 60
  )
    throw new CodexDeviceAuthError("invalid_response");
  return {
    deviceAuthId: boundedString(body.device_auth_id, 1024),
    userCode: boundedString(body.user_code ?? body.usercode, 32),
    verificationUrl: CODEX_DEVICE_AUTH.verificationUrl,
    intervalMs: Math.max(1, seconds) * 1000,
    expiresAt: now + CODEX_DEVICE_AUTH.expiresAfterMs,
  };
}
export function checkCodexDeviceAuthActive(
  challenge: CodexDeviceAuthChallenge,
  options: { now?: number; signal?: AbortSignal } = {},
): void {
  if (options.signal?.aborted) throw new CodexDeviceAuthError("cancelled");
  if ((options.now ?? Date.now()) >= challenge.expiresAt)
    throw new CodexDeviceAuthError("expired");
}
export function buildCodexDevicePollRequest(
  challenge: CodexDeviceAuthChallenge,
): { device_auth_id: string; user_code: string } {
  return {
    device_auth_id: boundedString(challenge.deviceAuthId, 1024),
    user_code: boundedString(challenge.userCode, 32),
  };
}
export function parseCodexDevicePollResponse(
  status: number,
  value: unknown,
):
  | { status: "pending" }
  | { status: "authorized"; authorization: CodexDeviceAuthorization } {
  if (!Number.isInteger(status) || status < 100 || status > 599)
    throw new CodexDeviceAuthError("invalid_response");
  if (status === 403 || status === 404) return { status: "pending" };
  if (status < 200 || status >= 300)
    throw new CodexDeviceAuthError(
      status === 400 || status === 401 ? "denied" : "unavailable",
    );
  const body = object(value);
  return {
    status: "authorized",
    authorization: {
      authorizationCode: boundedString(body.authorization_code, 8192),
      codeVerifier: boundedString(body.code_verifier, 1024),
      codeChallenge: boundedString(body.code_challenge, 1024),
    },
  };
}
export function buildCodexDeviceTokenExchange(
  authorization: CodexDeviceAuthorization,
  clientId: string = CODEX_DEVICE_AUTH.clientId,
): URLSearchParams {
  return new URLSearchParams({
    grant_type: "authorization_code",
    client_id: boundedString(clientId, 1024),
    redirect_uri: CODEX_DEVICE_AUTH.redirectUri,
    code: boundedString(authorization.authorizationCode, 8192),
    code_verifier: boundedString(authorization.codeVerifier, 1024),
  });
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new CodexDeviceAuthError("invalid_response");
  return value as Record<string, unknown>;
}
function boundedString(value: unknown, max: number): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    new TextEncoder().encode(value).byteLength > max
  )
    throw new CodexDeviceAuthError("invalid_response");
  return value;
}
