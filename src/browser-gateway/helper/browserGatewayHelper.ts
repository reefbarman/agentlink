import * as fs from "fs/promises";
import * as http from "http";
import * as path from "path";
import { randomUUID } from "crypto";

import {
  listHealthyBrowserGatewayInstances,
  type BrowserGatewayInstanceRecord,
} from "../browserGatewayRegistry.js";
import {
  BROWSER_GATEWAY_HELPER_PROTOCOL_VERSION,
  type BrowserGatewayClientLeaseRequest,
  type BrowserGatewayClientReleaseRequest,
  type BrowserGatewayDeviceRevokeRequest,
  type BrowserGatewayDevicesListResponse,
  type BrowserGatewayHelperDiscoveryRecord,
  type BrowserGatewayHelperHealthResponse,
  type BrowserGatewayInstanceStatusSummary,
  type BrowserGatewayMdnsState,
  type BrowserGatewayPairingCancelRequest,
  type BrowserGatewayPairingCreateRequest,
  type BrowserGatewayPairingCreateResponse,
  type BrowserGatewayPairingStatusResponse,
} from "../protocol.js";
import {
  clearBrowserGatewayHelperDiscovery,
  writeBrowserGatewayHelperDiscovery,
} from "../browserGatewayHelperDiscovery.js";
import { DeviceStore } from "./deviceStore.js";
import { PairingBroker } from "./pairingBroker.js";
import { MdnsAdvertiser, listLanIpv4UrlsForPort } from "./mdnsAdvertiser.js";

export interface HelperRuntimeOptions {
  port: number;
  helperVersion: string;
  idleShutdownMs: number;
  extensionRootPath: string;
  /** Bind to 0.0.0.0 and advertise via mDNS when true. Default false. */
  lanAccess?: boolean;
  /** mDNS hostname (without `.local`). Default "agentlink". */
  mdnsName?: string;
}

const DEFAULT_IDLE_SHUTDOWN_MS = 60_000;
const DEFAULT_HELPER_VERSION = "dev";
const DEFAULT_MDNS_NAME = "agentlink";

function parsePort(value: string | undefined): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error(`invalid_port:${value ?? ""}`);
  }
  return parsed;
}

function parseIdleShutdownMs(value: string | undefined): number {
  if (!value) return DEFAULT_IDLE_SHUTDOWN_MS;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1_000) {
    return DEFAULT_IDLE_SHUTDOWN_MS;
  }
  return Math.floor(parsed);
}

function parseBoolFlag(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return (
    normalized === "1" ||
    normalized === "true" ||
    normalized === "yes" ||
    normalized === "on"
  );
}

function parseArgs(argv: string[]): HelperRuntimeOptions {
  const byKey = new Map<string, string>();
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const [key, ...rest] = arg.slice(2).split("=");
    if (!key) continue;
    byKey.set(key, rest.join("="));
  }

  const port = parsePort(
    byKey.get("port") ?? process.env.AGENTLINK_BROWSER_GATEWAY_PORT,
  );
  const helperVersion =
    byKey.get("helperVersion") ??
    process.env.AGENTLINK_BROWSER_GATEWAY_HELPER_VERSION ??
    DEFAULT_HELPER_VERSION;
  const idleShutdownMs = parseIdleShutdownMs(
    byKey.get("idleShutdownMs") ??
      process.env.AGENTLINK_BROWSER_GATEWAY_IDLE_SHUTDOWN_MS,
  );
  const extensionRootPath =
    byKey.get("extensionRootPath") ??
    process.env.AGENTLINK_EXTENSION_ROOT_PATH ??
    process.cwd();
  const lanAccess = parseBoolFlag(
    byKey.get("lanAccess") ?? process.env.AGENTLINK_BROWSER_GATEWAY_LAN_ACCESS,
  );
  const mdnsName = (
    byKey.get("mdnsName") ??
    process.env.AGENTLINK_BROWSER_GATEWAY_MDNS_NAME ??
    DEFAULT_MDNS_NAME
  ).trim();

  return {
    port,
    helperVersion,
    idleShutdownMs,
    extensionRootPath,
    lanAccess,
    mdnsName: mdnsName || DEFAULT_MDNS_NAME,
  };
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString("utf-8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("invalid_json");
  }
}

async function readFormBody(
  req: http.IncomingMessage,
): Promise<Record<string, string>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf-8");
  const params = new URLSearchParams(raw);
  const result: Record<string, string> = {};
  for (const [key, value] of params.entries()) {
    result[key] = value;
  }
  return result;
}

function writeJson(
  res: http.ServerResponse,
  status: number,
  payload: unknown,
  extraHeaders: http.OutgoingHttpHeaders = {},
): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    ...extraHeaders,
  });
  res.end(body);
}

