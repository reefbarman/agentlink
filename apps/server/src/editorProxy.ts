import http, { type IncomingMessage, type ServerResponse } from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";

import { SESSION_COOKIE_NAME, singleHeader } from "./requestGuard.js";
import type { TaskEditors } from "./taskEditors.js";

/**
 * The editor origin: a second HTTPS listener (default port 8444, the same
 * certificate and host names as the app) that serves task editors, so the
 * editor's pages, webviews and extensions never run on the app's origin.
 *
 * - `GET /open?token=…` redeems a one-time link from the app and sets an
 *   editor cookie for that task only (path `/t/<task>/`), then redirects
 *   there.
 * - `/t/<task>/…` (HTTP and WebSockets) goes to that task's code-server
 *   with the prefix removed, only with that task's editor cookie. Unsafe
 *   methods and WebSockets also need an `Origin` of this listener.
 * - The app's session cookie is never accepted here and never forwarded
 *   (cookies ignore ports, so browsers send it); neither are editor
 *   cookies.
 */

export const EDITOR_COOKIE_PREFIX = "__Secure-agentlink_editor_";
const TASK_PATH = /^\/t\/([0-9a-f]{12})(\/.*)?$/u;
const SESSION_MAX_AGE_SECONDS = 12 * 60 * 60;
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "cookie",
]);

export interface EditorProxy {
  readonly port: number;
  setTls(tls: {
    readonly cert: string | Buffer;
    readonly key: string | Buffer;
  }): void;
  close(): Promise<void>;
}

/** Cookies to forward to code-server: never the app's or the editor's. */
export function editorUpstreamCookies(
  header: string | undefined,
): string | undefined {
  if (!header) return undefined;
  const kept = header
    .split(";")
    .map((part) => part.trim())
    .filter((part) => {
      const name = part.slice(0, Math.max(0, part.indexOf("="))).trim();
      return (
        name !== "" &&
        name !== SESSION_COOKIE_NAME &&
        !name.startsWith(EDITOR_COOKIE_PREFIX)
      );
    });
  return kept.length > 0 ? kept.join("; ") : undefined;
}

function editorCookie(header: string | undefined, taskId: string) {
  if (!header) return undefined;
  const name = `${EDITOR_COOKIE_PREFIX}${taskId}`;
  let found: string | undefined;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    if (found !== undefined) return undefined;
    found = part.slice(separator + 1).trim();
  }
  return found;
}

