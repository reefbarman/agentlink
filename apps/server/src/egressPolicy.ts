import { createHmac, timingSafeEqual } from "node:crypto";

import {
  DEFAULT_EGRESS_ALLOWLIST,
  normalizeHostname,
  parseEgressAllowlist,
  type EgressAllowlist,
  type EgressAuthorization,
} from "./egressGateway.js";

/**
 * Per-project network access. Each project picks a preset, plus extra
 * sites that are always allowed (except under `off`):
 *
 * - `open` (the default): any public host over HTTPS.
 * - `dependencies`: package registries and GitHub (the gateway's built-in
 *   list and its `AGENTLINK_EGRESS_ALLOW` additions).
 * - `off`: nothing.
 *
 * Private, LAN, and host addresses are refused under every preset, by
 * address after resolving, whatever the name.
 *
 * The server tells the egress gateway a project's policy in the proxy
 * credentials it gives that project's commands: the policy, signed with a
 * key only the server and the gateway hold. A command can read its own
 * credentials but cannot forge a looser policy.
 */

export type NetworkPreset = "open" | "dependencies" | "off";

export const NETWORK_PRESETS: readonly NetworkPreset[] = [
  "open",
  "dependencies",
  "off",
];

export interface NetworkPolicy {
  readonly preset: NetworkPreset;
  /** Extra host names or `*.domain` wildcards. */
  readonly allow: readonly string[];
}

export const DEFAULT_NETWORK_POLICY: NetworkPolicy = {
  preset: "open",
  allow: [],
};

export const MAX_NETWORK_ALLOW_ENTRIES = 100;

/** Proxy user names start with this, so other credentials are not mistaken. */
const CREDENTIAL_VERSION = "alnp1";
const MAX_CREDENTIAL_LENGTH = 8_192;

export function isNetworkPreset(value: unknown): value is NetworkPreset {
  return NETWORK_PRESETS.includes(value as NetworkPreset);
}

/**
 * Validate and normalise extra sites. Throws with the offending entry, like
 * the gateway's own allowlist.
 */
export function normalizeNetworkAllow(entries: readonly string[]): string[] {
  const cleaned = entries.map((entry) => entry.trim()).filter(Boolean);
  if (cleaned.length > MAX_NETWORK_ALLOW_ENTRIES) {
    throw new Error(
      `A project can allow at most ${MAX_NETWORK_ALLOW_ENTRIES} extra sites`,
    );
  }
  return cleaned.length === 0 ? [] : [...parseEgressAllowlist(cleaned).entries];
}

export type NetworkDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string };

/**
 * Whether a policy lets a host name through, before any address checks.
 * `dependencies` is the gateway's dependency list.
 */
export function networkPolicyAllows(
  policy: NetworkPolicy,
  hostname: string,
  dependencies: EgressAllowlist = parseEgressAllowlist(
    DEFAULT_EGRESS_ALLOWLIST,
  ),
): NetworkDecision {
  if (policy.preset === "off") {
    return {
      allowed: false,
      reason: "network access is off for this project",
    };
  }
  const name = normalizeHostname(hostname);
  if (!name) return { allowed: false, reason: "the host name is invalid" };
  if (policy.preset === "open") return { allowed: true };
  if (
    dependencies.matches(name) ||
    (policy.allow.length > 0 &&
      parseEgressAllowlist(policy.allow).matches(name))
  ) {
    return { allowed: true };
  }
  return {
    allowed: false,
    reason:
      "this project only allows package registries and its extra sites; add the host in project settings",
  };
}

export interface NetworkPolicyCredentials {
  readonly username: string;
  readonly password: string;
}

function encodePolicy(policy: NetworkPolicy): string {
  return Buffer.from(
    JSON.stringify({ p: policy.preset, a: policy.allow }),
    "utf8",
  ).toString("base64url");
}

function signature(key: Buffer, username: string): string {
  return createHmac("sha256", key).update(username).digest("base64url");
}

/** Proxy credentials carrying a signed policy. */
export function signNetworkPolicy(
  key: Buffer,
  policy: NetworkPolicy,
): NetworkPolicyCredentials {
  const username = `${CREDENTIAL_VERSION}.${encodePolicy(policy)}`;
  return { username, password: signature(key, username) };
}