const BROWSER_SESSION_COOKIE_NAME = "agentlink_bg_session";

type BrowserGatewayInstanceListItem = Omit<
  BrowserGatewayInstanceRecord,
  "authToken"
> & {
  status?: BrowserGatewayInstanceStatusSummary;
};

function writeHtml(
  res: http.ServerResponse,
  status: number,
  body: string,
  headers: http.OutgoingHttpHeaders = {},
): void {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(body);
}

function htmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function isLoopbackAddress(addr: string | undefined): boolean {
  if (!addr) return false;
  const normalized = addr.startsWith("::ffff:") ? addr.slice(7) : addr;
  return (
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized.startsWith("127.")
  );
}

type AuthResult =
  | { kind: "bootstrap" }
  | { kind: "device"; deviceId: string; deviceLabel: string }
  | { kind: "none" };

export class BrowserGatewayHelper {
  private readonly startedAt = new Date();
  private readonly browserBootstrapToken = randomUUID();
  private readonly clientSharedSecret = randomUUID();
  private readonly activeClientLeases = new Map<string, number>();
  private readonly deviceStore: DeviceStore;
  private readonly pairingBroker: PairingBroker;
  private mdnsAdvertiser: MdnsAdvertiser | null = null;
  private mdnsState: BrowserGatewayMdnsState = { enabled: false };
  private idleCheckTimer: NodeJS.Timeout | undefined;
  private discoveryHeartbeatTimer: NodeJS.Timeout | undefined;
  private shuttingDown = false;
  private lastLeaseActivityAtMs = Date.now();
  private readonly bindHost: string;

  constructor(
    private readonly options: HelperRuntimeOptions,
    private readonly server: http.Server,
    injectables: {
      deviceStore?: DeviceStore;
      pairingBroker?: PairingBroker;
      mdnsAdvertiser?: MdnsAdvertiser;
    } = {},
  ) {
    this.deviceStore = injectables.deviceStore ?? new DeviceStore();
    this.pairingBroker = injectables.pairingBroker ?? new PairingBroker();
    this.mdnsAdvertiser = injectables.mdnsAdvertiser ?? null;
    this.bindHost = options.lanAccess ? "0.0.0.0" : "127.0.0.1";
    this.server.timeout = 0;
    this.server.keepAliveTimeout = 0;
    this.server.headersTimeout = 0;
  }