export async function startEditorProxy(options: {
  readonly editors: Pick<
    TaskEditors,
    "redeem" | "authorize" | "touch" | "connection"
  >;
  readonly tls: {
    readonly cert: string | Buffer;
    readonly key: string | Buffer;
  };
  readonly listen: { readonly host: string; readonly port: number };
  /** Host names the app answers on (from `publicOrigins`). */
  readonly hosts: readonly string[];
  readonly log: (line: string) => void;
  /** Tests: plain HTTP instead of TLS. */
  readonly insecure?: boolean;
}): Promise<EditorProxy> {
  const hosts = new Set(options.hosts.map((host) => host.toLowerCase()));

  /** This listener's own origin for the request's Host, if it is allowed. */
  const originFor = (request: IncomingMessage): string | undefined => {
    const host = singleHeader(request.headers.host);
    if (!host) return undefined;
    try {
      const url = new URL(`${options.insecure ? "http" : "https"}://${host}`);
      return hosts.has(url.hostname.replace(/^\[|\]$/gu, "").toLowerCase())
        ? url.origin
        : undefined;
    } catch {
      return undefined;
    }
  };

  const page = (response: ServerResponse, status: number, text: string) => {
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Editor</title></head><body style="font-family: system-ui, sans-serif; padding: 2rem"><p>${text}</p></body></html>`;
    response.writeHead(status, {
      "content-type": "text/html; charset=utf-8",
      "content-length": Buffer.byteLength(html),
      "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'",
      "cache-control": "no-store",
    });
    response.end(html);
  };

  /** The editor a request may reach, after the Host, cookie and Origin. */
  const route = (
    request: IncomingMessage,
    upgrade: boolean,
  ):
    | { readonly taskId: string; readonly upstream: URL; readonly path: string }
    | { readonly status: number; readonly text: string }
    | { readonly redirect: string } => {
    const origin = originFor(request);
    if (!origin) return { status: 421, text: "Unknown host." };
    const url = new URL(request.url ?? "/", origin);
    const match = TASK_PATH.exec(url.pathname);
    if (!match) return { status: 404, text: "Not found." };
    const taskId = match[1]!;
    if (match[2] === undefined)
      return { redirect: `/t/${taskId}/${url.search}` };
    const method = (request.method ?? "GET").toUpperCase();
    if (
      (upgrade || (method !== "GET" && method !== "HEAD")) &&
      singleHeader(request.headers.origin) !== origin
    ) {
      return { status: 403, text: "Refused: not from the editor." };
    }
    const upstream = options.editors.authorize(
      taskId,
      editorCookie(singleHeader(request.headers.cookie), taskId),
    );
    if (!upstream) {
      return {
        status: 401,
        text: "This editor is closed or the link has expired. Open the editor again from the task in the AgentLink Assistant.",
      };
    }
    options.editors.touch(taskId);
    return {
      taskId,
      upstream: new URL(upstream),
      path: `${match[2]}${url.search}`,
    };
  };

  const upstreamHeaders = (request: IncomingMessage, upstream: URL) => {
    const headers: http.OutgoingHttpHeaders = {};
    for (const [name, value] of Object.entries(request.headers)) {
      if (value === undefined || HOP_BY_HOP.has(name)) continue;
      headers[name] = value;
    }
    const cookies = editorUpstreamCookies(singleHeader(request.headers.cookie));
    if (cookies) headers.cookie = cookies;
    headers.host = upstream.host;
    return headers;
  };

  const handle = (request: IncomingMessage, response: ServerResponse) => {
    response.setHeader("strict-transport-security", "max-age=31536000");
    response.setHeader("referrer-policy", "same-origin");
    const origin = originFor(request);
    const url = new URL(request.url ?? "/", origin ?? "https://editor.invalid");
    if (url.pathname === "/open") {
      if (!origin) return page(response, 421, "Unknown host.");
      const redeemed = options.editors.redeem(
        url.searchParams.get("token") ?? "",
      );
      if (!redeemed) {
        return page(
          response,
          410,
          "This link has expired. Open the editor again from the task in the AgentLink Assistant.",
        );
      }
      response.writeHead(303, {
        "set-cookie": `${EDITOR_COOKIE_PREFIX}${redeemed.taskId}=${redeemed.session}; Path=/t/${redeemed.taskId}/; Secure; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MAX_AGE_SECONDS}`,
        location: `/t/${redeemed.taskId}/`,
        "cache-control": "no-store",
        "content-length": 0,
      });
      response.end();
      return;
    }
    const target = route(request, false);
    if ("redirect" in target) {
      response.writeHead(308, {
        location: target.redirect,
        "content-length": 0,
      });
      response.end();
      return;
    }
    if ("status" in target) return page(response, target.status, target.text);
    const proxied = http.request(
      {
        host: target.upstream.hostname,
        port: target.upstream.port,
        method: request.method,
        path: target.path,
        headers: upstreamHeaders(request, target.upstream),
      },
      (upstream) => {
        const headers = { ...upstream.headers };
        for (const name of ["connection", "keep-alive", "transfer-encoding"]) {
          delete headers[name];
        }
        response.writeHead(upstream.statusCode ?? 502, headers);
        upstream.pipe(response);
      },
    );
    proxied.on("error", () => {
      if (!response.headersSent) {
        page(
          response,
          502,
          "The editor is not answering yet; reload in a moment.",
        );
      } else {
        response.destroy();
      }
    });
    request.pipe(proxied);
  };

  const handleUpgrade = (
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ) => {
    const refuse = (status: number) => {
      socket.end(
        `HTTP/1.1 ${status} ${http.STATUS_CODES[status] ?? ""}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
      );
    };
    const target = route(request, true);
    if (!("taskId" in target)) {
      refuse("status" in target ? target.status : 400);
      return;
    }
    const headers = upstreamHeaders(request, target.upstream);
    headers.connection = "Upgrade";
    headers.upgrade = singleHeader(request.headers.upgrade) ?? "websocket";
    const proxied = http.request({
      host: target.upstream.hostname,
      port: target.upstream.port,
      method: request.method,
      path: target.path,
      headers,
    });
    proxied.on("upgrade", (upstreamResponse, upstreamSocket, upstreamHead) => {
      const lines = [`HTTP/1.1 101 Switching Protocols`];
      for (
        let index = 0;
        index < upstreamResponse.rawHeaders.length;
        index += 2
      ) {
        lines.push(
          `${upstreamResponse.rawHeaders[index]}: ${upstreamResponse.rawHeaders[index + 1]}`,
        );
      }
      socket.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (upstreamHead.length > 0) socket.write(upstreamHead);
      if (head.length > 0) upstreamSocket.write(head);
      options.editors.connection(target.taskId, 1);
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        upgraded.delete(close);
        options.editors.connection(target.taskId, -1);
        socket.destroy();
        upstreamSocket.destroy();
      };
      upgraded.add(close);
      socket.on("data", () => options.editors.touch(target.taskId));
      // Either side hanging up ends both (the server's sockets would
      // otherwise stay half open).
      for (const side of [socket, upstreamSocket]) {
        side.on("end", close);
        side.on("close", close);
        side.on("error", close);
      }
      socket.pipe(upstreamSocket);
      upstreamSocket.pipe(socket);
    });
    proxied.on("response", (upstreamResponse) => {
      upstreamResponse.resume();
      refuse(upstreamResponse.statusCode ?? 502);
    });
    proxied.on("error", () => refuse(502));
    socket.on("error", () => proxied.destroy());
    proxied.end();
  };

  /** Open WebSockets, to end on close. */
  const upgraded = new Set<() => void>();
  const server = options.insecure
    ? http.createServer(handle)
    : https.createServer(
        { cert: options.tls.cert, key: options.tls.key, minVersion: "TLSv1.2" },
        handle,
      );
  server.on("upgrade", handleUpgrade);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.listen.port, options.listen.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  options.log(
    `Editor listener on ${options.listen.host}:${(server.address() as AddressInfo).port}`,
  );
  return {
    port: (server.address() as AddressInfo).port,
    setTls(tls) {
      if (server instanceof https.Server) {
        server.setSecureContext({
          cert: tls.cert,
          key: tls.key,
          minVersion: "TLSv1.2",
        });
      }
    },
    async close() {
      for (const close of upgraded) close();
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
