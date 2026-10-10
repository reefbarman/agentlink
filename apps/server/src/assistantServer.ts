import { randomBytes } from "node:crypto";
import {
  STATUS_CODES,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import https from "node:https";
import { createSecureContext } from "node:tls";
import type { Duplex } from "node:stream";

import {
  deviceLabelFromUserAgent,
  pairingLink,
  renderDevicesPage,
  renderNewPairingPage,
  renderPairPage,
} from "./accessPages.js";
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
  checkRequestEnvelope,
  clearedSessionCookie,
  createServerOriginPolicy,
  readSessionCookie,
  sessionCookie,
  singleHeader,
} from "./requestGuard.js";
import {
  ServerAccessError,
  ServerAccessStore,
  type IssuedServerSession,
  type ServerAccessSession,
} from "./ServerAccessStore.js";
import { serveWebAsset, type WebAssets } from "./webAssets.js";

const SERVER_TENANT_ID = "agentlink-server";
const MAX_FORM_BODY_BYTES = 1_024;
const API_CSP =
  "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
/** Server-rendered sign-in and device pages: inline styles and SVG only. */
const PAGE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "strict-transport-security": "max-age=31536000",
  "content-security-policy": API_CSP,
  "x-content-type-options": "nosniff",
  // Not `no-referrer`: under it browsers send `Origin: null` with form posts,
  // which the Origin check must reject. Nothing is sent to other sites.
  "referrer-policy": "same-origin",
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
  /**
   * Aborts when this request or connection closes, or immediately when its
   * session or device is revoked. Long-lived streams must stop on it. Do not
   * use it to cancel server-owned work: it fires on every normal close.
   */
  readonly signal: AbortSignal;
  /**
   * Re-check the session now (revocation and expiry) without recording
   * client activity, so it never extends the session's idle window. Use it
   * for long-lived streams and immediately before a mutation takes effect.
   */
  revalidate(): Promise<AssistantServerAuthCheck>;
  /**
   * The same sign-in for server-owned follow-up work that outlives this
   * request, such as reporting a finished background agent. Its signal and
   * `revalidate` ignore the request closing; they still end on revocation,
   * sign-out, and expiry.
   */
  detach(): AssistantServerAuth;
}

