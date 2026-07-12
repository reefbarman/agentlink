import type * as http from "http";

import {
  matchAskAgentRoute,
  matchInternalCoreRoute,
  matchInternalDeviceRoute,
  matchPairedBrowserRoute,
  matchPublicHelperRoute,
  type AskAgentRouteHandler,
  type InternalCoreRouteHandler,
  type InternalDeviceRouteHandler,
  type PairedBrowserRouteHandler,
  type PublicHelperRouteHandler,
} from "./helperRouteFamilies.js";

export interface HelperHttpRouterHost<TAuth> {
  isInternalAuthorized(req: http.IncomingMessage): boolean;
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
    handler: () => Promise<void>,
  ): Promise<void> {
    const auth = await this.host.authenticate(req);
    if (auth === null) {
      this.host.writeJson(res, 401, { error: "unauthorized" });
      return;
    }
    await handler();
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
