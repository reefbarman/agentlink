import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  createAssistantServer,
  type AssistantServer,
  type AssistantServerAuth,
  type CreateAssistantServerOptions,
} from "./assistantServer.js";
import { issueLocalPairingCode } from "./ServerAccessStore.js";
import {
  createTestCertificate,
  freePort,
  httpsRequest,
  httpsUpgrade,
  plainHttpRequest,
  sessionCookieFrom,
  type TestResponse,
} from "./testSupport.js";

let certificate: { cert: string; key: string };
beforeAll(() => {
  certificate = createTestCertificate();
});

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

interface Harness {
  readonly server: AssistantServer;
  readonly port: number;
  readonly origin: string;
  readonly dataRoot: string;
  readonly clock: { value: number };
  readonly appCalls: AssistantServerAuth[];
  readonly upgradeCalls: AssistantServerAuth[];
  request(input: {
    method?: string;
    path: string;
    headers?: Record<string, string>;
    body?: unknown;
    form?: Record<string, string>;
  }): Promise<TestResponse>;
  restart(): Promise<Harness>;
}

async function startHarness(
  existing?: { dataRoot: string; port: number; clock: { value: number } },
  overrides: Partial<CreateAssistantServerOptions> = {},
): Promise<Harness> {
  const dataRoot =
    existing?.dataRoot ??
    (await fs.mkdtemp(path.join(os.tmpdir(), "assistant-server-")));
  if (!existing) {
    cleanup.push(() => fs.rm(dataRoot, { recursive: true, force: true }));
  }
  const port = existing?.port ?? (await freePort());
  const clock = existing?.clock ?? { value: Date.now() };
  const origin = `https://localhost:${port}`;
  const appCalls: AssistantServerAuth[] = [];
  const upgradeCalls: AssistantServerAuth[] = [];
  const server = await createAssistantServer({
    dataRoot,
    tls: certificate,
    publicOrigins: [origin],
    listen: { host: "127.0.0.1", port },
    now: () => clock.value,
    handleRequest: (request, response, auth) => {
      if (new URL(request.url!, origin).pathname !== "/api/app/echo") {
        return false;
      }
      appCalls.push(auth);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ subjectId: auth.principal.subjectId }));
      return true;
    },
    handleUpgrade: (_request, socket, _head, auth) => {
      upgradeCalls.push(auth);
      socket.end(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
      );
    },
    renderAppPage: ({ nonce }) =>
      `<p>app</p><script nonce="${nonce}">boot()</script>`,
    ...overrides,
  });
  await server.start();
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await server.close();
  };
  cleanup.push(close);
  return {
    server,
    port,
    origin,
    dataRoot,
    clock,
    appCalls,
    upgradeCalls,
    request: (input) => httpsRequest({ port, ca: certificate.cert, ...input }),
    async restart() {
      await close();
      return await startHarness({ dataRoot, port, clock });
    },
  };
}

/** Sign a device in with a code minted by the server. */
async function pairDevice(harness: Harness, deviceLabel = "Laptop") {
  const { code } = harness.server.store.createPairing();
  const response = await harness.request({
    method: "POST",
    path: "/api/auth/pairings/redeem",
    headers: { origin: harness.origin },
    body: { code, deviceLabel },
  });
  expect(response.status).toBe(201);
  const body = response.body as { deviceId: string; ownerId: string };
  return {
    cookie: sessionCookieFrom(response),
    deviceId: body.deviceId,
    ownerId: body.ownerId,
    response,
  };
}

function authHeaders(harness: Harness, session: { cookie: string }) {
  return { origin: harness.origin, cookie: session.cookie };
}