export interface AssistantServerAuthCheck {
  readonly valid: boolean;
}

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
   * Authenticated application routes. Unsafe methods have already passed the
   * Host, Origin, and fetch-site checks, and the session cookie is
   * `SameSite=Strict`. Return false to fall through to 404.
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
  /**
   * Static web app files, served without a session (they hold no data) but
   * after the Host, Origin, and forged-header checks.
   */
  readonly webAssets?: WebAssets;
  /**
   * The signed-in app shell for `/`. Receives the per-response nonce its
   * inline boot script must carry. Signed-out browsers go to `/pair`.
   */
  readonly renderAppPage?: (page: { readonly nonce: string }) => string;
  /**
   * Push notification state for the `/devices` page, which shows which
   * devices have notifications on and can turn them off. Turning them on
   * needs the browser, so it happens in the app.
   */
  readonly deviceNotifications?: {
    isOn(deviceId: string): boolean;
    turnOff(deviceId: string): Promise<void>;
  };
  readonly now?: () => number;
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
  const store = await ServerAccessStore.open({
    dataRoot: options.dataRoot,
    now,
  });
  const limiter = new AttemptLimiter({ now });
  const liveRequests = new Map<string, Set<AbortController>>();
  /** Detached auth per access session; see `AssistantServerAuth.detach`. */
  const detachedAuths = new Map<string, AssistantServerAuth>();
  store.onSessionsRevoked((sessionIds) => {
    for (const sessionId of sessionIds) {
      for (const controller of liveRequests.get(sessionId) ?? []) {
        controller.abort(new Error("session_revoked"));
      }
    }
  });

  /**
   * Bind an authenticated session to one request or upgraded connection, or
   * (without a lifetime) to the session itself, for detached work.
   */
  const bindAuth = (
    session: ServerAccessSession,
    token: string,
    lifetime?: { once(event: "close", listener: () => void): unknown },
  ): AssistantServerAuth => {
    const controller = new AbortController();
    const live = liveRequests.get(session.sessionId) ?? new Set();
    live.add(controller);
    liveRequests.set(session.sessionId, live);
    const release = () => {
      live.delete(controller);
      if (live.size === 0) liveRequests.delete(session.sessionId);
    };
    lifetime?.once("close", () => {
      release();
      controller.abort(new Error("request_closed"));
    });
    // A detached auth is dropped from the revocation set once it is invalid.
    controller.signal.addEventListener(
      "abort",
      () => {
        release();
        if (!lifetime && detachedAuths.get(session.sessionId) === auth) {
          detachedAuths.delete(session.sessionId);
        }
      },
      { once: true },
    );
    const auth: AssistantServerAuth = {
      principal: { tenantId: SERVER_TENANT_ID, subjectId: session.ownerId },
      session,
      signal: controller.signal,
      async revalidate() {
        if (controller.signal.aborted) return { valid: false };
        const result = await store.authenticate(token, {
          recordActivity: false,
        });
        const valid =
          !controller.signal.aborted &&
          result.ok &&
          result.session.sessionId === session.sessionId;
        // Expired or signed out: end detached work that is still listening.
        if (!valid && !lifetime) controller.abort(new Error("session_ended"));
        return { valid };
      },
      detach() {
        if (!lifetime) return auth;
        // One per sign-in, so repeated requests do not accumulate.
        let detached = detachedAuths.get(session.sessionId);
        if (!detached || detached.signal.aborted) {
          detached = bindAuth(session, token);
          detachedAuths.set(session.sessionId, detached);
        }
        return detached;
      },
    };
    return auth;
  };

  const authenticateRequest = async (request: IncomingMessage) => {
    const token = readSessionCookie(singleHeader(request.headers.cookie));
    if (token === undefined) return undefined;
    const result = await store.authenticate(token);
    return { token, result };
  };

  const setSessionCookie = (
    response: ServerResponse,
    issued: IssuedServerSession,
  ) => {
    response.setHeader(
      "set-cookie",
      sessionCookie(issued.token, (issued.session.expiresAt - now()) / 1000),
    );
  };

  /** Pairing attempts share one limiter keyed by socket address. */
  const guardAttempt = async <T>(
    request: IncomingMessage,
    attempt: () => Promise<T>,
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
      if (accessCode(error) === "invalid_pairing_code") reservation.fail();
      else reservation.release();
      throw error;
    }
  };

  /** Same-origin link for a code, on the host this browser is using. */
  const linkFor = (request: IncomingMessage, code: string) =>
    pairingLink(`https://${request.headers.host!.toLowerCase()}`, code);

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
    const url = new URL(request.url ?? "/", "https://server.invalid");
    const pathname = url.pathname;

    if (pathname !== "/" && serveWebAsset(request, response, options.webAssets))
      return;

    if (pathname === "/pair" && (method === "GET" || method === "HEAD")) {
      const signedIn = await authenticateRequest(request);
      if (signedIn?.result.ok) {
        redirect(response, "/");
        return;
      }
      sendPage(
        response,
        200,
        renderPairPage({ code: url.searchParams.get("code") ?? undefined }),
      );
      return;
    }
    if (pathname === "/pair" && method === "POST") {
      const form = await readFormBody(request);
      const code = form.get("code") ?? "";
      try {
        const issued = await guardAttempt(request, () =>
          store.redeemPairing({
            code,
            deviceLabel: deviceLabelFromUserAgent(
              singleHeader(request.headers["user-agent"]),
            ),
          }),
        );
        setSessionCookie(response, issued);
        redirect(response, "/");
      } catch (error) {
        const failure = pairFailure(error);
        if (!failure) throw error;
        sendPage(
          response,
          failure.status,
          renderPairPage({ errorMessage: failure.message }),
        );
      }
      return;
    }
    if (method === "POST" && pathname === "/api/auth/pairings/redeem") {
      const body = await readJsonBody(request);
      const issued = await guardAttempt(request, () =>
        store.redeemPairing({
          code: stringField(body, "code"),
          deviceLabel: optionalStringField(body, "deviceLabel"),
        }),
      );
      setSessionCookie(response, issued);
      sendJson(response, 201, describeSession(issued.session));
      return;
    }

    const authenticated = await authenticateRequest(request);
    if (!authenticated?.result.ok) {
      if (authenticated) {
        response.setHeader("set-cookie", clearedSessionCookie());
      }
      // Browsers opening a page go to sign-in; API clients get a 401.
      if (
        (method === "GET" || method === "HEAD") &&
        (pathname === "/" || pathname === "/devices")
      ) {
        request.resume();
        redirect(response, "/pair");
        return;
      }
      throw new HttpError(401, "authentication_required");
    }
    const { token } = authenticated;
    const auth = bindAuth(authenticated.result.session, token, response);

    if ((method === "GET" || method === "HEAD") && pathname === "/") {
      if (!options.renderAppPage) throw new HttpError(404, "not_found");
      const nonce = randomBytes(16).toString("base64");
      response.setHeader(
        "content-security-policy",
        [
          "default-src 'self'",
          `script-src 'self' 'nonce-${nonce}'`,
          "style-src 'self' 'unsafe-inline'",
          "img-src 'self' data: blob:",
          "font-src 'self' data:",
          "connect-src 'self'",
          "worker-src 'self' blob:",
          "manifest-src 'self'",
          "base-uri 'none'",
          "object-src 'none'",
          "frame-ancestors 'none'",
          "form-action 'self'",
        ].join("; "),
      );
      const html = options.renderAppPage({ nonce });
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-length": Buffer.byteLength(html),
      });
      response.end(method === "HEAD" ? undefined : html);
      return;
    }
    const notificationsOn = (deviceId: string) =>
      options.deviceNotifications?.isOn(deviceId) === true;
    if ((method === "GET" || method === "HEAD") && pathname === "/devices") {
      sendPage(
        response,
        200,
        renderDevicesPage({
          devices: store.listDevices(),
          currentDeviceId: auth.session.deviceId,
          notificationsOn,
        }),
      );
      return;
    }
    const notificationsOffMatch =
      /^\/devices\/([0-9a-f-]{36})\/notifications\/off$/u.exec(pathname);
    if (
      method === "POST" &&
      notificationsOffMatch &&
      options.deviceNotifications
    ) {
      request.resume();
      await options.deviceNotifications.turnOff(notificationsOffMatch[1]!);
      redirect(response, "/devices");
      return;
    }
    if (method === "POST" && pathname === "/devices/pair") {
      request.resume();
      const pairing = createPairingOrNull(store);
      if (!pairing) {
        sendPage(
          response,
          409,
          renderDevicesPage({
            devices: store.listDevices(),
            currentDeviceId: auth.session.deviceId,
            notificationsOn,
            errorMessage:
              "Too many unused pairing codes. Wait a few minutes and try again.",
          }),
        );
        return;
      }
      sendPage(
        response,
        200,
        renderNewPairingPage({
          ...pairing,
          link: linkFor(request, pairing.code),
          now: now(),
        }),
      );
      return;
    }
    const revokeMatch = /^\/devices\/([0-9a-f-]{36})\/revoke$/u.exec(pathname);
    if (method === "POST" && revokeMatch) {
      request.resume();
      await store.revokeDevice(revokeMatch[1]!);
      if (revokeMatch[1] === auth.session.deviceId) {
        response.setHeader("set-cookie", clearedSessionCookie());
        redirect(response, "/pair");
      } else {
        redirect(response, "/devices");
      }
      return;
    }

    if (method === "GET" && pathname === "/api/auth/session") {
      sendJson(response, 200, describeSession(auth.session));
      return;
    }
    if (method === "POST" && pathname === "/api/auth/logout") {
      await store.revokeSession(auth.session.sessionId);
      response.setHeader("set-cookie", clearedSessionCookie());
      sendEmpty(response, 204);
      return;
    }
    if (method === "POST" && pathname === "/api/auth/pairings") {
      const pairing = store.createPairing();
      sendJson(response, 201, {
        ...pairing,
        link: linkFor(request, pairing.code),
      });
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

function createPairingOrNull(
  store: ServerAccessStore,
): { code: string; expiresAt: number } | undefined {
  try {
    return store.createPairing();
  } catch (error) {
    if (accessCode(error) === "pairing_limit_reached") return undefined;
    throw error;
  }
}

function pairFailure(
  error: unknown,
): { readonly status: number; readonly message: string } | undefined {
  if (error instanceof HttpError && error.code === "rate_limited") {
    return {
      status: 429,
      message: "Too many attempts. Wait a minute and try again.",
    };
  }
  switch (accessCode(error)) {
    case "invalid_pairing_code":
      return {
        status: 401,
        message:
          "That code did not work. Check it, or get a new one: codes are single use and expire after a few minutes.",
      };
    case "invalid_label":
      return { status: 400, message: "This browser could not be named." };
    default:
      return undefined;
  }
}

/** Read a small `application/x-www-form-urlencoded` body. */
async function readFormBody(
  request: IncomingMessage,
): Promise<URLSearchParams> {
  const contentType = singleHeader(request.headers["content-type"]) ?? "";
  if (!/^application\/x-www-form-urlencoded(\s*;|$)/iu.test(contentType)) {
    throw new HttpError(415, "form_required");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_FORM_BODY_BYTES) throw new HttpError(413, "body_too_large");
    chunks.push(chunk as Buffer);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

function sendPage(response: ServerResponse, status: number, html: string) {
  response.setHeader("content-security-policy", PAGE_CSP);
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(html),
  });
  response.end(html);
}

function redirect(response: ServerResponse, location: string): void {
  response.writeHead(303, { location, "content-length": 0 });
  response.end();
}

function describeSession(session: ServerAccessSession) {
  return {
    ownerId: session.ownerId,
    sessionId: session.sessionId,
    deviceId: session.deviceId,
    deviceLabel: session.deviceLabel,
    expiresAt: session.expiresAt,
  };
}

function accessCode(error: unknown): string | undefined {
  return error instanceof ServerAccessError ? error.code : undefined;
}

function accessStatus(code: string): number {
  switch (code) {
    case "invalid_pairing_code":
      return 401;
    case "pairing_limit_reached":
      return 409;
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
