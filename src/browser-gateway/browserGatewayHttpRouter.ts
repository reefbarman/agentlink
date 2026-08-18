import type * as http from "http";

export type BrowserGatewayHttpMethod =
  | "GET"
  | "POST"
  | "DELETE"
  | "PUT"
  | "PATCH"
  | "HEAD"
  | "OPTIONS"
  | "*";

export type BrowserGatewayRouteMatch =
  | { kind: "raw-exact"; value: string }
  | { kind: "path-exact"; value: string }
  | { kind: "raw-prefix"; value: string }
  | { kind: "path-prefix"; value: string };

export type BrowserGatewayRouteErrorPolicy =
  | { kind: "none" }
  | { kind: "internal"; logLabel: string }
  | { kind: "invalid-json-or-internal"; logLabel: string };

export interface BrowserGatewayRouteContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  rawUrl: string;
  pathOnly: string;
}

export interface BrowserGatewayHttpRoute {
  method: BrowserGatewayHttpMethod;
  match: BrowserGatewayRouteMatch;
  error: BrowserGatewayRouteErrorPolicy;
  authorize?: (context: BrowserGatewayRouteContext) => boolean;
  invoke: (context: BrowserGatewayRouteContext) => void | Promise<void>;
}

export interface BrowserGatewayHttpRouterHost {
  writeJson(res: http.ServerResponse, status: number, body: unknown): void;
  log(message: string): void;
}

export function matchesBrowserGatewayRoute(
  route: BrowserGatewayHttpRoute,
  method: string,
  rawUrl: string,
  pathOnly: string,
): boolean {
  if (route.method !== "*" && route.method !== method) return false;
  switch (route.match.kind) {
    case "raw-exact":
      return rawUrl === route.match.value;
    case "path-exact":
      return pathOnly === route.match.value;
    case "raw-prefix":
      return rawUrl.startsWith(route.match.value);
    case "path-prefix":
      return pathOnly.startsWith(route.match.value);
  }
}

export class BrowserGatewayHttpRouter {
  constructor(
    private readonly routes: readonly BrowserGatewayHttpRoute[],
    private readonly host: BrowserGatewayHttpRouterHost,
  ) {}

  dispatch(req: http.IncomingMessage, res: http.ServerResponse): void {
    const method = req.method ?? "GET";
    const rawUrl = req.url ?? "/";
    const pathOnly = rawUrl.split("?", 1)[0] ?? rawUrl;
    const route = this.routes.find((candidate) =>
      matchesBrowserGatewayRoute(candidate, method, rawUrl, pathOnly),
    );
    if (!route) {
      this.host.writeJson(res, 404, { error: "not_found" });
      return;
    }

    const context = { req, res, rawUrl, pathOnly };
    if (route.authorize && !route.authorize(context)) {
      this.host.writeJson(res, 401, { error: "unauthorized" });
      return;
    }

    const result = route.invoke(context);
    if (!result || route.error.kind === "none") return;
    const errorPolicy = route.error;
    void result.catch((error: unknown) => {
      this.host.log(`[browser-gateway] ${errorPolicy.logLabel}: ${error}`);
      if (res.headersSent) return;
      if (
        errorPolicy.kind === "invalid-json-or-internal" &&
        String(error) === "Error: invalid_json"
      ) {
        this.host.writeJson(res, 400, { error: "invalid_json" });
        return;
      }
      this.host.writeJson(res, 500, { error: "internal_error" });
    });
  }
}