describe("assistant server access layer", () => {
  it("refuses to start without TLS or with a non-https origin", async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "assistant-cfg-"));
    cleanup.push(() => fs.rm(dataRoot, { recursive: true, force: true }));
    const base = { dataRoot, listen: { host: "127.0.0.1", port: 0 } };
    await expect(
      createAssistantServer({
        ...base,
        tls: { cert: "", key: "" },
        publicOrigins: ["https://localhost"],
      }),
    ).rejects.toThrow("TLS");
    await expect(
      createAssistantServer({
        ...base,
        tls: certificate,
        publicOrigins: ["http://localhost:8080"],
      }),
    ).rejects.toThrow("https://");
    await expect(
      createAssistantServer({
        ...base,
        tls: certificate,
        publicOrigins: ["https://localhost/app"],
      }),
    ).rejects.toThrow("bare");
    await expect(
      createAssistantServer({
        ...base,
        tls: { cert: "not a certificate", key: certificate.key },
        publicOrigins: ["https://localhost"],
      }),
    ).rejects.toThrow();
    // Failed construction must not leave the data root locked.
    const server = await createAssistantServer({
      ...base,
      tls: certificate,
      publicOrigins: ["https://localhost"],
    });
    await server.close();
  });

  it("serves only TLS and sets security headers", async () => {
    const harness = await startHarness();
    await expect(plainHttpRequest(harness.port)).rejects.toThrow();
    const pair = await harness.request({ path: "/pair" });
    expect(pair.status).toBe(200);
    expect(String(pair.body)).toContain("Pair with AgentLink Assistant");
    expect(String(pair.body)).toContain("--accent: #B59AFF");
    expect(pair.headers).toMatchObject({
      "strict-transport-security": "max-age=31536000",
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
      "referrer-policy": "same-origin",
    });
    const csp = pair.headers["content-security-policy"] as string;
    expect(csp).toContain("frame-ancestors 'none'");
    // The sign-in page runs no script at all.
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toContain("script-src");
  });

  it("sends signed-out browsers to /pair and API clients a 401", async () => {
    const harness = await startHarness();
    for (const page of ["/", "/devices"]) {
      await expect(harness.request({ path: page })).resolves.toMatchObject({
        status: 303,
        headers: { location: "/pair" },
      });
    }
    await expect(
      harness.request({ path: "/api/auth/session" }),
    ).resolves.toMatchObject({
      status: 401,
      body: { error: "authentication_required" },
    });
  });

  it("pairs a browser through the /pair form with the code from `pair`", async () => {
    const harness = await startHarness();
    const { code } = await issueLocalPairingCode({
      dataRoot: harness.dataRoot,
      now: () => harness.clock.value,
    });
    // The sign-in link prefills the code.
    const prefilled = await harness.request({ path: `/pair?code=${code}` });
    expect(prefilled.body).toContain(`value="${code}"`);
    // The field takes the code as `pair` prints it ("123 456").
    expect(prefilled.body).toContain('maxlength="7"');
    const hostile = await harness.request({
      path: `/pair?code=${encodeURIComponent('"><script>x</script>')}`,
    });
    expect(hostile.body).not.toContain("<script>x");

    // Browsers send Origin with form posts; without it the post is refused.
    await expect(
      harness.request({ method: "POST", path: "/pair", form: { code } }),
    ).resolves.toMatchObject({
      status: 403,
      body: { error: "origin_required" },
    });
    const wrong = await harness.request({
      method: "POST",
      path: "/pair",
      headers: { origin: harness.origin },
      form: { code: code === "000000" ? "000001" : "000000" },
    });
    expect(wrong.status).toBe(401);
    expect(wrong.body).toContain("That code did not work");
    expect(wrong.headers["set-cookie"]).toBeUndefined();

    const signedIn = await harness.request({
      method: "POST",
      path: "/pair",
      headers: {
        origin: harness.origin,
        "user-agent":
          "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
      },
      form: { code: `${code.slice(0, 3)} ${code.slice(3)}` },
    });
    expect(signedIn).toMatchObject({
      status: 303,
      headers: { location: "/" },
    });
    const cookieHeader = signedIn.headers["set-cookie"]![0]!;
    expect(cookieHeader).toMatch(/^__Host-agentlink_session=[\w-]{43};/u);
    expect(cookieHeader).toContain("Secure");
    expect(cookieHeader).toContain("HttpOnly");
    expect(cookieHeader).toContain("SameSite=Strict");
    expect(cookieHeader).toContain("Path=/");
    const cookie = sessionCookieFrom(signedIn);

    await expect(
      harness.request({ path: "/api/auth/session", headers: { cookie } }),
    ).resolves.toMatchObject({
      status: 200,
      body: { deviceLabel: "Safari on iPhone" },
    });
    // A signed-in browser opening /pair goes straight to the app.
    await expect(
      harness.request({ path: "/pair", headers: { cookie } }),
    ).resolves.toMatchObject({ status: 303, headers: { location: "/" } });
    // The code was single use.
    await expect(
      harness.request({
        method: "POST",
        path: "/pair",
        headers: { origin: harness.origin },
        form: { code },
      }),
    ).resolves.toMatchObject({ status: 401 });
    // Neither the code nor the session token reaches disk.
    const stored = await fs.readFile(
      path.join(harness.dataRoot, "access-state.json"),
      "utf8",
    );
    expect(stored).not.toContain(cookie.split("=")[1]);
    expect(
      (await fs.stat(path.join(harness.dataRoot, "access-state.json"))).mode &
        0o777,
    ).toBe(0o600);
  });

  it("renders the app shell with a fresh script nonce for signed-in browsers", async () => {
    const harness = await startHarness();
    const device = await pairDevice(harness);
    const first = await harness.request({
      path: "/",
      headers: { cookie: device.cookie },
    });
    const second = await harness.request({
      path: "/",
      headers: { cookie: device.cookie },
    });
    expect(first.status).toBe(200);
    expect(first.headers["content-type"]).toBe("text/html; charset=utf-8");
    const nonce = /nonce="([^"]+)"/u.exec(first.body as string)![1]!;
    const csp = first.headers["content-security-policy"] as string;
    expect(csp).toContain(`script-src 'self' 'nonce-${nonce}'`);
    expect(csp).not.toContain("'unsafe-inline' 'self' 'nonce");
    expect(second.body).not.toContain(nonce);
  });

  it("rejects forged proxy and identity headers and foreign hosts", async () => {
    const harness = await startHarness();
    const owner = await pairDevice(harness);
    const forged: Array<Record<string, string>> = [
      { "x-forwarded-for": "10.0.0.1" },
      { "x-forwarded-proto": "https" },
      { forwarded: "for=10.0.0.1" },
      { "x-real-ip": "10.0.0.1" },
      { "x-remote-user": "owner" },
      { "remote-user": "owner" },
      { "x-auth-request-user": "owner" },
    ];
    for (const headers of forged) {
      await expect(
        harness.request({
          path: "/api/auth/session",
          headers: { cookie: owner.cookie, ...headers },
        }),
      ).resolves.toMatchObject({
        status: 400,
        body: { error: "forwarded_identity_rejected" },
      });
    }
    await expect(
      harness.request({
        path: "/api/auth/session",
        headers: { cookie: owner.cookie, host: "evil.example" },
      }),
    ).resolves.toMatchObject({
      status: 421,
      body: { error: "host_not_allowed" },
    });
    expect(harness.appCalls).toHaveLength(0);
  });

  it("requires a same-origin request for authenticated writes", async () => {
    const harness = await startHarness();
    const owner = await pairDevice(harness);
    const attempts: Array<[Record<string, string>, number, string]> = [
      [{ cookie: owner.cookie }, 403, "origin_required"],
      [
        { origin: "https://evil.example", cookie: owner.cookie },
        403,
        "origin_not_allowed",
      ],
      [
        {
          origin: harness.origin,
          "sec-fetch-site": "cross-site",
          cookie: owner.cookie,
        },
        403,
        "cross_site_request",
      ],
    ];
    for (const [headers, status, error] of attempts) {
      await expect(
        harness.request({ method: "POST", path: "/api/auth/logout", headers }),
      ).resolves.toMatchObject({ status, body: { error } });
    }
    // A cross-origin read is refused too.
    await expect(
      harness.request({
        path: "/api/auth/session",
        headers: { cookie: owner.cookie, origin: "https://evil.example" },
      }),
    ).resolves.toMatchObject({ status: 403 });

    const logout = await harness.request({
      method: "POST",
      path: "/api/auth/logout",
      headers: authHeaders(harness, owner),
    });
    expect(logout.status).toBe(204);
    expect(logout.headers["set-cookie"]?.[0]).toContain("Max-Age=0");
    await expect(
      harness.request({
        path: "/api/auth/session",
        headers: { cookie: owner.cookie },
      }),
    ).resolves.toMatchObject({ status: 401 });
  });

  it("keeps detached auth valid after its request closes, until revocation", async () => {
    const harness = await startHarness();
    const owner = await pairDevice(harness);
    const phone = await pairDevice(harness, "Phone");
    await harness.request({
      path: "/api/app/echo",
      headers: { cookie: phone.cookie },
    });
    const request = harness.appCalls.at(-1)!;
    await vi.waitFor(() => expect(request.signal.aborted).toBe(true));
    await expect(request.revalidate()).resolves.toEqual({ valid: false });

    const detached = request.detach();
    expect(request.detach()).toBe(detached);
    expect(detached.detach()).toBe(detached);
    expect(detached.signal.aborted).toBe(false);
    await expect(detached.revalidate()).resolves.toEqual({ valid: true });

    const revoked = await harness.request({
      method: "DELETE",
      path: `/api/auth/devices/${phone.deviceId}`,
      headers: authHeaders(harness, owner),
    });
    expect(revoked.status).toBe(204);
    expect(detached.signal.aborted).toBe(true);
    await expect(detached.revalidate()).resolves.toEqual({ valid: false });
    // A later sign-in gets a fresh one rather than the revoked auth.
    expect(request.detach()).not.toBe(detached);
  });

  it("lets a signed-in device pair another and revoke it durably", async () => {
    let harness = await startHarness();
    const owner = await pairDevice(harness);
    const pairing = await harness.request({
      method: "POST",
      path: "/api/auth/pairings",
      headers: authHeaders(harness, owner),
    });
    expect(pairing).toMatchObject({
      status: 201,
      body: { code: expect.stringMatching(/^[0-9]{6}$/u) },
    });
    const { code, link } = pairing.body as { code: string; link: string };
    expect(link).toBe(`${harness.origin}/pair?code=${code}`);
    const phone = await harness.request({
      method: "POST",
      path: "/api/auth/pairings/redeem",
      headers: { origin: harness.origin },
      body: { code, deviceLabel: "Phone" },
    });
    expect(phone.status).toBe(201);
    const phoneSession = {
      cookie: sessionCookieFrom(phone),
      deviceId: (phone.body as { deviceId: string }).deviceId,
    };
    await expect(
      harness.request({
        path: "/api/app/echo",
        headers: { cookie: phoneSession.cookie },
      }),
    ).resolves.toMatchObject({
      status: 200,
      body: { subjectId: owner.ownerId },
    });
    expect(harness.appCalls[0]!.principal).toEqual({
      tenantId: "agentlink-server",
      subjectId: owner.ownerId,
    });

    const revoked = await harness.request({
      method: "DELETE",
      path: `/api/auth/devices/${phoneSession.deviceId}`,
      headers: authHeaders(harness, owner),
    });
    expect(revoked.status).toBe(204);
    await expect(
      harness.request({
        path: "/api/auth/session",
        headers: { cookie: phoneSession.cookie },
      }),
    ).resolves.toMatchObject({ status: 401 });

    harness = await harness.restart();
    await expect(
      harness.request({
        path: "/api/auth/session",
        headers: { cookie: owner.cookie },
      }),
    ).resolves.toMatchObject({ status: 200 });
    await expect(
      harness.request({
        path: "/api/auth/session",
        headers: { cookie: phoneSession.cookie },
      }),
    ).resolves.toMatchObject({ status: 401 });
    const devices = await harness.request({
      path: "/api/auth/devices",
      headers: { cookie: owner.cookie },
    });
    expect(devices.body).toMatchObject({
      devices: expect.arrayContaining([
        expect.objectContaining({ label: "Laptop", current: true }),
        expect.objectContaining({
          label: "Phone",
          revokedAt: expect.any(Number),
        }),
      ]),
    });
  });

  it("manages devices from the /devices pages", async () => {
    const harness = await startHarness();
    const owner = await pairDevice(harness, "Laptop");
    const phone = await pairDevice(harness, "Phone");

    const list = await harness.request({
      path: "/devices",
      headers: { cookie: owner.cookie },
    });
    expect(list.status).toBe(200);
    expect(list.body).toContain("Laptop");
    expect(list.body).toContain("This device");
    expect(list.body).toContain(`/devices/${phone.deviceId}/revoke`);

    const minted = await harness.request({
      method: "POST",
      path: "/devices/pair",
      headers: authHeaders(harness, owner),
    });
    expect(minted.status).toBe(200);
    const page = minted.body as string;
    const code = /\?code=([0-9]{6})/u.exec(page)![1]!;
    expect(page).toContain("<svg");
    expect(page).toContain(`${harness.origin}/pair?code=${code}`);
    await expect(
      harness.server.store.redeemPairing({ code }),
    ).resolves.toMatchObject({ session: { deviceLabel: "Browser" } });

    await expect(
      harness.request({
        method: "POST",
        path: `/devices/${phone.deviceId}/revoke`,
        headers: authHeaders(harness, owner),
      }),
    ).resolves.toMatchObject({
      status: 303,
      headers: { location: "/devices" },
    });
    await expect(
      harness.request({
        path: "/api/auth/session",
        headers: { cookie: phone.cookie },
      }),
    ).resolves.toMatchObject({ status: 401 });

    // Revoking this device signs it out.
    const self = await harness.request({
      method: "POST",
      path: `/devices/${owner.deviceId}/revoke`,
      headers: authHeaders(harness, owner),
    });
    expect(self).toMatchObject({
      status: 303,
      headers: { location: "/pair" },
    });
    expect(self.headers["set-cookie"]?.[0]).toContain("Max-Age=0");
  });

  it("shows and turns off device notifications on /devices", async () => {
    const notifying = new Set<string>();
    const harness = await startHarness(undefined, {
      deviceNotifications: {
        isOn: (deviceId) => notifying.has(deviceId),
        turnOff: async (deviceId) => {
          notifying.delete(deviceId);
        },
      },
    });
    const owner = await pairDevice(harness, "Laptop");
    const phone = await pairDevice(harness, "Phone");
    notifying.add(phone.deviceId);

    const list = await harness.request({
      path: "/devices",
      headers: { cookie: owner.cookie },
    });
    expect(list.body).toContain("Notifications on");
    expect(list.body).toContain("Notifications off");
    expect(list.body).toContain(`/devices/${phone.deviceId}/notifications/off`);
    expect(list.body).not.toContain(
      `/devices/${owner.deviceId}/notifications/off`,
    );

    await expect(
      harness.request({
        method: "POST",
        path: `/devices/${phone.deviceId}/notifications/off`,
        headers: authHeaders(harness, owner),
      }),
    ).resolves.toMatchObject({
      status: 303,
      headers: { location: "/devices" },
    });
    expect(notifying.has(phone.deviceId)).toBe(false);
  });

  it("expires pairing codes", async () => {
    const harness = await startHarness();
    const { code } = harness.server.store.createPairing();
    harness.clock.value += 5 * 60 * 1000 + 1;
    await expect(
      harness.request({
        method: "POST",
        path: "/api/auth/pairings/redeem",
        headers: { origin: harness.origin },
        body: { code },
      }),
    ).resolves.toMatchObject({
      status: 401,
      body: { error: "invalid_pairing_code" },
    });
  });

  it("rate limits code guessing even when the next guess is correct", async () => {
    const harness = await startHarness();
    const { code } = harness.server.store.createPairing();
    const wrong = code === "000000" ? "000001" : "000000";
    const statuses = await Promise.all(
      Array.from({ length: 7 }, () =>
        harness
          .request({
            method: "POST",
            path: "/api/auth/pairings/redeem",
            headers: { origin: harness.origin },
            body: { code: wrong },
          })
          .then((response) => response.status),
      ),
    );
    expect(statuses.filter((status) => status === 401)).toHaveLength(5);
    expect(statuses.filter((status) => status === 429)).toHaveLength(2);
    await expect(
      harness.request({
        method: "POST",
        path: "/pair",
        headers: { origin: harness.origin },
        form: { code },
      }),
    ).resolves.toMatchObject({ status: 429 });
  });

  it("authenticates upgrades by cookie and exact origin", async () => {
    const harness = await startHarness();
    const owner = await pairDevice(harness);
    const upgrade = (headers: Record<string, string>) =>
      httpsUpgrade({ port: harness.port, ca: certificate.cert, headers });
    await expect(upgrade({ origin: harness.origin })).resolves.toBe(401);
    await expect(upgrade({ cookie: owner.cookie })).resolves.toBe(403);
    await expect(
      upgrade({ cookie: owner.cookie, origin: "https://evil.example" }),
    ).resolves.toBe(403);
    await expect(
      upgrade({
        cookie: owner.cookie,
        origin: harness.origin,
        "x-forwarded-for": "10.0.0.1",
      }),
    ).resolves.toBe(400);
    expect(harness.upgradeCalls).toHaveLength(0);
    await expect(
      upgrade({ cookie: owner.cookie, origin: harness.origin }),
    ).resolves.toBe(101);
    expect(harness.upgradeCalls[0]!.session.deviceLabel).toBe("Laptop");
  });

  it("never passes anonymous requests to application hooks", async () => {
    const handleRequest = vi.fn(() => true);
    const harness = await startHarness(undefined, { handleRequest });
    await expect(
      harness.request({ path: "/api/app/echo" }),
    ).resolves.toMatchObject({
      status: 401,
      body: { error: "authentication_required" },
    });
    await expect(
      harness.request({
        path: "/api/app/echo",
        headers: { cookie: `__Host-agentlink_session=${"a".repeat(43)}` },
      }),
    ).resolves.toMatchObject({ status: 401 });
    expect(handleRequest).not.toHaveBeenCalled();
  });

  it("serves web app files without a session, behind the envelope checks", async () => {
    const handleRequest = vi.fn(() => false);
    const harness = await startHarness(undefined, {
      handleRequest,
      webAssets: new Map([
        // An asset can never replace the signed-in app shell.
        ["/", { contentType: "text/html; charset=utf-8", body: "shadow" }],
        [
          "/app.js",
          { contentType: "text/javascript; charset=utf-8", body: "1;" },
        ],
        [
          "/chunk-abc.js",
          {
            contentType: "text/javascript; charset=utf-8",
            body: "2;",
            immutable: true,
          },
        ],
        [
          "/browser-gateway-notifications.js",
          { contentType: "text/javascript; charset=utf-8", body: "3;" },
        ],
        // A web asset can never shadow the API.
        ["/api/projects", { contentType: "text/plain", body: "shadowed" }],
      ]),
    });
    await expect(harness.request({ path: "/" })).resolves.toMatchObject({
      status: 303,
    });
    await expect(
      harness.request({ path: "/app.js?v=1" }),
    ).resolves.toMatchObject({
      status: 200,
      body: "1;",
      headers: { "cache-control": "no-store" },
    });
    await expect(
      harness.request({ path: "/chunk-abc.js" }),
    ).resolves.toMatchObject({
      status: 200,
      headers: { "cache-control": "public, max-age=31536000, immutable" },
    });
    await expect(
      harness.request({ method: "HEAD", path: "/app.js" }),
    ).resolves.toMatchObject({ status: 200, body: undefined });
    // The notification worker may load the app's icon, and nothing else;
    // other files keep the strict default.
    const worker = await harness.request({
      path: "/browser-gateway-notifications.js",
    });
    expect(worker.headers["content-security-policy"]).toBe(
      "default-src 'none'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'",
    );
    const script = await harness.request({ path: "/app.js" });
    expect(script.headers["content-security-policy"]).not.toContain("img-src");
    // Unknown paths and the API still need a session.
    await expect(harness.request({ path: "/other.js" })).resolves.toMatchObject(
      { status: 401, body: { error: "authentication_required" } },
    );
    await expect(
      harness.request({ path: "/api/projects" }),
    ).resolves.toMatchObject({ status: 401 });
    // The Host and forged-header checks still apply.
    await expect(
      harness.request({ path: "/app.js", headers: { host: "evil.example" } }),
    ).resolves.toMatchObject({ status: 421 });
    await expect(
      harness.request({
        path: "/app.js",
        headers: { "x-forwarded-for": "1.2.3.4" },
      }),
    ).resolves.toMatchObject({ status: 400 });
    expect(handleRequest).not.toHaveBeenCalled();
  });
});
