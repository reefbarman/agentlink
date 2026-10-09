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
import { issueLocalRecoveryCredential } from "./ServerAccessStore.js";
import {
  createTestCertificate,
  freePort,
  httpsRequest,
  httpsUpgrade,
  plainHttpRequest,
  sessionCookieFrom,
  type TestResponse,
} from "./testSupport.js";

const PASSPHRASE = "correct horse battery staple";
const CHEAP_COST = { N: 1024, r: 8, p: 1 };

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
  readonly setupToken: () => string;
  readonly clock: { value: number };
  readonly appCalls: AssistantServerAuth[];
  readonly upgradeCalls: AssistantServerAuth[];
  request(input: {
    method?: string;
    path: string;
    headers?: Record<string, string>;
    body?: unknown;
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
  let setupToken: string | undefined;
  const appCalls: AssistantServerAuth[] = [];
  const upgradeCalls: AssistantServerAuth[] = [];
  const server = await createAssistantServer({
    dataRoot,
    tls: certificate,
    publicOrigins: [origin],
    listen: { host: "127.0.0.1", port },
    now: () => clock.value,
    passphraseCost: CHEAP_COST,
    onSetupCredential: (credential) => {
      setupToken = credential.token;
    },
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
  const harness: Harness = {
    server,
    port,
    origin,
    dataRoot,
    clock,
    appCalls,
    upgradeCalls,
    setupToken: () => {
      if (!setupToken) throw new Error("no setup credential issued");
      return setupToken;
    },
    request: (input) => httpsRequest({ port, ca: certificate.cert, ...input }),
    async restart() {
      await close();
      return await startHarness({ dataRoot, port, clock });
    },
  };
  return harness;
}

async function bootstrap(harness: Harness) {
  const response = await harness.request({
    method: "POST",
    path: "/api/auth/bootstrap",
    headers: { origin: harness.origin },
    body: {
      setupToken: harness.setupToken(),
      passphrase: PASSPHRASE,
      deviceLabel: "Laptop",
    },
  });
  expect(response.status).toBe(201);
  const body = response.body as { csrfToken: string; deviceId: string };
  return {
    cookie: sessionCookieFrom(response),
    csrf: body.csrfToken,
    deviceId: body.deviceId,
    response,
  };
}

function authHeaders(
  harness: Harness,
  session: { cookie: string; csrf: string },
) {
  return {
    origin: harness.origin,
    cookie: session.cookie,
    "x-agentlink-csrf": session.csrf,
  };
}

describe("assistant server access layer", () => {
  it("refuses to start without TLS or with a non-https origin", async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "assistant-cfg-"));
    cleanup.push(() => fs.rm(dataRoot, { recursive: true, force: true }));
    const base = {
      dataRoot,
      listen: { host: "127.0.0.1", port: 0 },
      onSetupCredential: () => undefined,
    };
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

  it("counts concurrent passphrase guesses against the limit", async () => {
    const harness = await startHarness();
    const owner = await bootstrap(harness);
    const statuses = await Promise.all(
      Array.from({ length: 12 }, () =>
        harness
          .request({
            method: "POST",
            path: "/api/auth/reauthenticate",
            headers: authHeaders(harness, owner),
            body: { passphrase: "wrong passphrase value" },
          })
          .then((response) => response.status),
      ),
    );
    expect(statuses.filter((status) => status === 401)).toHaveLength(5);
    expect(statuses.filter((status) => status === 429)).toHaveLength(7);
  });

  it("serves only TLS and sets security headers", async () => {
    const harness = await startHarness();
    await expect(plainHttpRequest(harness.port)).rejects.toThrow();
    const state = await harness.request({ path: "/api/auth/state" });
    expect(state).toMatchObject({
      status: 200,
      body: { ownerConfigured: false },
    });
    expect(state.headers).toMatchObject({
      "strict-transport-security": "max-age=31536000",
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    });
    expect(state.headers["content-security-policy"]).toContain(
      "frame-ancestors 'none'",
    );
  });

  it("bootstraps the owner once with the local setup credential", async () => {
    const harness = await startHarness();
    const missingOrigin = await harness.request({
      method: "POST",
      path: "/api/auth/bootstrap",
      body: { setupToken: harness.setupToken(), passphrase: PASSPHRASE },
    });
    expect(missingOrigin).toMatchObject({
      status: 403,
      body: { error: "origin_required" },
    });
    const wrong = await harness.request({
      method: "POST",
      path: "/api/auth/bootstrap",
      headers: { origin: harness.origin },
      body: { setupToken: "not-the-token", passphrase: PASSPHRASE },
    });
    expect(wrong).toMatchObject({
      status: 401,
      body: { error: "invalid_setup_credential" },
    });
    const weak = await harness.request({
      method: "POST",
      path: "/api/auth/bootstrap",
      headers: { origin: harness.origin },
      body: { setupToken: harness.setupToken(), passphrase: "short" },
    });
    expect(weak).toMatchObject({
      status: 400,
      body: { error: "weak_passphrase" },
    });

    const owner = await bootstrap(harness);
    const cookieHeader = owner.response.headers["set-cookie"]![0]!;
    expect(cookieHeader).toMatch(/^__Host-agentlink_session=[\w-]{43};/u);
    expect(cookieHeader).toContain("Secure");
    expect(cookieHeader).toContain("HttpOnly");
    expect(cookieHeader).toContain("SameSite=Strict");
    expect(cookieHeader).toContain("Path=/");

    const replay = await harness.request({
      method: "POST",
      path: "/api/auth/bootstrap",
      headers: { origin: harness.origin },
      body: { setupToken: harness.setupToken(), passphrase: PASSPHRASE },
    });
    expect(replay).toMatchObject({
      status: 409,
      body: { error: "owner_exists" },
    });
    const session = await harness.request({
      path: "/api/auth/session",
      headers: { cookie: owner.cookie },
    });
    expect(session).toMatchObject({
      status: 200,
      body: {
        deviceLabel: "Laptop",
        csrfToken: owner.csrf,
        recentlyAuthenticated: true,
      },
    });
    // Setup credential, session token and passphrase never reach disk.
    const stored = await fs.readFile(
      path.join(harness.dataRoot, "access-state.json"),
      "utf8",
    );
    expect(stored).not.toContain(harness.setupToken());
    expect(stored).not.toContain(owner.cookie.split("=")[1]);
    expect(stored).not.toContain(PASSPHRASE);
    expect(
      (await fs.stat(path.join(harness.dataRoot, "access-state.json"))).mode &
        0o777,
    ).toBe(0o600);
  });

  it("rejects forged proxy and identity headers and foreign hosts", async () => {
    const harness = await startHarness();
    const owner = await bootstrap(harness);
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
        path: "/api/app/echo",
        headers: { "x-remote-user": "owner" },
      }),
    ).resolves.toMatchObject({ status: 400 });
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

  it("requires same origin and the CSRF token for authenticated writes", async () => {
    const harness = await startHarness();
    const owner = await bootstrap(harness);
    const attempts: Array<[Record<string, string>, number, string]> = [
      [{ origin: harness.origin, cookie: owner.cookie }, 403, "csrf_invalid"],
      [
        {
          origin: harness.origin,
          cookie: owner.cookie,
          "x-agentlink-csrf": "forged",
        },
        403,
        "csrf_invalid",
      ],
      [
        {
          origin: "https://evil.example",
          cookie: owner.cookie,
          "x-agentlink-csrf": owner.csrf,
        },
        403,
        "origin_not_allowed",
      ],
      [
        {
          origin: harness.origin,
          "sec-fetch-site": "cross-site",
          cookie: owner.cookie,
          "x-agentlink-csrf": owner.csrf,
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

  it("requires recent reauthentication for sensitive actions", async () => {
    const harness = await startHarness();
    const owner = await bootstrap(harness);
    harness.clock.value += 6 * 60 * 1000;
    const stale = await harness.request({
      method: "POST",
      path: "/api/auth/pairings",
      headers: authHeaders(harness, owner),
    });
    expect(stale).toMatchObject({
      status: 401,
      body: { error: "reauthentication_required" },
    });
    await expect(
      harness.request({
        method: "POST",
        path: "/api/auth/reauthenticate",
        headers: authHeaders(harness, owner),
        body: { passphrase: "wrong passphrase value" },
      }),
    ).resolves.toMatchObject({
      status: 401,
      body: { error: "invalid_passphrase" },
    });
    await expect(
      harness.request({
        method: "POST",
        path: "/api/auth/reauthenticate",
        headers: authHeaders(harness, owner),
        body: { passphrase: PASSPHRASE },
      }),
    ).resolves.toMatchObject({ status: 204 });
    await expect(
      harness.request({
        method: "POST",
        path: "/api/auth/pairings",
        headers: authHeaders(harness, owner),
      }),
    ).resolves.toMatchObject({
      status: 201,
      body: { code: expect.stringMatching(/^[0-9A-Z]{5}-[0-9A-Z]{5}$/u) },
    });
  });

  it("pairs a second device with a single-use code and revokes it durably", async () => {
    let harness = await startHarness();
    const owner = await bootstrap(harness);
    const ownerId = (owner.response.body as { ownerId: string }).ownerId;
    const pairing = await harness.request({
      method: "POST",
      path: "/api/auth/pairings",
      headers: authHeaders(harness, owner),
    });
    const { code } = pairing.body as { code: string };
    const phone = await harness.request({
      method: "POST",
      path: "/api/auth/pairings/redeem",
      headers: { origin: harness.origin },
      body: { code: code.toLowerCase(), deviceLabel: "Phone" },
    });
    expect(phone.status).toBe(201);
    const phoneSession = {
      cookie: sessionCookieFrom(phone),
      csrf: (phone.body as { csrfToken: string }).csrfToken,
      deviceId: (phone.body as { deviceId: string }).deviceId,
    };
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
    await expect(
      harness.request({
        path: "/api/app/echo",
        headers: { cookie: phoneSession.cookie },
      }),
    ).resolves.toMatchObject({ status: 200, body: { subjectId: ownerId } });
    expect(harness.appCalls[0]!.principal).toEqual({
      tenantId: "agentlink-server",
      subjectId: ownerId,
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

  it("signs in again with a local recovery code after revoking every device", async () => {
    const harness = await startHarness();
    const owner = await bootstrap(harness);
    const ownerId = (owner.response.body as { ownerId: string }).ownerId;
    await expect(
      harness.request({
        method: "DELETE",
        path: `/api/auth/devices/${owner.deviceId}`,
        headers: authHeaders(harness, owner),
      }),
    ).resolves.toMatchObject({ status: 204 });
    await expect(
      harness.request({
        path: "/api/auth/session",
        headers: { cookie: owner.cookie },
      }),
    ).resolves.toMatchObject({ status: 401 });

    const { token } = await issueLocalRecoveryCredential({
      dataRoot: harness.dataRoot,
      now: () => harness.clock.value,
    });
    const redeem = (body: Record<string, unknown>, origin = harness.origin) =>
      harness.request({
        method: "POST",
        path: "/api/auth/recover",
        headers: { origin },
        body,
      });
    await expect(
      redeem({ recoveryToken: token, passphrase: PASSPHRASE }, "https://evil"),
    ).resolves.toMatchObject({ status: 403 });
    await expect(
      redeem({ recoveryToken: token, passphrase: "not the passphrase" }),
    ).resolves.toMatchObject({
      status: 401,
      body: { error: "invalid_recovery_credential" },
    });
    const recovered = await redeem({
      recoveryToken: token,
      passphrase: PASSPHRASE,
      deviceLabel: "Recovered",
    });
    expect(recovered.status).toBe(201);
    expect(recovered.body).toMatchObject({ ownerId, deviceLabel: "Recovered" });
    await expect(
      harness.request({
        path: "/api/app/echo",
        headers: { cookie: sessionCookieFrom(recovered) },
      }),
    ).resolves.toMatchObject({ status: 200, body: { subjectId: ownerId } });
    await expect(
      redeem({ recoveryToken: token, passphrase: PASSPHRASE }),
    ).resolves.toMatchObject({ status: 401 });
  });

  it("expires pairing codes", async () => {
    const harness = await startHarness();
    const owner = await bootstrap(harness);
    const pairing = await harness.request({
      method: "POST",
      path: "/api/auth/pairings",
      headers: authHeaders(harness, owner),
    });
    harness.clock.value += 5 * 60 * 1000 + 1;
    await expect(
      harness.request({
        method: "POST",
        path: "/api/auth/pairings/redeem",
        headers: { origin: harness.origin },
        body: { code: (pairing.body as { code: string }).code },
      }),
    ).resolves.toMatchObject({ status: 401 });
  });

  it("rate limits credential guessing even when the next guess is correct", async () => {
    const harness = await startHarness();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await harness.request({
        method: "POST",
        path: "/api/auth/bootstrap",
        headers: { origin: harness.origin },
        body: { setupToken: `guess-${attempt}`, passphrase: PASSPHRASE },
      });
    }
    await expect(
      harness.request({
        method: "POST",
        path: "/api/auth/bootstrap",
        headers: { origin: harness.origin },
        body: { setupToken: harness.setupToken(), passphrase: PASSPHRASE },
      }),
    ).resolves.toMatchObject({ status: 429, body: { error: "rate_limited" } });
  });

  it("authenticates upgrades by cookie and exact origin", async () => {
    const harness = await startHarness();
    const owner = await bootstrap(harness);
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
});
