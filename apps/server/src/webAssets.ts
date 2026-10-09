import type { IncomingMessage, ServerResponse } from "node:http";

/** One static file of the web app, keyed by its exact URL path. */
export interface WebAsset {
  readonly contentType: string;
  readonly body: string;
}

export type WebAssets = ReadonlyMap<string, WebAsset>;

/**
 * Replaced at bundle time by esbuild.mjs with the built web app. Undefined
 * when running from source (tests inject their own assets).
 */
declare const __AGENTLINK_WEB_ASSETS__:
  | Readonly<Record<string, WebAsset>>
  | undefined;

/** The web app embedded in the server bundle, if this is a bundled build. */
export function bundledWebAssets(): WebAssets | undefined {
  if (typeof __AGENTLINK_WEB_ASSETS__ === "undefined") return undefined;
  return new Map(Object.entries(__AGENTLINK_WEB_ASSETS__));
}

/**
 * Serve a web app file for `GET`/`HEAD`. The files hold no data, so they are
 * served without a session; every `/api/` path is left to the API.
 * Returns false when the request is not for a web app file.
 */
export function serveWebAsset(
  request: IncomingMessage,
  response: ServerResponse,
  assets: WebAssets | undefined,
): boolean {
  const method = (request.method ?? "GET").toUpperCase();
  if (!assets || (method !== "GET" && method !== "HEAD")) return false;
  const pathname = new URL(request.url ?? "/", "https://server.invalid")
    .pathname;
  if (pathname.startsWith("/api/")) return false;
  const asset = assets.get(pathname);
  if (!asset) return false;
  response.writeHead(200, {
    "content-type": asset.contentType,
    "content-length": Buffer.byteLength(asset.body),
  });
  response.end(method === "HEAD" ? undefined : asset.body);
  return true;
}
