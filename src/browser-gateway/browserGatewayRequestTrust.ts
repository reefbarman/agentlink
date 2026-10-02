import { timingSafeEqual } from "crypto";

export type BrowserGatewayClientOrigin = "loopback" | "non-loopback";

export const BROWSER_GATEWAY_HELPER_SECRET_HEADER =
  "x-agentlink-helper-shared-secret";
export const BROWSER_GATEWAY_CLIENT_ORIGIN_HEADER =
  "x-agentlink-browser-client-origin";

export function classifyBrowserGatewayClientOrigin(
  address: string | undefined,
): BrowserGatewayClientOrigin {
  if (!address) return "non-loopback";
  const normalized = address.toLowerCase().startsWith("::ffff:")
    ? address.slice(7)
    : address;
  return normalized === "::1" || normalized.startsWith("127.")
    ? "loopback"
    : "non-loopback";
}

function isPreserveOnlySecretMutation(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    (value as { mode?: unknown }).mode === "preserve"
  );
}

export function hasBrowserGatewayMcpSecretWrite(server: unknown): boolean {
  if (!server || typeof server !== "object" || Array.isArray(server))
    return false;
  const record = server as Record<string, unknown>;
  return ["env", "headers"].some(
    (field) =>
      Object.prototype.hasOwnProperty.call(record, field) &&
      !isPreserveOnlySecretMutation(record[field]),
  );
}

/** Remote edits must not carry stored credentials to a different endpoint. */
export function hasBrowserGatewayMcpCredentialRedirect(
  server: unknown,
  existing: {
    type?: string;
    url?: string;
    env?: Record<string, string>;
    headers?: Record<string, string>;
  },
): boolean {
  if (!server || typeof server !== "object" || Array.isArray(server))
    return false;
  if (
    !Object.keys(existing.env ?? {}).length &&
    !Object.keys(existing.headers ?? {}).length
  ) {
    return false;
  }
  const draft = server as { type?: string; url?: string };
  const transport = (type?: string) =>
    type === "streamable-http" ? "http" : (type ?? "stdio");
  return (
    draft.url !== existing.url ||
    transport(draft.type) !== transport(existing.type)
  );
}

export function applyBrowserGatewayMcpClientCapabilities(
  value: unknown,
  origin: BrowserGatewayClientOrigin,
): unknown {
  if (
    origin === "loopback" ||
    !value ||
    typeof value !== "object" ||
    !("configSnapshot" in value)
  ) {
    return value;
  }
  const snapshot = (value as { configSnapshot?: unknown }).configSnapshot;
  if (
    !snapshot ||
    typeof snapshot !== "object" ||
    !("capabilities" in snapshot)
  ) {
    return value;
  }
  const capabilities = (snapshot as { capabilities?: unknown }).capabilities;
  if (!capabilities || typeof capabilities !== "object") return value;
  return {
    ...value,
    configSnapshot: {
      ...snapshot,
      capabilities: {
        ...capabilities,
        canWriteSecrets: false,
        canConfigureLocalProcess: false,
      },
    },
  };
}

export function buildBrowserGatewayHelperTrustHeaders(
  sharedSecret: string,
  origin: BrowserGatewayClientOrigin,
): Record<string, string> {
  return {
    [BROWSER_GATEWAY_HELPER_SECRET_HEADER]: sharedSecret,
    [BROWSER_GATEWAY_CLIENT_ORIGIN_HEADER]: origin,
  };
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

export function verifyBrowserGatewayHelperTrust(
  headers: Record<string, string | string[] | undefined>,
  expectedSharedSecret: string | null | undefined,
): BrowserGatewayClientOrigin | null {
  if (!expectedSharedSecret) return null;
  const suppliedSecret = headers[BROWSER_GATEWAY_HELPER_SECRET_HEADER];
  const suppliedOrigin = headers[BROWSER_GATEWAY_CLIENT_ORIGIN_HEADER];
  if (
    typeof suppliedSecret !== "string" ||
    typeof suppliedOrigin !== "string" ||
    (suppliedOrigin !== "loopback" && suppliedOrigin !== "non-loopback") ||
    !safeEqual(suppliedSecret, expectedSharedSecret)
  ) {
    return null;
  }
  return suppliedOrigin;
}
