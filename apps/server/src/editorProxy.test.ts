import http, { type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import {
  EDITOR_COOKIE_PREFIX,
  editorUpstreamCookies,
  startEditorProxy,
  type EditorProxy,
} from "./editorProxy.js";
import { SESSION_COOKIE_NAME } from "./requestGuard.js";

const TASK = "0123456789ab";
const OTHER = "ba9876543210";

/** A stand-in for code-server: echoes what it got, over HTTP and WS. */
async function startUpstream() {
  const seen: Array<{ method?: string; url?: string; cookie?: string }> = [];
  const forwarded: Array<string | undefined> = [];
  const server = http.createServer((request, response) => {
    seen.push({
      method: request.method,
      url: request.url,
      cookie: request.headers.cookie,
    });
    forwarded.push(
      `${request.headers["x-forwarded-host"]} ${request.headers["x-forwarded-for"]}`,
    );
    response.writeHead(200, { "content-type": "text/plain" });
    response.end(`upstream ${request.url}`);
  });
  server.on(
    "upgrade",
    (request: IncomingMessage, socket: Duplex, _head: Buffer) => {
      seen.push({
        method: "UPGRADE",
        url: request.url,
        cookie: request.headers.cookie,
      });
      forwarded.push(
        `${request.headers["x-forwarded-host"]} ${request.headers["x-forwarded-for"]}`,
      );
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
      );
      socket.on("data", (data: Buffer) => socket.write(data));
      socket.on("end", () => socket.destroy());
    },
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    seen,
    forwarded,
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function fakeEditors(upstream: string) {
  const sessions = new Map<string, string>([["good-session", TASK]]);
  const links = new Map<string, string>([["link-1", TASK]]);
  const connections: number[] = [];
  return {
    connections,
    editors: {
      redeem(token: string) {
        const taskId = links.get(token);
        links.delete(token);
        return taskId ? { taskId, session: "good-session" } : undefined;
      },
      authorize(taskId: string, session: string | undefined) {
        return session && sessions.get(session) === taskId
          ? upstream
          : undefined;
      },
      touch() {},
      connection(_taskId: string, change: 1 | -1) {
        connections.push(change);
      },
    },
  };
}

function request(
  port: number,
  options: {
    path: string;
    method?: string;
    headers?: Record<string, string>;
  },
): Promise<{
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}> {
  return new Promise((resolve, reject) => {
    const sent = http.request(
      {
        host: "127.0.0.1",
        port,
        path: options.path,
        method: options.method ?? "GET",
        headers: options.headers,
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => (body += chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body,
          }),
        );
      },
    );
    sent.on("error", reject);
    sent.end();
  });
}

function upgrade(
  port: number,
  headers: Record<string, string>,
): Promise<{ status: number; socket?: Duplex }> {
  return new Promise((resolve, reject) => {
    const sent = http.request({
      host: "127.0.0.1",
      port,
      path: `/t/${TASK}/socket`,
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        ...headers,
      },
    });
    sent.on("upgrade", (response, socket) =>
      resolve({ status: response.statusCode ?? 0, socket }),
    );
    sent.on("response", (response) => {
      response.resume();
      resolve({ status: response.statusCode ?? 0 });
    });
    sent.on("error", reject);
    sent.end();
  });
}

