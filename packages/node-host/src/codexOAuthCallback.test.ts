import * as http from "node:http";
import * as net from "node:net";
import * as os from "node:os";

import { afterEach, describe, expect, it, vi } from "vitest";

import { CodexOAuthManager } from "./codexOAuthManager.js";

const managers: CodexOAuthManager[] = [];

afterEach(() => {
  for (const manager of managers.splice(0)) manager.cancelAuthorizationFlow();
  vi.unstubAllGlobals();
});

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

async function hasIpv6Loopback(): Promise<boolean> {
  return await new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(0, "::1", () => server.close(() => resolve(true)));
  });
}

function nonLoopbackIpv4(): string | undefined {
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal)
        return address.address;
    }
  }
  return undefined;
}

function get(host: string, port: number, pathname: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = http.get(
      { host, port, path: pathname, agent: false },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    request.on("error", reject);
  });
}

function canConnect(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    socket.setTimeout(1_000, () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

function stubTokenEndpoint() {
  const fetchMock = vi.fn(
    async (_input: unknown, _init?: RequestInit) =>
      new Response(
        JSON.stringify({
          access_token: "at",
          refresh_token: "rt",
          expires_in: 3600,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function startFlow() {
  const port = await freePort();
  const manager = new CodexOAuthManager(() => undefined, {
    callbackPort: port,
  });
  managers.push(manager);
  const authorizationUrl = new URL(manager.startAuthorizationFlow());
  const state = authorizationUrl.searchParams.get("state");
  if (!state) throw new Error("authorization URL has no state");
  return { manager, port, state, authorizationUrl };
}

describe("CodexOAuthManager callback listener", () => {
  it("is ready on loopback only once listenForCallback resolves", async () => {
    const { manager, port, authorizationUrl } = await startFlow();
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
      `http://localhost:${port}/auth/callback`,
    );

    const { callback } = await manager.listenForCallback();
    expect(await get("127.0.0.1", port, "/")).toBe(404);
    if (await hasIpv6Loopback()) {
      expect(await get("::1", port, "/")).toBe(404);
    }
    const lan = nonLoopbackIpv4();
    if (lan) {
      expect(await canConnect(lan, port)).toBe(false);
    }

    manager.cancelAuthorizationFlow();
    await expect(callback).rejects.toMatchObject({ code: "cancelled" });
  });

  it("reports an occupied port before the browser would be opened", async () => {
    const { manager, port } = await startFlow();
    const blocker = net.createServer();
    await new Promise<void>((resolve) =>
      blocker.listen(port, "127.0.0.1", resolve),
    );
    try {
      await expect(manager.listenForCallback()).rejects.toMatchObject({
        code: "port_in_use",
      });
    } finally {
      await new Promise((resolve) => blocker.close(resolve));
    }
  });

  it("rejects callbacks without this flow's state without consuming the login", async () => {
    const fetchMock = stubTokenEndpoint();
    const { manager, port, state } = await startFlow();
    const { callback } = await manager.listenForCallback();

    expect(
      await get("127.0.0.1", port, "/auth/callback?code=evil&state=wrong"),
    ).toBe(400);
    expect(
      await get("127.0.0.1", port, "/auth/callback?error=access_denied"),
    ).toBe(400);
    expect(await get("127.0.0.1", port, "/auth/callback?code=no-state")).toBe(
      400,
    );
    expect(fetchMock).not.toHaveBeenCalled();

    expect(
      await get(
        "127.0.0.1",
        port,
        `/auth/callback?code=good&state=${encodeURIComponent(state)}`,
      ),
    ).toBe(200);
    await expect(callback).resolves.toMatchObject({
      accessToken: "at",
      refreshToken: "rt",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = new URLSearchParams(
      String(fetchMock.mock.calls[0]?.[1]?.body),
    );
    expect(body.get("code")).toBe("good");
    expect(body.get("redirect_uri")).toBe(
      `http://localhost:${port}/auth/callback`,
    );
  });

  it("ends the flow on an OAuth error that carries this flow's state", async () => {
    const { manager, port, state } = await startFlow();
    const { callback } = await manager.listenForCallback();

    expect(
      await get(
        "127.0.0.1",
        port,
        `/auth/callback?error=access_denied&state=${encodeURIComponent(state)}`,
      ),
    ).toBe(400);
    await expect(callback).rejects.toMatchObject({ code: "oauth_error" });
  });

  it("settles a pending waitForCallback immediately when cancelled", async () => {
    const { manager, port } = await startFlow();
    const waiting = manager.waitForCallback();
    void waiting.catch(() => undefined);
    await vi.waitFor(async () => {
      expect(await get("127.0.0.1", port, "/")).toBe(404);
    });

    manager.cancelAuthorizationFlow();
    await expect(waiting).rejects.toMatchObject({ code: "cancelled" });
  });

  it("replaces a repeated listener for the same flow and can still cancel it", async () => {
    const { manager, port } = await startFlow();
    const { callback: first } = await manager.listenForCallback();
    const second = manager.listenForCallback();
    await expect(first).rejects.toMatchObject({ code: "cancelled" });
    const { callback } = await second;
    expect(await get("127.0.0.1", port, "/")).toBe(404);

    manager.cancelAuthorizationFlow();
    await expect(callback).rejects.toMatchObject({ code: "cancelled" });
  });

  it("can sign in again on the same port straight after cancelling", async () => {
    const { manager, port } = await startFlow();
    const { callback: first } = await manager.listenForCallback();
    manager.cancelAuthorizationFlow();
    await expect(first).rejects.toMatchObject({ code: "cancelled" });

    manager.startAuthorizationFlow();
    const { callback } = await manager.listenForCallback();
    expect(await get("127.0.0.1", port, "/")).toBe(404);
    manager.cancelAuthorizationFlow();
    await expect(callback).rejects.toMatchObject({ code: "cancelled" });
  });

  it("binds synchronously in waitForCallback so callers can open the browser straight away", async () => {
    const { manager, port } = await startFlow();
    const waiting = manager.waitForCallback();
    void waiting.catch(() => undefined);

    // No await between the call and this bind attempt.
    const blocker = net.createServer();
    const blocked = new Promise<string | undefined>((resolve) => {
      blocker.once("error", (err: NodeJS.ErrnoException) => resolve(err.code));
      blocker.once("listening", () => {
        blocker.close();
        resolve(undefined);
      });
    });
    blocker.listen(port, "127.0.0.1");
    expect(await blocked).toBe("EADDRINUSE");

    manager.cancelAuthorizationFlow();
    await expect(waiting).rejects.toMatchObject({ code: "cancelled" });
  });

  it("serialises overlapping listens for the same flow", async () => {
    const { manager, port } = await startFlow();
    const first = manager.listenForCallback();
    const second = manager.listenForCallback();

    await expect((await first).callback).rejects.toMatchObject({
      code: "cancelled",
    });
    const { callback } = await second;
    expect(await get("127.0.0.1", port, "/")).toBe(404);

    manager.cancelAuthorizationFlow();
    await expect(callback).rejects.toMatchObject({ code: "cancelled" });
  });

  it("keeps waiting for the original listener when a waiting listen is replaced", async () => {
    const { manager, port } = await startFlow();
    const { callback: first } = await manager.listenForCallback();
    // The second listen waits for the first to release the port; the third
    // replaces it before it binds and must still wait for that release.
    const second = manager.listenForCallback();
    const third = manager.listenForCallback();

    await expect(first).rejects.toMatchObject({ code: "cancelled" });
    await expect((await second).callback).rejects.toMatchObject({
      code: "cancelled",
    });
    const { callback } = await third;
    expect(await get("127.0.0.1", port, "/")).toBe(404);

    manager.cancelAuthorizationFlow();
    await expect(callback).rejects.toMatchObject({ code: "cancelled" });
  });

  it("cancels a listen that is still binding and lets a new flow use the port", async () => {
    const { manager, port } = await startFlow();
    const first = manager.listenForCallback();
    manager.cancelAuthorizationFlow();
    manager.startAuthorizationFlow();
    const { callback } = await manager.listenForCallback();

    await expect((await first).callback).rejects.toMatchObject({
      code: "cancelled",
    });
    expect(await get("127.0.0.1", port, "/")).toBe(404);
    manager.cancelAuthorizationFlow();
    await expect(callback).rejects.toMatchObject({ code: "cancelled" });
  });

  it("cancels the previous wait when a new flow starts", async () => {
    const { manager } = await startFlow();
    const { callback: first } = await manager.listenForCallback();

    manager.startAuthorizationFlow();
    await expect(first).rejects.toMatchObject({ code: "cancelled" });
  });
});
