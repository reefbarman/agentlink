import {
  STATUS_CODES,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import https from "node:https";
import { createSecureContext } from "node:tls";
import type { Duplex } from "node:stream";

import { AttemptLimiter } from "./AttemptLimiter.js";
import {
  HttpError,
  optionalStringField,
  readJsonBody,
  sendEmpty,
  sendJson,
  stringField,
} from "./httpJson.js";
import {
  CSRF_HEADER,
  checkRequestEnvelope,
  clearedSessionCookie,
  createServerOriginPolicy,
  isUnsafeMethod,
  readSessionCookie,
  sessionCookie,
  singleHeader,
} from "./requestGuard.js";
import {
  ServerAccessError,
  ServerAccessStore,
  csrfTokenForSession,
  verifyCsrfToken,
  type IssuedServerSession,
  type PassphraseCost,
  type ServerAccessSession,
} from "./ServerAccessStore.js";

const DEFAULT_REAUTHENTICATION_WINDOW_MS = 5 * 60 * 1000;

const SERVER_TENANT_ID = "agentlink-server";
const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "strict-transport-security": "max-age=31536000",
  "content-security-policy":
    "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "cache-control": "no-store",
};

/** Authenticated request context. Hooks never receive anonymous requests. */
export interface AssistantServerAuth {
  /** Explicit server principal; not derived from any project identity. */
  readonly principal: {
    readonly tenantId: typeof SERVER_TENANT_ID;
    readonly subjectId: string;
  };
  readonly session: ServerAccessSession;
  /** True when the passphrase was proven within the reauthentication window. */
  readonly recentlyAuthenticated: boolean;
  /**
   * Aborts when this request or connection closes, or immediately when its
   * session or device is revoked. Long-lived streams must stop on it. Do not
   * use it to cancel server-owned work: it fires on every normal close.
   */
  readonly signal: AbortSignal;
  /**
   * Re-check the session now (revocation, expiry, and the current
   * reauthentication state) without recording client activity, so it never
   * extends the session's idle window. Use it for long-lived streams and
   * immediately before executing a sensitive action.
   */
  revalidate(): Promise<AssistantServerAuthCheck>;
}

export interface AssistantServerAuthCheck {
  readonly valid: boolean;
  readonly recentlyAuthenticated: boolean;
}

type AuthSummary = Pick<
  AssistantServerAuth,
  "principal" | "session" | "recentlyAuthenticated"
>;

export interface CreateAssistantServerOptions {
  readonly dataRoot: string;
  /** Required: the server never listens without TLS. */
  readonly tls: {
    readonly cert: string | Buffer;
    readonly key: string | Buffer;
  };
  /** Exact `https://` origins browsers use to reach this server. */
  readonly publicOrigins: readonly string[];
  readonly listen: { readonly host: string; readonly port: number };
  /**
   * Receives the one-time owner setup credential while no owner exists. It
   * must only be shown locally (for example on the service console).
   */
  readonly onSetupCredential: (credential: {
    readonly token: string;
    readonly expiresAt: number;
  }) => void | Promise<void>;
  /**
   * Authenticated application routes. Unsafe methods have already passed
   * Origin and CSRF checks. Return false to fall through to 404.
   */
  readonly handleRequest?: (
    request: IncomingMessage,
    response: ServerResponse,
    auth: AssistantServerAuth,
  ) => boolean | Promise<boolean>;
  /** Authenticated, same-origin WebSocket (or other) upgrades. */
  readonly handleUpgrade?: (
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    auth: AssistantServerAuth,
  ) => void;
  /**
   * Stops application work (for example server-owned agent turns). Called by
   * `close()` after the listener stops accepting connections and before open
   * connections and the access store close.
   */
  readonly onClose?: () => void | Promise<void>;
  readonly now?: () => number;
  readonly passphraseCost?: PassphraseCost;
  readonly reauthenticationWindowMs?: number;
}

export interface AssistantServer {
  readonly store: ServerAccessStore;
  start(): Promise<{ readonly port: number }>;
  /**
   * Replace the certificate and key for new connections (for example after
   * a renewal). Existing connections keep the old certificate.
   */
  setTls(tls: {
    readonly cert: string | Buffer;
    readonly key: string | Buffer;
  }): void;
  close(): Promise<void>;
}