  /** Exposed for tests — the shared secret used for `/internal/*` auth. */
  getClientSharedSecret(): string {
    return this.clientSharedSecret;
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        this.server.off("listening", onListening);
        reject(err);
      };
      const onListening = () => {
        this.server.off("error", onError);
        resolve();
      };
      this.server.once("error", onError);
      this.server.once("listening", onListening);
      this.server.listen(this.options.port, this.bindHost);
    });

    if (this.options.lanAccess) {
      await this.startMdnsAdvertiser();
    }

    await this.writeDiscovery();
    this.discoveryHeartbeatTimer = setInterval(() => {
      void this.writeDiscovery();
    }, 5_000);

    this.lastLeaseActivityAtMs = Date.now();
    this.idleCheckTimer = setInterval(() => {
      void this.maybeShutdownForIdle();
    }, 1_000);

    process.stdout.write(
      JSON.stringify({
        type: "helper_ready",
        port: this.options.port,
        protocolVersion: BROWSER_GATEWAY_HELPER_PROTOCOL_VERSION,
        startedAt: this.startedAt.toISOString(),
        lanAccess: Boolean(this.options.lanAccess),
        mdns: this.mdnsState,
      }) + "\n",
    );
  }

  async stop(reason = "shutdown"): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;

    if (this.idleCheckTimer) {
      clearInterval(this.idleCheckTimer);
      this.idleCheckTimer = undefined;
    }
    if (this.discoveryHeartbeatTimer) {
      clearInterval(this.discoveryHeartbeatTimer);
      this.discoveryHeartbeatTimer = undefined;
    }

    if (this.mdnsAdvertiser) {
      try {
        await this.mdnsAdvertiser.stop();
      } catch {
        // ignore
      }
      this.mdnsAdvertiser = null;
    }

    await clearBrowserGatewayHelperDiscovery();

    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
    });

    process.stdout.write(
      JSON.stringify({
        type: "helper_stopped",
        reason,
      }) + "\n",
    );
  }

  handleRequest = (
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void => {
    const method = req.method ?? "GET";
    const rawUrl = req.url ?? "/";
    const requestUrl = new URL(rawUrl, `http://127.0.0.1:${this.options.port}`);
    const pathname = requestUrl.pathname;

    if (method === "GET" && pathname === "/health") {
      const payload: BrowserGatewayHelperHealthResponse = {
        status: "ok",
        protocolVersion: BROWSER_GATEWAY_HELPER_PROTOCOL_VERSION,
        helperVersion: this.options.helperVersion,
        startedAt: this.startedAt.toISOString(),
        now: new Date().toISOString(),
        uptimeMs: Date.now() - this.startedAt.getTime(),
        activeClientLeases: this.getActiveLeaseCount(),
      };
      writeJson(res, 200, payload);
      return;
    }

    // Internal extension-to-helper endpoints (auth: clientSharedSecret).
    if (pathname.startsWith("/internal/")) {
      if (!this.isInternalClientAuthorized(req)) {
        writeJson(res, 401, { error: "unauthorized" });
        return;
      }
      void this.handleInternalRequest(method, pathname, req, res, requestUrl);
      return;
    }

    // Public pairing endpoints (no cookie required — that's the whole point).
    if (method === "GET" && pathname === "/pair") {
      void this.handlePairingPageGet(res, null);
      return;
    }
    if (method === "POST" && pathname === "/pair") {
      void this.handlePairingPagePost(req, res);
      return;
    }

    if (method === "GET" && pathname === "/") {
      void this.handleRootRequest(req, requestUrl, res);
      return;
    }

    if (method === "GET" && pathname === "/browser-gateway.js") {
      void this.handleStaticAssetRequest(
        "dist/browser-gateway.js",
        "text/javascript; charset=utf-8",
        res,
      );
      return;
    }

    if (method === "GET" && pathname === "/browser-gateway.css") {
      void this.handleStaticAssetRequest(
        "dist/browser-gateway.css",
        "text/css; charset=utf-8",
        res,
      );
      return;
    }

    if (method === "GET" && pathname === "/codicon.css") {
      void this.handleStaticAssetRequest(
        "dist/codicon.css",
        "text/css; charset=utf-8",
        res,
      );
      return;
    }

    if (
      method === "GET" &&
      (pathname === "/codicon.ttf" || pathname.startsWith("/codicon.ttf"))
    ) {
      void this.handleStaticAssetRequest("dist/codicon.ttf", "font/ttf", res);
      return;
    }

    if (method === "GET" && pathname === "/favicon.ico") {
      void this.handleFaviconRequest(res);
      return;
    }

    if (method === "GET" && pathname === "/api/instances") {
      void this.authThen(req, res, async (auth) => {
        await this.handleInstancesRequest(requestUrl, res);
        void this.recordDeviceActivity(auth);
      });
      return;
    }

    if (method === "GET" && pathname === "/events") {
      void this.authThen(req, res, async (auth) => {
        await this.handleProxyRequest(req, res, requestUrl);
        void this.recordDeviceActivity(auth);
      });
      return;
    }

    if (pathname.startsWith("/api/")) {
      void this.authThen(req, res, async (auth) => {
        await this.handleProxyRequest(req, res, requestUrl);
        void this.recordDeviceActivity(auth);
      });
      return;
    }

    writeJson(res, 404, { error: "not_found" });
  };

  private async authThen(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    handler: (auth: AuthResult) => Promise<void>,
  ): Promise<void> {
    const auth = await this.authenticateRequest(req);
    if (auth.kind === "none") {
      writeJson(res, 401, { error: "unauthorized" });
      return;
    }
    await handler(auth);
  }

  private async handleInternalRequest(
    method: string,
    pathname: string,
    req: http.IncomingMessage,
    res: http.ServerResponse,
    requestUrl: URL,
  ): Promise<void> {
    if (method === "POST" && pathname === "/internal/client/lease") {
      await this.handleLeaseRequest(req, res);
      return;
    }
    if (method === "POST" && pathname === "/internal/client/release") {
      await this.handleReleaseRequest(req, res);
      return;
    }
    if (method === "POST" && pathname === "/internal/pairing/create") {
      await this.handlePairingCreate(req, res);
      return;
    }
    if (method === "POST" && pathname === "/internal/pairing/cancel") {
      await this.handlePairingCancel(req, res);
      return;
    }
    if (method === "GET" && pathname === "/internal/pairing/status") {
      await this.handlePairingStatus(requestUrl, res);
      return;
    }
    if (method === "GET" && pathname === "/internal/devices") {
      await this.handleDevicesList(res);
      return;
    }
    if (method === "POST" && pathname === "/internal/devices/revoke") {
      await this.handleDevicesRevoke(req, res);
      return;
    }
    writeJson(res, 404, { error: "not_found" });
  }

  private async handleRootRequest(
    req: http.IncomingMessage,
    requestUrl: URL,
    res: http.ServerResponse,
  ): Promise<void> {
    const loopback = isLoopbackAddress(req.socket.remoteAddress);
    const auth = await this.authenticateRequest(req);

    // Loopback: trusted, auto-issue bootstrap cookie (unchanged behavior).
    if (loopback) {
      const instances = await listHealthyBrowserGatewayInstances();
      const requestedInstanceId = requestUrl.searchParams
        .get("instanceId")
        ?.trim();
      const selectedInstance = this.selectInstance(
        instances,
        requestedInstanceId,
      );
      writeHtml(
        res,
        200,
        this.renderIndexHtml(
          selectedInstance?.instanceId ?? "",
          selectedInstance?.workspaceName ?? "No Workspace",
        ),
        { "Set-Cookie": this.buildBootstrapCookie() },
      );
      return;
    }

    // LAN: require prior pairing. If not authed, show the pairing page.
    if (auth.kind === "none") {
      await this.handlePairingPageGet(res, null);
      return;
    }

    const instances = await listHealthyBrowserGatewayInstances();
    const requestedInstanceId = requestUrl.searchParams
      .get("instanceId")
      ?.trim();
    const selectedInstance = this.selectInstance(
      instances,
      requestedInstanceId,
    );
    writeHtml(
      res,
      200,
      this.renderIndexHtml(
        selectedInstance?.instanceId ?? "",
        selectedInstance?.workspaceName ?? "No Workspace",
      ),
    );
    void this.recordDeviceActivity(auth);
  }

  private async handleInstancesRequest(
    requestUrl: URL,
    res: http.ServerResponse,
  ): Promise<void> {
    const instances = await listHealthyBrowserGatewayInstances();
    const requestedInstanceId = requestUrl.searchParams
      .get("instanceId")
      ?.trim();
    const selectedInstance = this.selectInstance(
      instances,
      requestedInstanceId,
    );
    const enrichedInstances = await this.buildInstanceListItems(instances);

    this.writeInstancesJson(
      res,
      selectedInstance?.instanceId ?? "",
      enrichedInstances,
    );
  }

  private async handleProxyRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    requestUrl: URL,
  ): Promise<void> {
    const requestedInstanceId = requestUrl.searchParams
      .get("instanceId")
      ?.trim();
    const instances = await listHealthyBrowserGatewayInstances();
    const instance = this.selectInstance(instances, requestedInstanceId);

    if (!instance) {
      this.writeInstancesJson(
        res,
        "",
        instances,
        503,
        "no_instances_available",
      );
      return;
    }

    await this.proxyToInstance(req, res, requestUrl, instance);
  }

  private selectInstance(
    instances: BrowserGatewayInstanceRecord[],
    requestedInstanceId?: string,
  ): BrowserGatewayInstanceRecord | null {
    if (instances.length === 0) return null;
    if (requestedInstanceId) {
      const exact = instances.find((i) => i.instanceId === requestedInstanceId);
      if (exact) return exact;
    }
    return instances[0] ?? null;
  }

  private async buildInstanceListItems(
    instances: BrowserGatewayInstanceRecord[],
  ): Promise<BrowserGatewayInstanceListItem[]> {
    const statuses = await Promise.all(
      instances.map((instance) => this.fetchInstanceStatus(instance)),
    );

    return instances.map(({ authToken: _authToken, ...instance }, index) => ({
      ...instance,
      status: statuses[index],
    }));
  }

  private async fetchInstanceStatus(
    instance: BrowserGatewayInstanceRecord,
  ): Promise<BrowserGatewayInstanceStatusSummary | undefined> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 750);
    try {
      const response = await fetch(`${instance.url}/api/instance-status`, {
        headers: { authorization: `Bearer ${instance.authToken}` },
        signal: controller.signal,
      });
      if (!response.ok) return undefined;
      return (await response.json()) as BrowserGatewayInstanceStatusSummary;
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  private writeInstancesJson(
    res: http.ServerResponse,
    currentInstanceId: string,
    instances: BrowserGatewayInstanceListItem[],
    status = 200,
    error?: string,
  ): void {
    const body = {
      currentInstanceId,
      instances,
      error,
    };
    writeJson(res, status, body);
  }

  private async proxyToInstance(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    requestUrl: URL,
    instance: BrowserGatewayInstanceRecord,
  ): Promise<void> {
    const isEventStream = requestUrl.pathname === "/events";
    if (isEventStream) {
      req.socket.setTimeout(0);
      res.socket?.setTimeout(0);
    }
    const targetBase = new URL(instance.url);
    const forwardedUrl = new URL(requestUrl.pathname, targetBase);

    for (const [key, value] of requestUrl.searchParams.entries()) {
      if (key === "instanceId") continue;
      forwardedUrl.searchParams.append(key, value);
    }

    const headers: http.OutgoingHttpHeaders = { ...req.headers };
    delete headers.host;
    if (instance.authToken && instance.authToken.trim()) {
      headers.authorization = `Bearer ${instance.authToken}`;
    } else {
      delete headers.authorization;
    }

    await new Promise<void>((resolve) => {
      const proxyReq = http.request(
        {
          protocol: targetBase.protocol,
          hostname: targetBase.hostname,
          port: targetBase.port,
          method: req.method,
          path: `${forwardedUrl.pathname}${forwardedUrl.search}`,
          headers,
          timeout: isEventStream ? 0 : undefined,
        },
        (proxyRes) => {
          if (isEventStream) {
            proxyRes.socket.setTimeout(0);
          }
          const statusCode = proxyRes.statusCode ?? 502;
          const responseHeaders = { ...proxyRes.headers };
          res.writeHead(statusCode, responseHeaders);
          proxyRes.pipe(res);
          proxyRes.on("end", () => resolve());
          proxyRes.on("close", () => resolve());
        },
      );

      proxyReq.on("error", (error) => {
        if (!res.headersSent) {
          writeJson(res, 502, {
            error: "proxy_error",
            detail: String(error),
          });
        }
        resolve();
      });

      req.on("aborted", () => {
        proxyReq.destroy();
      });
      res.on("close", () => {
        proxyReq.destroy();
        resolve();
      });

      if (req.method === "GET" || req.method === "HEAD") {
        proxyReq.end();
      } else {
        req.pipe(proxyReq);
      }
    });
  }

  private isInternalClientAuthorized(req: http.IncomingMessage): boolean {
    const auth = req.headers.authorization;
    return auth === `Bearer ${this.clientSharedSecret}`;
  }

  private buildBootstrapCookie(): string {
    return `${BROWSER_SESSION_COOKIE_NAME}=${encodeURIComponent(this.browserBootstrapToken)}; Path=/; HttpOnly; SameSite=Lax`;
  }

  private buildDeviceCookie(token: string): string {
    // Persist across restarts — a year. Pairing is revocable server-side.
    const maxAge = 60 * 60 * 24 * 365;
    return `${BROWSER_SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
  }

  private readCookie(req: http.IncomingMessage, name: string): string | null {
    const cookieHeader = req.headers.cookie;
    if (!cookieHeader) return null;
    const pairs = cookieHeader.split(";");
    for (const pair of pairs) {
      const trimmed = pair.trim();
      if (!trimmed) continue;
      const [rawName, ...rawValueParts] = trimmed.split("=");
      if (rawName !== name) continue;
      const rawValue = rawValueParts.join("=");
      try {
        return decodeURIComponent(rawValue);
      } catch {
        return rawValue;
      }
    }
    return null;
  }

  private async authenticateRequest(
    req: http.IncomingMessage,
  ): Promise<AuthResult> {
    const cookieToken = this.readCookie(req, BROWSER_SESSION_COOKIE_NAME);
    if (!cookieToken) return { kind: "none" };
    if (cookieToken === this.browserBootstrapToken) {
      return { kind: "bootstrap" };
    }
    const device = await this.deviceStore.matchToken(cookieToken);
    if (device) {
      return {
        kind: "device",
        deviceId: device.id,
        deviceLabel: device.label,
      };
    }
    return { kind: "none" };
  }

  private recordDeviceActivity(auth: AuthResult): Promise<void> {
    if (auth.kind !== "device") return Promise.resolve();
    return this.deviceStore.touchLastSeen(auth.deviceId).catch(() => undefined);
  }

  private async handleLeaseRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    try {
      const body = (await readJsonBody(
        req,
      )) as BrowserGatewayClientLeaseRequest;
      if (!body || typeof body.clientId !== "string" || !body.clientId.trim()) {
        writeJson(res, 400, { error: "invalid_request" });
        return;
      }

      const ttlMs =
        typeof body.ttlMs === "number" && Number.isFinite(body.ttlMs)
          ? Math.max(5_000, Math.min(body.ttlMs, 120_000))
          : 30_000;
      const leaseExpiresAtMs = Date.now() + ttlMs;
      const clientId = body.clientId.trim();
      this.activeClientLeases.set(clientId, leaseExpiresAtMs);
      this.lastLeaseActivityAtMs = Date.now();

      await this.writeDiscovery();

      writeJson(res, 200, {
        ok: true,
        clientId,
        leaseExpiresAt: new Date(leaseExpiresAtMs).toISOString(),
      });
    } catch (err) {
      const invalidJson = String(err) === "Error: invalid_json";
      writeJson(res, invalidJson ? 400 : 500, {
        error: invalidJson ? "invalid_json" : "internal_error",
      });
    }
  }

  private async handleReleaseRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    try {
      const body = (await readJsonBody(
        req,
      )) as BrowserGatewayClientReleaseRequest;
      if (!body || typeof body.clientId !== "string" || !body.clientId.trim()) {
        writeJson(res, 400, { error: "invalid_request" });
        return;
      }

      this.activeClientLeases.delete(body.clientId.trim());
      this.lastLeaseActivityAtMs = Date.now();
      await this.writeDiscovery();

      writeJson(res, 200, { ok: true });
    } catch (err) {
      const invalidJson = String(err) === "Error: invalid_json";
      writeJson(res, invalidJson ? 400 : 500, {
        error: invalidJson ? "invalid_json" : "internal_error",
      });
    }
  }

  private async handlePairingCreate(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    try {
      const body = (await readJsonBody(
        req,
      )) as BrowserGatewayPairingCreateRequest | null;
      const label =
        body && typeof body.label === "string"
          ? body.label.trim().slice(0, 200)
          : undefined;
      const pairing = this.pairingBroker.create({ label });

      const urls = this.buildPairingUrls();
      const response: BrowserGatewayPairingCreateResponse = {
        pairingId: pairing.pairingId,
        code: pairing.code,
        expiresAt: new Date(pairing.expiresAt).toISOString(),
        pairingUrls: urls,
      };
      writeJson(res, 200, response);
    } catch (err) {
      const invalidJson = String(err) === "Error: invalid_json";
      writeJson(res, invalidJson ? 400 : 500, {
        error: invalidJson ? "invalid_json" : "internal_error",
      });
    }
  }

  private async handlePairingCancel(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    try {
      const body = (await readJsonBody(
        req,
      )) as BrowserGatewayPairingCancelRequest | null;
      if (!body || typeof body.pairingId !== "string") {
        writeJson(res, 400, { error: "invalid_request" });
        return;
      }
      this.pairingBroker.cancel(body.pairingId);
      writeJson(res, 200, { ok: true });
    } catch (err) {
      const invalidJson = String(err) === "Error: invalid_json";
      writeJson(res, invalidJson ? 400 : 500, {
        error: invalidJson ? "invalid_json" : "internal_error",
      });
    }
  }

  private async handlePairingStatus(
    requestUrl: URL,
    res: http.ServerResponse,
  ): Promise<void> {
    const id = requestUrl.searchParams.get("id");
    if (!id) {
      writeJson(res, 400, { error: "missing_id" });
      return;
    }
    const status = this.pairingBroker.getStatus(id);
    if (!status) {
      const notFound: BrowserGatewayPairingStatusResponse = {
        pairingId: id,
        status: "expired",
        expiresAt: new Date(0).toISOString(),
      };
      writeJson(res, 200, notFound);
      return;
    }
    writeJson(res, 200, status);
  }

  private async handleDevicesList(res: http.ServerResponse): Promise<void> {
    const devices = await this.deviceStore.list();
    const response: BrowserGatewayDevicesListResponse = { devices };
    writeJson(res, 200, response);
  }

  private async handleDevicesRevoke(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    try {
      const body = (await readJsonBody(
        req,
      )) as BrowserGatewayDeviceRevokeRequest | null;
      if (!body || typeof body.deviceId !== "string") {
        writeJson(res, 400, { error: "invalid_request" });
        return;
      }
      const removed = await this.deviceStore.revoke(body.deviceId);
      writeJson(res, 200, { ok: true, removed });
    } catch (err) {
      const invalidJson = String(err) === "Error: invalid_json";
      writeJson(res, invalidJson ? 400 : 500, {
        error: invalidJson ? "invalid_json" : "internal_error",
      });
    }
  }

  private async handlePairingPageGet(
    res: http.ServerResponse,
    errorMessage: string | null,
  ): Promise<void> {
    writeHtml(res, 200, this.renderPairingHtml(errorMessage));
  }

  private async handlePairingPagePost(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    let code = "";
    const contentType = req.headers["content-type"] ?? "";
    try {
      if (contentType.includes("application/json")) {
        const body = (await readJsonBody(req)) as { code?: unknown };
        code = typeof body?.code === "string" ? body.code : "";
      } else {
        const form = await readFormBody(req);
        code = form.code ?? "";
      }
    } catch {
      writeHtml(res, 400, this.renderPairingHtml("Invalid request."));
      return;
    }

    const remote = req.socket.remoteAddress ?? "unknown";
    const attemptResult = this.pairingBroker.attempt(code, remote);
    if (!attemptResult.ok) {
      const reasonText =
        attemptResult.reason === "rate_limited"
          ? "Too many attempts. Try again in a few minutes."
          : attemptResult.reason === "expired"
            ? "That code has expired. Generate a new one in the AgentLink chat."
            : "That code isn't valid. Check the characters and try again.";
      writeHtml(res, 401, this.renderPairingHtml(reasonText));
      return;
    }

    const deviceLabel =
      attemptResult.label ??
      this.buildDefaultDeviceLabel(
        req.headers["user-agent"] ?? "Unknown device",
        remote,
      );
    const { token, device } = await this.deviceStore.register(deviceLabel);
    this.pairingBroker.markConsumed(
      attemptResult.pairingId,
      device.id,
      device.label,
    );

    const destination = "/";
    res.writeHead(303, {
      Location: destination,
      "Set-Cookie": this.buildDeviceCookie(token),
      "Cache-Control": "no-store",
    });
    res.end();
  }

  private buildDefaultDeviceLabel(userAgent: string, remote: string): string {
    const shortened = userAgent.slice(0, 80);
    const normalizedRemote = remote.startsWith("::ffff:")
      ? remote.slice(7)
      : remote;
    return `${shortened} (${normalizedRemote})`;
  }

  private buildPairingUrls(): string[] {
    const urls = new Set<string>();
    if (this.mdnsState.enabled && this.mdnsState.url) {
      urls.add(`${this.mdnsState.url}/pair`);
    }
    for (const url of listLanIpv4UrlsForPort(this.options.port)) {
      urls.add(`${url}/pair`);
    }
    // Always include loopback as a last-resort debug URL.
    urls.add(`http://127.0.0.1:${this.options.port}/pair`);
    return Array.from(urls);
  }

  private async startMdnsAdvertiser(): Promise<void> {
    const advertiser =
      this.mdnsAdvertiser ??
      new MdnsAdvertiser({
        desiredName: this.options.mdnsName ?? DEFAULT_MDNS_NAME,
        port: this.options.port,
        log: (message) => process.stdout.write(`${message}\n`),
      });
    this.mdnsAdvertiser = advertiser;
    try {
      const state = await advertiser.start();
      this.mdnsState = {
        enabled: true,
        hostName: state.hostName,
        url: state.urls[0],
      };
    } catch (err) {
      process.stderr.write(
        `[mdns] failed to start — falling back to IP access only: ${String(err)}\n`,
      );
      this.mdnsState = { enabled: false };
      this.mdnsAdvertiser = null;
    }
  }

  private getActiveLeaseCount(nowMs = Date.now()): number {
    for (const [clientId, expiresAt] of this.activeClientLeases) {
      if (expiresAt <= nowMs) {
        this.activeClientLeases.delete(clientId);
      }
    }
    return this.activeClientLeases.size;
  }

  private async maybeShutdownForIdle(): Promise<void> {
    if (this.shuttingDown) return;
    const active = this.getActiveLeaseCount();
    const idleForMs = Date.now() - this.lastLeaseActivityAtMs;

    if (active > 0) return;
    if (idleForMs < this.options.idleShutdownMs) return;

    await this.stop("idle");
    process.exit(0);
  }

  private async writeDiscovery(): Promise<void> {
    const lanUrls = this.options.lanAccess
      ? listLanIpv4UrlsForPort(this.options.port)
      : [];
    const record: BrowserGatewayHelperDiscoveryRecord = {
      pid: process.pid,
      port: this.options.port,
      url: `http://127.0.0.1:${this.options.port}`,
      protocolVersion: BROWSER_GATEWAY_HELPER_PROTOCOL_VERSION,
      startedAt: this.startedAt.toISOString(),
      lastHeartbeatAt: new Date().toISOString(),
      helperVersion: this.options.helperVersion,
      browserBootstrapToken: this.browserBootstrapToken,
      clientSharedSecret: this.clientSharedSecret,
      lanAccess: Boolean(this.options.lanAccess),
      mdnsHostName: this.mdnsState.hostName,
      mdnsUrl: this.mdnsState.url,
      lanUrls,
    };
    await writeBrowserGatewayHelperDiscovery(record);
  }

  private async handleFaviconRequest(res: http.ServerResponse): Promise<void> {
    try {
      const iconPath = path.join(
        this.options.extensionRootPath,
        "media",
        "icon.png",
      );
      const content = await fs.readFile(iconPath);
      res.writeHead(200, { "Content-Type": "image/png" });
      res.end(content);
    } catch {
      writeJson(res, 404, { error: "not_found" });
    }
  }

  private async handleStaticAssetRequest(
    relativePath: string,
    contentType: string,
    res: http.ServerResponse,
  ): Promise<void> {
    try {
      const assetPath = path.join(this.options.extensionRootPath, relativePath);
      const content = await fs.readFile(assetPath);
      res.writeHead(200, { "Content-Type": contentType });
      res.end(content);
    } catch {
      writeJson(res, 404, { error: "not_found" });
    }
  }

  private renderIndexHtml(
    currentInstanceId: string,
    workspaceName: string,
  ): string {
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>AgentLink Browser Gateway</title>
  <link rel="stylesheet" href="/codicon.css">
  <link rel="stylesheet" href="/browser-gateway.css">
</head>
<body>
  <div id="root"></div>
  <script>
    window.__AGENTLINK_BROWSER_GATEWAY__ = {
      authToken: "",
      currentInstanceId: ${JSON.stringify(currentInstanceId)},
      workspaceName: ${JSON.stringify(workspaceName)},
      routeByInstance: true
    };
  </script>
  <script type="module" src="/browser-gateway.js"></script>
</body>
</html>`;
  }

  private renderPairingHtml(errorMessage: string | null): string {
    const errorBlock = errorMessage
      ? `<p class="pair-error" role="alert">${htmlEscape(errorMessage)}</p>`
      : "";
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Pair with AgentLink</title>
  <style>
    :root { color-scheme: light dark; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
      background: #1e1e1e;
      color: #d4d4d4;
      margin: 0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 16px;
    }
    .pair-card {
      background: #252526;
      border: 1px solid #3c3c3c;
      border-radius: 12px;
      padding: 32px 28px;
      max-width: 420px;
      width: 100%;
      box-shadow: 0 12px 32px rgba(0,0,0,0.35);
    }
    .pair-brand {
      display: flex;
      align-items: center;
      gap: 10px;
      font-weight: 600;
      letter-spacing: 0.02em;
      color: #4EC9B0;
      margin-bottom: 18px;
    }
    .pair-brand .dot { width: 10px; height: 10px; border-radius: 50%; background: #4EC9B0; }
    h1 { margin: 0 0 6px; font-size: 20px; }
    p { margin: 8px 0 16px; line-height: 1.5; font-size: 14px; color: #bbb; }
    .pair-error {
      background: rgba(244, 71, 71, 0.12);
      border: 1px solid rgba(244, 71, 71, 0.4);
      color: #f48771;
      padding: 10px 12px;
      border-radius: 8px;
      font-size: 13px;
    }
    form { display: flex; flex-direction: column; gap: 14px; margin-top: 8px; }
    input[name="code"] {
      font-size: 32px;
      letter-spacing: 8px;
      text-align: center;
      padding: 14px;
      border-radius: 10px;
      border: 1px solid #3c3c3c;
      background: #1e1e1e;
      color: #d4d4d4;
      font-family: "SF Mono", Menlo, Consolas, monospace;
    }
    input[name="code"]:focus {
      outline: none;
      border-color: #4EC9B0;
      box-shadow: 0 0 0 3px rgba(78,201,176,0.2);
    }
    button {
      font-size: 15px;
      padding: 12px;
      border-radius: 10px;
      border: 0;
      background: #4EC9B0;
      color: #111;
      font-weight: 600;
      cursor: pointer;
    }
    button:hover { background: #5ed7bf; }
    .pair-footnote { margin-top: 12px; font-size: 12px; color: #888; }
  </style>
</head>
<body>
  <main class="pair-card">
    <div class="pair-brand"><span class="dot"></span>AgentLink</div>
    <h1>Pair this device</h1>
    <p>Enter the 6-digit code shown in AgentLink on your computer. Codes expire after a few minutes.</p>
    ${errorBlock}
    <form method="post" action="/pair" autocomplete="off" novalidate>
      <input
        name="code"
        inputmode="numeric"
        pattern="[0-9]{6}"
        maxlength="6"
        placeholder="000000"
        autofocus
        required
      />
      <button type="submit">Pair device</button>
    </form>
    <div class="pair-footnote">After pairing, this browser stays signed in until you revoke it from the AgentLink chat.</div>
  </main>
</body>
</html>`;
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const server = http.createServer();
  const helper = new BrowserGatewayHelper(options, server);
  server.on("request", helper.handleRequest);

  process.on("SIGINT", () => {
    void helper.stop("sigint").finally(() => process.exit(0));
  });
  process.on("SIGTERM", () => {
    void helper.stop("sigterm").finally(() => process.exit(0));
  });

  try {
    await helper.start();
  } catch (error) {
    process.stderr.write(
      `[browser-gateway-helper] failed to start: ${String(error)}\n`,
    );
    process.exit(1);
  }
}

function isDirectHelperEntry(): boolean {
  const entry = process.argv[1] ?? "";
  return (
    entry.endsWith("/browser-gateway-helper.js") ||
    entry.endsWith("\\browser-gateway-helper.js") ||
    entry.endsWith("/browserGatewayHelper.ts") ||
    entry.endsWith("\\browserGatewayHelper.ts")
  );
}

if (isDirectHelperEntry()) {
  void main();
}
