import type { IncomingMessage, ServerResponse } from "node:http";

/** One static file of the web app, keyed by its exact URL path. */
export interface WebAsset {
  readonly contentType: string;
  readonly body: string | Buffer;
  /** Long-lived caching for content-hashed files. */
  readonly immutable?: boolean;
}

export type WebAssets = ReadonlyMap<string, WebAsset>;

/** How esbuild.mjs embeds an asset: binary files are base64 text. */
interface EmbeddedWebAsset {
  readonly contentType: string;
  readonly body: string;
  readonly encoding?: "base64";
  readonly immutable?: boolean;
}

/**
 * Replaced at bundle time by esbuild.mjs with the built web app. Undefined
 * when running from source (tests inject their own assets).
 */
declare const __AGENTLINK_WEB_ASSETS__:
  | Readonly<Record<string, EmbeddedWebAsset>>
  | undefined;

/** The web app embedded in the server bundle, if this is a bundled build. */
export function bundledWebAssets(): WebAssets | undefined {
  if (typeof __AGENTLINK_WEB_ASSETS__ === "undefined") return undefined;
  return new Map(
    Object.entries(__AGENTLINK_WEB_ASSETS__).map(([pathname, asset]) => [
      pathname,
      {
        contentType: asset.contentType,
        body:
          asset.encoding === "base64"
            ? Buffer.from(asset.body, "base64")
            : asset.body,
        ...(asset.immutable ? { immutable: true } : {}),
      },
    ]),
  );
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
    ...(asset.immutable
      ? { "cache-control": "public, max-age=31536000, immutable" }
      : {}),
  });
  response.end(method === "HEAD" ? undefined : asset.body);
  return true;
}