/**
 * The policy in a `Proxy-Authorization` header: `undefined` when there is
 * no header (the gateway's default applies), `"invalid"` when it is
 * malformed, unsigned, or signed with another key.
 */
export function verifyNetworkPolicyHeader(
  key: Buffer,
  header: string | undefined,
): NetworkPolicy | "invalid" | undefined {
  if (header === undefined) return undefined;
  if (header.length > MAX_CREDENTIAL_LENGTH) return "invalid";
  const match = /^Basic\s+([A-Za-z0-9+/=]+)$/iu.exec(header.trim());
  if (!match) return "invalid";
  const decoded = Buffer.from(match[1]!, "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  if (separator < 0) return "invalid";
  // Clients percent-encode credentials taken from a proxy URL.
  let username: string;
  let password: string;
  try {
    username = decodeURIComponent(decoded.slice(0, separator));
    password = decodeURIComponent(decoded.slice(separator + 1));
  } catch {
    return "invalid";
  }
  const prefix = `${CREDENTIAL_VERSION}.`;
  if (!username.startsWith(prefix)) return "invalid";
  const expected = Buffer.from(signature(key, username));
  const given = Buffer.from(password);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    return "invalid";
  }
  try {
    const parsed = JSON.parse(
      Buffer.from(username.slice(prefix.length), "base64url").toString("utf8"),
    ) as { p?: unknown; a?: unknown };
    if (!isNetworkPreset(parsed.p) || !Array.isArray(parsed.a)) {
      return "invalid";
    }
    const allow = parsed.a.filter(
      (entry): entry is string => typeof entry === "string",
    );
    return { preset: parsed.p, allow: normalizeNetworkAllow(allow) };
  } catch {
    return "invalid";
  }
}

/**
 * The proxy URL for a project's commands: the gateway with the signed
 * policy as its credentials. Without a key the plain URL is returned, and
 * the gateway applies its default allowlist.
 */
export function egressProxyUrl(
  egressProxy: string,
  key: Buffer | undefined,
  policy: NetworkPolicy,
): string {
  if (!key) return egressProxy;
  const url = new URL(egressProxy);
  const credentials = signNetworkPolicy(key, policy);
  url.username = credentials.username;
  url.password = credentials.password;
  return url.href.replace(/\/$/u, "");
}

/** `Proxy-Authorization` for the server's own requests through the gateway. */
export function proxyAuthorizationHeader(
  key: Buffer,
  policy: NetworkPolicy,
): string {
  const { username, password } = signNetworkPolicy(key, policy);
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

/**
 * The gateway's tunnel check: the signed policy in the credentials, or for
 * a request without credentials the gateway's own list (as
 * `dependencies`). Bad credentials are refused, never treated as absent.
 */
export function egressPolicyAuthorizer(
  key: Buffer,
  dependencies: EgressAllowlist,
): (request: {
  readonly hostname: string;
  readonly proxyAuthorization: string | undefined;
}) => EgressAuthorization {
  return ({ hostname, proxyAuthorization }) => {
    const policy = verifyNetworkPolicyHeader(key, proxyAuthorization);
    if (policy === "invalid") {
      return {
        allowed: false,
        status: 407,
        reason: "the proxy credentials are not valid",
      };
    }
    const decision = networkPolicyAllows(
      policy ?? { preset: "dependencies", allow: [] },
      hostname,
      dependencies,
    );
    if (decision.allowed) return decision;
    return {
      allowed: false,
      status: 403,
      reason: policy
        ? decision.reason
        : "not on the AgentLink egress allowlist",
    };
  };
}

/** Load a policy key: at least 32 bytes of hex or base64 text, or raw. */
export function parseNetworkPolicyKey(raw: string | Buffer): Buffer {
  const text = Buffer.isBuffer(raw) ? raw.toString("utf8").trim() : raw.trim();
  const key = /^[0-9a-f]+$/iu.test(text)
    ? Buffer.from(text, "hex")
    : Buffer.from(text, "utf8");
  if (key.length < 32) {
    throw new Error(
      "The egress policy key must be at least 32 bytes (for example `openssl rand -hex 32`)",
    );
  }
  return key;
}