export async function createAssistantServer(
  options: CreateAssistantServerOptions,
): Promise<AssistantServer> {
  if (!options.tls?.cert || !options.tls?.key) {
    throw new Error("The assistant server requires a TLS certificate and key");
  }
  // Reject unusable TLS material before taking the data-root lock.
  createSecureContext({
    cert: options.tls.cert,
    key: options.tls.key,
    minVersion: "TLSv1.2",
  });
  const policy = createServerOriginPolicy(options.publicOrigins);
  const now = options.now ?? Date.now;
  const reauthenticationWindowMs =
    options.reauthenticationWindowMs ?? DEFAULT_REAUTHENTICATION_WINDOW_MS;
  const store = await ServerAccessStore.open({
    dataRoot: options.dataRoot,
    now,
    passphraseCost: options.passphraseCost,
  });
  const limiter = new AttemptLimiter({ now });
  const liveRequests = new Map<string, Set<AbortController>>();
  store.onSessionsRevoked((sessionIds) => {
    for (const sessionId of sessionIds) {
      for (const controller of liveRequests.get(sessionId) ?? []) {
        controller.abort(new Error("session_revoked"));
      }
    }
  });

  const toAuth = (session: ServerAccessSession): AuthSummary => ({
    principal: { tenantId: SERVER_TENANT_ID, subjectId: session.ownerId },
    session,
    recentlyAuthenticated:
      now() - session.authenticatedAt < reauthenticationWindowMs,
  });

  /** Bind an authenticated session to one request or upgraded connection. */
  const bindAuth = (
    session: ServerAccessSession,
    token: string,
    lifetime: { once(event: "close", listener: () => void): unknown },
  ): AssistantServerAuth => {
    const controller = new AbortController();
    const live = liveRequests.get(session.sessionId) ?? new Set();
    live.add(controller);
    liveRequests.set(session.sessionId, live);
    lifetime.once("close", () => {
      live.delete(controller);
      if (live.size === 0) liveRequests.delete(session.sessionId);
      controller.abort(new Error("request_closed"));
    });
    return {
      ...toAuth(session),
      signal: controller.signal,
      async revalidate() {
        const invalid = { valid: false, recentlyAuthenticated: false };
        if (controller.signal.aborted) return invalid;
        const result = await store.authenticate(token, {
          recordActivity: false,
        });
        if (
          controller.signal.aborted ||
          !result.ok ||
          result.session.sessionId !== session.sessionId
        ) {
          return invalid;
        }
        return {
          valid: true,
          recentlyAuthenticated: toAuth(result.session).recentlyAuthenticated,
        };
      },
    };
  };

  const authenticateRequest = async (request: IncomingMessage) => {
    const token = readSessionCookie(singleHeader(request.headers.cookie));
    if (token === undefined) return undefined;
    const result = await store.authenticate(token);
    return { token, result };
  };

  const issueSession = (
    response: ServerResponse,
    issued: IssuedServerSession,
  ) => {
    response.setHeader(
      "set-cookie",
      sessionCookie(issued.token, (issued.session.expiresAt - now()) / 1000),
    );
    sendJson(response, 201, {
      ...describeSession(issued.session, toAuth(issued.session)),
      csrfToken: csrfTokenForSession(issued.token),
    });
  };

  /** Credential-guessing routes share one limiter keyed by socket address. */
  const guardAttempt = async <T>(
    request: IncomingMessage,
    attempt: () => Promise<T>,
    isGuessFailure: (error: unknown) => boolean,
  ): Promise<T> => {
    const reservation = limiter.reserve(
      request.socket.remoteAddress ?? "unknown",
    );
    if (!reservation) throw new HttpError(429, "rate_limited");
    try {
      const result = await attempt();
      reservation.release();
      return result;
    } catch (error) {
      if (isGuessFailure(error)) reservation.fail();
      else reservation.release();
      throw error;
    }
  };

  const handle = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      response.setHeader(name, value);
    }
    const envelope = checkRequestEnvelope(
      request.headers,
      request.method,
      policy,
    );
    if (!envelope.ok) {
      sendJson(response, envelope.status, { error: envelope.error });
      request.resume();
      return;
    }
    const method = (request.method ?? "GET").toUpperCase();
    const pathname = new URL(request.url ?? "/", "https://server.invalid")
      .pathname;

    if (method === "GET" && pathname === "/api/auth/state") {
      sendJson(response, 200, { ownerConfigured: store.ownerConfigured });
      return;
    }
    if (method === "POST" && pathname === "/api/auth/bootstrap") {
      const body = await readJsonBody(request);
      const issued = await guardAttempt(
        request,
        () =>
          store.bootstrapOwner({
            setupToken: stringField(body, "setupToken"),
            passphrase: stringField(body, "passphrase"),
            deviceLabel: optionalStringField(body, "deviceLabel"),
          }),
        (error) => accessCode(error) === "invalid_setup_credential",
      );
      issueSession(response, issued);
      return;
    }
    if (method === "POST" && pathname === "/api/auth/pairings/redeem") {
      const body = await readJsonBody(request);
      const issued = await guardAttempt(
        request,
        () =>
          store.redeemPairing({
            code: stringField(body, "code"),
            deviceLabel: optionalStringField(body, "deviceLabel"),
          }),
        (error) => accessCode(error) === "invalid_pairing_code",
      );
      issueSession(response, issued);
      return;
    }
    if (method === "POST" && pathname === "/api/auth/recover") {
      const body = await readJsonBody(request);
      const issued = await guardAttempt(
        request,
        () =>
          store.redeemRecovery({
            recoveryToken: stringField(body, "recoveryToken"),
            passphrase: stringField(body, "passphrase"),
            deviceLabel: optionalStringField(body, "deviceLabel"),
          }),
        (error) => accessCode(error) === "invalid_recovery_credential",
      );
      issueSession(response, issued);
      return;
    }

    const authenticated = await authenticateRequest(request);
    if (!authenticated?.result.ok) {
      if (authenticated) {
        response.setHeader("set-cookie", clearedSessionCookie());
      }
      throw new HttpError(401, "authentication_required");
    }
    const { token } = authenticated;
    const auth = bindAuth(authenticated.result.session, token, response);
    if (
      isUnsafeMethod(method) &&
      !verifyCsrfToken(token, singleHeader(request.headers[CSRF_HEADER]))
    ) {
      throw new HttpError(403, "csrf_invalid");
    }
    const requireRecent = () => {
      if (!auth.recentlyAuthenticated) {
        throw new HttpError(401, "reauthentication_required");
      }
    };

    if (method === "GET" && pathname === "/api/auth/session") {
      sendJson(response, 200, {
        ...describeSession(auth.session, auth),
        csrfToken: csrfTokenForSession(token),
      });
      return;
    }
    if (method === "POST" && pathname === "/api/auth/reauthenticate") {
      const body = await readJsonBody(request);
      const passphrase = stringField(body, "passphrase");
      await guardAttempt(
        request,
        async () => {
          if (
            !(await store.reauthenticate(auth.session.sessionId, passphrase))
          ) {
            throw new HttpError(401, "invalid_passphrase");
          }
        },
        (error) =>
          error instanceof HttpError && error.code === "invalid_passphrase",
      );
      sendEmpty(response, 204);
      return;
    }
    if (method === "POST" && pathname === "/api/auth/logout") {
      await store.revokeSession(auth.session.sessionId);
      response.setHeader("set-cookie", clearedSessionCookie());
      sendEmpty(response, 204);
      return;
    }
    if (method === "POST" && pathname === "/api/auth/pairings") {
      requireRecent();
      sendJson(response, 201, store.createPairing());
      return;
    }
    if (method === "GET" && pathname === "/api/auth/devices") {
      sendJson(response, 200, {
        devices: store.listDevices().map((device) => ({
          ...device,
          current: device.deviceId === auth.session.deviceId,
        })),
      });
      return;
    }
    const deviceMatch = /^\/api\/auth\/devices\/([0-9a-f-]{36})$/u.exec(
      pathname,
    );
    if (method === "DELETE" && deviceMatch) {
      requireRecent();
      if (!(await store.revokeDevice(deviceMatch[1]!))) {
        throw new HttpError(404, "device_not_found");
      }
      if (deviceMatch[1] === auth.session.deviceId) {
        response.setHeader("set-cookie", clearedSessionCookie());
      }
      sendEmpty(response, 204);
      return;
    }
    if (pathname.startsWith("/api/auth/")) {
      throw new HttpError(404, "not_found");
    }
    if (
      options.handleRequest &&
      (await options.handleRequest(request, response, auth))
    ) {
      return;
    }
    throw new HttpError(404, "not_found");
  };

  const handleUpgrade = async (
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<void> => {
    const envelope = checkRequestEnvelope(
      request.headers,
      request.method,
      policy,
      { upgrade: true },
    );
    if (!envelope.ok) {
      rejectUpgrade(socket, envelope.status);
      return;
    }
    const authenticated = await authenticateRequest(request);
    if (!authenticated?.result.ok) {
      rejectUpgrade(socket, 401);
      return;
    }
    if (!options.handleUpgrade) {
      rejectUpgrade(socket, 404);
      return;
    }
    options.handleUpgrade(
      request,
      socket,
      head,
      bindAuth(authenticated.result.session, authenticated.token, socket),
    );
  };

  const server = https.createServer(
    {
      cert: options.tls.cert,
      key: options.tls.key,
      minVersion: "TLSv1.2",
    },
    (request, response) => {
      handle(request, response).catch((error: unknown) => {
        const status = error instanceof HttpError ? error.status : undefined;
        const code =
          error instanceof HttpError ? error.code : accessCode(error);
        if (response.headersSent) {
          response.destroy();
          return;
        }
        if (status !== undefined && code) {
          sendJson(response, status, { error: code });
        } else if (code) {
          sendJson(response, accessStatus(code), { error: code });
        } else {
          sendJson(response, 500, { error: "internal_error" });
        }
        request.resume();
      });
    },
  );
  server.on("upgrade", (request, socket: Duplex, head: Buffer) => {
    handleUpgrade(request, socket, head).catch(() =>
      rejectUpgrade(socket, 500),
    );
  });
  server.on("clientError", (_error, socket: Duplex) => {
    socket.destroy();
  });

  return {
    store,
    setTls(tls) {
      server.setSecureContext({
        cert: tls.cert,
        key: tls.key,
        minVersion: "TLSv1.2",
      });
    },
    async start() {
      if (!store.ownerConfigured) {
        await options.onSetupCredential(await store.issueSetupCredential());
      }
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(options.listen.port, options.listen.host, () => {
          server.off("error", reject);
          resolve();
        });
      });
      const address = server.address();
      return {
        port:
          address && typeof address === "object"
            ? address.port
            : options.listen.port,
      };
    },
    async close() {
      const closed = server.listening
        ? new Promise<void>((resolve) => server.close(() => resolve()))
        : undefined;
      // Stop server-owned work while its streams and the store still exist.
      await options.onClose?.();
      if (closed) {
        server.closeAllConnections();
        await closed;
      }
      await store.close();
    },
  };
}

function describeSession(session: ServerAccessSession, auth: AuthSummary) {
  return {
    ownerId: session.ownerId,
    sessionId: session.sessionId,
    deviceId: session.deviceId,
    deviceLabel: session.deviceLabel,
    expiresAt: session.expiresAt,
    authenticatedAt: session.authenticatedAt,
    recentlyAuthenticated: auth.recentlyAuthenticated,
  };
}

function accessCode(error: unknown): string | undefined {
  return error instanceof ServerAccessError ? error.code : undefined;
}

function accessStatus(code: string): number {
  switch (code) {
    case "invalid_setup_credential":
    case "invalid_pairing_code":
    case "invalid_recovery_credential":
      return 401;
    case "owner_exists":
    case "owner_missing":
    case "pairing_limit_reached":
      return 409;
    case "weak_passphrase":
    case "invalid_label":
      return 400;
    default:
      return 500;
  }
}

function rejectUpgrade(socket: Duplex, status: number): void {
  if (socket.destroyed) return;
  socket.end(
    `HTTP/1.1 ${status} ${STATUS_CODES[status] ?? "Error"}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
}
