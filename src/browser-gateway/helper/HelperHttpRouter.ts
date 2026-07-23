import type * as http from "http";

import {
  matchAskAgentRoute,
  matchBrowserRelayRoute,
  matchInternalCoreRoute,
  matchInternalDataPlaneRoute,
  matchInternalDeviceRoute,
  matchPairedBrowserRoute,
  matchPublicHelperRoute,
  type AskAgentRouteHandler,
  type BrowserRelayRouteHandler,
  type InternalCoreRouteHandler,
  type InternalDataPlaneRouteHandler,
  type InternalDeviceRouteHandler,
  type PairedBrowserRouteHandler,
  type PublicHelperRouteHandler,
} from "./helperRouteFamilies.js";

export interface HelperHttpRouterHost<TAuth> {
  isInternalAuthorized(req: http.IncomingMessage): boolean;
  isOwnerPlaneLoopback(req: http.IncomingMessage): boolean;
  authenticate(req: http.IncomingMessage): Promise<TAuth | null>;
  recordAuthenticatedActivity(auth: TAuth): void | Promise<void>;
  handleAskAgent(
    handler: AskAgentRouteHandler,
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void>;
  handleInternalCore(
    handler: InternalCoreRouteHandler,
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void>;
  handleInternalDataPlane(
    handler: InternalDataPlaneRouteHandler,
    req: http.IncomingMessage,
    res: http.ServerResponse,
    requestUrl: URL,
  ): Promise<void>;
  handleInternalDevice(
    handler: InternalDeviceRouteHandler,
    req: http.IncomingMessage,
    res: http.ServerResponse,
    requestUrl: URL,
  ): Promise<void>;
  handlePairedBrowser(
    handler: PairedBrowserRouteHandler,
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void>;
  handleBrowserRelay(
    handler: BrowserRelayRouteHandler,
    auth: TAuth,
    req: http.IncomingMessage,
    res: http.ServerResponse,
    requestUrl: URL,
  ): Promise<void>;
  handlePublic(
    handler: PublicHelperRouteHandler,
    pathname: string,
    req: http.IncomingMessage,
    res: http.ServerResponse,
    requestUrl: URL,
  ): Promise<void>;
  handleInstances(requestUrl: URL, res: http.ServerResponse): Promise<void>;
  handleProxy(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    requestUrl: URL,
  ): Promise<void>;
  handleShutdown(res: http.ServerResponse): void;
  writeJson(res: http.ServerResponse, status: number, payload: unknown): void;
}

function hasExactRawPath(
  rawUrl: string | undefined,
  pathname: string,
): boolean {
  const rawPath = (rawUrl ?? "/").split("?", 1)[0];
  return rawPath === pathname;
}

export class HelperHttpRouter<TAuth> {
  constructor(
    private readonly port: number,
    private readonly host: HelperHttpRouterHost<TAuth>,
  ) {}

  handle = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    const method = req.method ?? "GET";
    const requestUrl = new URL(req.url ?? "/", `http://127.0.0.1:${this.port}`);
    const pathname = requestUrl.pathname;

    if (pathname.startsWith("/internal/")) {
      if (!this.host.isInternalAuthorized(req)) {
        this.host.writeJson(res, 401, { error: "unauthorized" });
        return;
      }
      const dataPlaneRoute = matchInternalDataPlaneRoute(method, pathname);
      const ownerControlRoute =
        pathname === "/internal/core-owners" ||
        pathname.startsWith("/internal/core-owners/");
      if (dataPlaneRoute || ownerControlRoute) {
        if (!hasExactRawPath(req.url, pathname)) {
          this.host.writeJson(res, 404, { error: "not_found" });
          return;
        }
        if (!this.host.isOwnerPlaneLoopback(req)) {
          this.host.writeJson(res, 403, { error: "loopback_required" });
          return;
        }
      }
      if (dataPlaneRoute) {
        void this.host.handleInternalDataPlane(
          dataPlaneRoute.handler,
          req,
          res,
          requestUrl,
        );
        return;
      }
      void this.handleInternal(method, pathname, req, res, requestUrl);
      return;
    }

    const pairedBrowserRoute = matchPairedBrowserRoute(method, pathname);
    if (pairedBrowserRoute) {
      void this.host.handlePairedBrowser(pairedBrowserRoute.handler, req, res);
      return;
    }

    const publicRoute = matchPublicHelperRoute(method, pathname);
    if (publicRoute) {
      void this.host.handlePublic(
        publicRoute.handler,
        pathname,
        req,
        res,
        requestUrl,
      );
      return;
    }

    const browserRelayRoute = matchBrowserRelayRoute(method, pathname);
    if (browserRelayRoute) {
      if (!hasExactRawPath(req.url, pathname)) {
        this.host.writeJson(res, 404, { error: "not_found" });
        return;
      }
      void this.authenticated(req, res, (auth) =>
        this.host.handleBrowserRelay(
          browserRelayRoute.handler,
          auth,
          req,
          res,
          requestUrl,
        ),
      );
      return;
    }

    if (pathname.startsWith("/api/relay/")) {
      this.host.writeJson(res, 404, { error: "not_found" });
      return;
    }

    const askAgentRoute = matchAskAgentRoute(method, pathname);
    if (askAgentRoute) {
      void this.authenticated(req, res, () =>
        this.host.handleAskAgent(askAgentRoute.handler, req, res),
      );
      return;
    }

    if (method === "GET" && pathname === "/api/instances") {
      void this.authenticated(req, res, () =>
        this.host.handleInstances(requestUrl, res),
      );
      return;
    }

    if (
      (method === "GET" && pathname === "/events") ||
      pathname.startsWith("/api/")
    ) {
      void this.authenticated(req, res, () =>
        this.host.handleProxy(req, res, requestUrl),
      );
      return;
    }

    this.host.writeJson(res, 404, { error: "not_found" });
  };

  private async authenticated(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    handler: (auth: TAuth) => Promise<void>,
  ): Promise<void> {
    const auth = await this.host.authenticate(req);
    if (auth === null) {
      this.host.writeJson(res, 401, { error: "unauthorized" });
      return;
    }
    await handler(auth);
    void this.host.recordAuthenticatedActivity(auth);
  }

  private async handleInternal(
    method: string,
    pathname: string,
    req: http.IncomingMessage,
    res: http.ServerResponse,
    requestUrl: URL,
  ): Promise<void> {
    const internalCoreRoute = matchInternalCoreRoute(method, pathname);
    if (internalCoreRoute) {
      await this.host.handleInternalCore(internalCoreRoute.handler, req, res);
      return;
    }
    if (method === "POST" && pathname === "/internal/shutdown") {
      this.host.handleShutdown(res);
      return;
    }
    const internalDeviceRoute = matchInternalDeviceRoute(method, pathname);
    if (internalDeviceRoute) {
      await this.host.handleInternalDevice(
        internalDeviceRoute.handler,
        req,
        res,
        requestUrl,
      );
      return;
    }
    this.host.writeJson(res, 404, { error: "not_found" });
  }
}