describe("editor proxy", () => {
  let proxy: EditorProxy | undefined;
  let upstream: Awaited<ReturnType<typeof startUpstream>> | undefined;
  afterEach(async () => {
    await proxy?.close();
    await upstream?.close();
    proxy = undefined;
    upstream = undefined;
  });

  const start = async () => {
    upstream = await startUpstream();
    const fake = fakeEditors(upstream.url);
    proxy = await startEditorProxy({
      editors: fake.editors,
      tls: { cert: "", key: "" },
      listen: { host: "127.0.0.1", port: 0 },
      hosts: ["127.0.0.1"],
      log: () => undefined,
      insecure: true,
    });
    return {
      ...fake,
      port: proxy.port,
      origin: `http://127.0.0.1:${proxy.port}`,
    };
  };

  it("never forwards the app's session cookie or editor cookies", () => {
    expect(
      editorUpstreamCookies(
        `${SESSION_COOKIE_NAME}=app; vscode-tkn=keep; ${EDITOR_COOKIE_PREFIX}${TASK}=s`,
      ),
    ).toBe("vscode-tkn=keep");
    expect(editorUpstreamCookies(`${SESSION_COOKIE_NAME}=app`)).toBeUndefined();
  });

  it("turns a one-time link into a cookie for that task's path only", async () => {
    const { port } = await start();
    const opened = await request(port, { path: "/open?token=link-1" });
    expect(opened.status).toBe(303);
    expect(opened.headers.location).toBe(`/t/${TASK}/`);
    const cookie = String(opened.headers["set-cookie"]);
    expect(cookie).toContain(`${EDITOR_COOKIE_PREFIX}${TASK}=good-session`);
    expect(cookie).toContain(`Path=/t/${TASK}/`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    // Single use.
    expect((await request(port, { path: "/open?token=link-1" })).status).toBe(
      410,
    );
  });

  it("proxies to the task's editor with the editor cookie, never the app's", async () => {
    const { port } = await start();
    // The app's session cookie alone gets nothing.
    const refused = await request(port, {
      path: `/t/${TASK}/`,
      headers: { cookie: `${SESSION_COOKIE_NAME}=app-session` },
    });
    expect(refused.status).toBe(401);
    expect(upstream!.seen).toHaveLength(0);
    const proxied = await request(port, {
      path: `/t/${TASK}/static/app.js?x=1`,
      headers: {
        cookie: `${SESSION_COOKIE_NAME}=app-session; ${EDITOR_COOKIE_PREFIX}${TASK}=good-session; code-server-session=k`,
        "x-forwarded-host": "evil.example",
        "x-forwarded-for": "10.0.0.1",
      },
    });
    expect(proxied.status).toBe(200);
    expect(proxied.body).toBe("upstream /static/app.js?x=1");
    // code-server sees the public host it checks Origins against, never
    // a client's forwarding headers.
    expect(upstream!.forwarded).toEqual([`127.0.0.1:${port} undefined`]);
    expect(upstream!.seen).toEqual([
      {
        method: "GET",
        url: "/static/app.js?x=1",
        cookie: "code-server-session=k",
      },
    ]);
  });

  it("refuses another task's cookie, unknown hosts, and unsafe requests from elsewhere", async () => {
    const { port, origin } = await start();
    const cookie = `${EDITOR_COOKIE_PREFIX}${TASK}=good-session`;
    // A session for one task does not open another.
    expect(
      (
        await request(port, {
          path: `/t/${OTHER}/`,
          headers: { cookie: `${EDITOR_COOKIE_PREFIX}${OTHER}=good-session` },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await request(port, {
          path: `/t/${TASK}/`,
          headers: { cookie, host: "evil.example" },
        })
      ).status,
    ).toBe(421);
    expect(
      (
        await request(port, {
          path: `/t/${TASK}/save`,
          method: "POST",
          headers: { cookie, origin: "https://agentlink-assistant.local:8443" },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(port, {
          path: `/t/${TASK}/save`,
          method: "POST",
          headers: { cookie, origin },
        })
      ).status,
    ).toBe(200);
  });

  it("proxies WebSockets from the editor's own origin and counts them", async () => {
    const { port, origin, connections } = await start();
    const cookie = `${EDITOR_COOKIE_PREFIX}${TASK}=good-session`;
    expect((await upgrade(port, { cookie })).status).toBe(403);
    expect(
      (await upgrade(port, { origin, cookie: `${SESSION_COOKIE_NAME}=app` }))
        .status,
    ).toBe(401);
    const opened = await upgrade(port, { origin, cookie });
    expect(opened.status).toBe(101);
    const echoed = await new Promise<string>((resolve) => {
      opened.socket!.once("data", (data: Buffer) => resolve(data.toString()));
      opened.socket!.write("ping");
    });
    expect(echoed).toBe("ping");
    expect(upstream!.seen.at(-1)).toEqual({
      method: "UPGRADE",
      url: "/socket",
      cookie: undefined,
    });
    expect(connections).toEqual([1]);
    opened.socket!.destroy();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(connections).toEqual([1, -1]);
  });
});
