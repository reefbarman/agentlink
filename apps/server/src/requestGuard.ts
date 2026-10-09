import type { IncomingHttpHeaders } from "node:http";

export const SESSION_COOKIE_NAME = "__Host-agentlink_session";
export const CSRF_HEADER = "x-agentlink-csrf";

/**
 * Identity and proxy headers a reverse proxy or client could use to claim a
 * different address, scheme, host, or user. The direct listener has no
 * trusted proxy, so any of them is a forgery and the request is rejected.
 */
const FORBIDDEN_HEADERS = new Set([
  "forwarded",
  "x-real-ip",
  "x-client-ip",
  "x-cluster-client-ip",
  "true-client-ip",
  "cf-connecting-ip",
  "fastly-client-ip",
  "x-original-forwarded-for",
  "x-remote-user",
  "x-remote-addr",
  "remote-user",
  "x-user",
  "x-email",
  "x-original-url",
  "x-rewrite-url",
  "x-original-host",
  "x-host",
  "x-http-method-override",
  "x-method-override",
  "x-ingress-path",
  "x-hass-source",
]);
const FORBIDDEN_HEADER_PREFIXES = [
  "x-forwarded-",
  "x-auth-request-",
  "x-authenticated-",
  "x-ms-client-principal",
  "x-goog-authenticated-user-",
];

const SAFE_METHODS = new Set(["GET", "HEAD"]);

export interface ServerOriginPolicy {
  /** Normalised origins, for example `https://assistant.home.arpa:8443`. */
  readonly origins: ReadonlySet<string>;
  /** Matching `Host` header values. */
  readonly hosts: ReadonlySet<string>;
}

export type RequestGuardResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly status: 400 | 403 | 405 | 421;
      readonly error: string;
    };

/** Validate configured public origins. Only bare `https://` origins are allowed. */
export function createServerOriginPolicy(
  publicOrigins: readonly string[],
): ServerOriginPolicy {
  if (publicOrigins.length === 0) {
    throw new Error("The assistant server requires at least one public origin");
  }
  const origins = new Set<string>();
  const hosts = new Set<string>();
  for (const value of publicOrigins) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error(`Invalid public origin: ${value}`);
    }
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      value.replace(/\/$/u, "") !== url.origin
    ) {
      throw new Error(
        `Public origins must be bare https:// origins (got ${value})`,
      );
    }
    origins.add(url.origin);
    hosts.add(url.host);
  }
  return { origins, hosts };
}

export function isUnsafeMethod(method: string | undefined): boolean {
  return !SAFE_METHODS.has((method ?? "").toUpperCase());
}

/**
 * Checks applied to every request and upgrade before authentication:
 * forged proxy/identity headers, Host (DNS rebinding), and Origin.
 */
export function checkRequestEnvelope(
  headers: IncomingHttpHeaders,
  method: string | undefined,
  policy: ServerOriginPolicy,
  options: { readonly upgrade?: boolean } = {},
): RequestGuardResult {
  for (const name of Object.keys(headers)) {
    const lower = name.toLowerCase();
    if (
      FORBIDDEN_HEADERS.has(lower) ||
      FORBIDDEN_HEADER_PREFIXES.some((prefix) => lower.startsWith(prefix))
    ) {
      return { ok: false, status: 400, error: "forwarded_identity_rejected" };
    }
  }
  const upperMethod = (method ?? "").toUpperCase();
  if (upperMethod === "OPTIONS" || upperMethod === "TRACE") {
    return { ok: false, status: 405, error: "method_not_allowed" };
  }
  const host = headers.host?.toLowerCase();
  if (!host || !policy.hosts.has(host)) {
    return { ok: false, status: 421, error: "host_not_allowed" };
  }
  if (singleHeader(headers["sec-fetch-site"]) === "cross-site") {
    return { ok: false, status: 403, error: "cross_site_request" };
  }
  const origin = singleHeader(headers.origin);
  if (origin !== undefined && !policy.origins.has(origin)) {
    return { ok: false, status: 403, error: "origin_not_allowed" };
  }
  if (origin === undefined && (options.upgrade || isUnsafeMethod(method))) {
    return { ok: false, status: 403, error: "origin_required" };
  }
  return { ok: true };
}

/** Read the session cookie. Duplicate session cookies are treated as absent. */
export function readSessionCookie(
  header: string | undefined,
): string | undefined {
  if (!header) return undefined;
  let found: string | undefined;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== SESSION_COOKIE_NAME) continue;
    if (found !== undefined) return undefined;
    found = part.slice(separator + 1).trim();
  }
  return found;
}

export function sessionCookie(token: string, maxAgeSeconds: number): string {
  return `${SESSION_COOKIE_NAME}=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`;
}

export function clearedSessionCookie(): string {
  return `${SESSION_COOKIE_NAME}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`;
}

export function singleHeader(
  value: string | string[] | undefined,
): string | undefined {
  return Array.isArray(value) ? undefined : value;
}
