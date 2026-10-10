import { X509Certificate } from "node:crypto";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  startAssistantService,
  type AssistantService,
} from "./assistantService.js";
import type { PushRequest } from "./pushService.js";
import { parseAssistantServerConfig } from "./serverConfig.js";
import {
  createTestCertificate,
  createTestPushSubscriber,
  freePort,
  httpsRequest,
  sessionCookieFrom,
} from "./testSupport.js";

const DAY = 24 * 60 * 60 * 1000;

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

/**
 * Complete a TLS handshake trusting only `ca` and return the server
 * certificate. `verify: false` skips OpenSSL's checks (used when the test
 * clock is in the future, so the real clock sees "not yet valid"); callers
 * then check the CA signature themselves.
 */
function peerCertificate(
  port: number,
  ca: string,
  verify = true,
): Promise<tls.PeerCertificate> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      host: "127.0.0.1",
      port,
      servername: "localhost",
      ca,
      rejectUnauthorized: verify,
    });
    socket.once("secureConnect", () => {
      const peer = socket.getPeerCertificate();
      socket.destroy();
      resolve(peer);
    });
    socket.once("error", reject);
  });
}

describe("assistant service local certificates", () => {
  it("renews the server certificate in the running listener", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "assistant-svc-"));
    cleanup.push(() => fs.rm(root, { recursive: true, force: true }));
    await fs.mkdir(path.join(root, "projects", "home"), { recursive: true });
    const port = await freePort();
    const config = parseAssistantServerConfig(
      {
        schemaVersion: 1,
        dataRoot: "data",
        listen: { host: "127.0.0.1", port },
        publicOrigins: [`https://localhost:${port}`],
        tls: { localCa: true },
        defaultModel: { providerId: "local", modelId: "fixture" },
        providers: [
          {
            type: "openai-compatible",
            id: "local",
            baseURL: "http://127.0.0.1:9/v1",
            noAuth: true,
            models: [
              {
                id: "fixture",
                contextWindow: 32_768,
                maxOutputTokens: 4_096,
                supportsToolUse: true,
              },
            ],
          },
        ],
        projects: [{ id: "home", root: "projects/home" }],
      },
      root,
    );
    const clock = { value: Date.now() };
    const log: string[] = [];
    const service: AssistantService = await startAssistantService({
      config,
      log: (line) => log.push(line),
      now: () => clock.value,
      certificateCheckIntervalMs: 25,
    });
    cleanup.push(() => service.close());

    const ca = await fs.readFile(
      path.join(root, "data", "tls", "ca.pem"),
      "utf8",
    );
    const first = await peerCertificate(port, ca);
    expect(log.join("\n")).toContain("Created a local certificate authority");

    // A second service on the same data root cannot touch the certificates.
    await expect(
      startAssistantService({ config, log: () => undefined }),
    ).rejects.toThrow(/Another agentlink-server process is using/u);
    expect((await peerCertificate(port, ca)).serialNumber).toBe(
      first.serialNumber,
    );

    // Nothing changes while the certificate is current.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await peerCertificate(port, ca)).serialNumber).toBe(
      first.serialNumber,
    );

    // Near expiry, the running server picks up a renewed certificate from
    // the same CA without a restart.
    clock.value = new Date(first.valid_to).getTime() - 10 * DAY;
    const caKey = new X509Certificate(ca).publicKey;
    await vi.waitFor(
      async () => {
        const renewed = await peerCertificate(port, ca, false);
        expect(renewed.serialNumber).not.toBe(first.serialNumber);
        expect(new X509Certificate(renewed.raw).verify(caKey)).toBe(true);
        expect(new Date(renewed.valid_to).getTime()).toBeGreaterThan(
          new Date(first.valid_to).getTime(),
        );
      },
      { timeout: 10_000, interval: 50 },
    );
    expect(
      log.filter((line) => line.startsWith("Issued server certificate")),
    ).toHaveLength(2);
  }, 30_000);
});

describe("assistant service notifications", () => {
  it("pushes a job run's inbox entry to subscribed devices until they are revoked", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "assistant-push-"));
    cleanup.push(() => fs.rm(root, { recursive: true, force: true }));
    await fs.mkdir(path.join(root, "projects", "home"), { recursive: true });
    const certificate = createTestCertificate();
    await fs.writeFile(path.join(root, "server.crt"), certificate.cert);
    await fs.writeFile(path.join(root, "server.key"), certificate.key, {
      mode: 0o600,
    });
    // A model that refuses every request, so the run fails at once.
    const model = http.createServer((request, response) => {
      request.resume();
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "bad request" } }));
    });
    await new Promise<void>((resolve) =>
      model.listen(0, "127.0.0.1", () => resolve()),
    );
    cleanup.push(
      () => new Promise<void>((resolve) => model.close(() => resolve())),
    );
    const modelPort = (model.address() as { port: number }).port;
    const port = await freePort();
    const origin = `https://localhost:${port}`;
    const config = parseAssistantServerConfig(
      {
        schemaVersion: 1,
        dataRoot: "data",
        listen: { host: "127.0.0.1", port },
        publicOrigins: [origin],
        tls: { certFile: "server.crt", keyFile: "server.key" },
        defaultModel: { providerId: "local", modelId: "fixture" },
        providers: [
          {
            type: "openai-compatible",
            id: "local",
            baseURL: `http://127.0.0.1:${modelPort}/v1`,
            noAuth: true,
            allowInsecureHttp: true,
            models: [
              {
                id: "fixture",
                contextWindow: 32_768,
                maxOutputTokens: 4_096,
                supportsToolUse: true,
              },
            ],
          },
        ],
        projects: [{ id: "home", root: "projects/home" }],
      },
      root,
    );
    const pushed: PushRequest[] = [];
    const service = await startAssistantService({
      config,
      log: () => undefined,
      pushTransport: async (request) => {
        pushed.push(request);
        return { status: 201 };
      },
    });
    cleanup.push(() => service.close());
    const request = (input: {
      method?: string;
      path: string;
      body?: unknown;
      cookie?: string;
    }) =>
      httpsRequest({
        port,
        ca: certificate.cert,
        method: input.method,
        path: input.path,
        body: input.body,
        headers: {
          ...(input.method && input.method !== "GET" ? { origin } : {}),
          ...(input.cookie ? { cookie: input.cookie } : {}),
        },
      });

    const { code } = service.server.store.createPairing();
    const paired = await request({
      method: "POST",
      path: "/api/auth/pairings/redeem",
      body: { code, deviceLabel: "Phone" },
    });
    const cookie = sessionCookieFrom(paired);
    const deviceId = (paired.body as { deviceId: string }).deviceId;
    const phone = createTestPushSubscriber();
    await expect(
      request({
        method: "PUT",
        path: "/api/push/subscription",
        body: phone.subscription,
        cookie,
      }),
    ).resolves.toMatchObject({ status: 200 });

    const created = await request({
      method: "POST",
      path: "/api/jobs",
      cookie,
      body: {
        name: "Check in",
        projectId: "home",
        prompt: "Anything new?",
        schedule: { kind: "interval", everyMinutes: 15 },
      },
    });
    const jobId = (created.body as { job: { id: string } }).job.id;
    await expect(
      request({ method: "POST", path: `/api/jobs/${jobId}/run`, cookie }),
    ).resolves.toMatchObject({ status: 202 });

    await vi.waitFor(() => expect(pushed).toHaveLength(1), {
      timeout: 20_000,
      interval: 50,
    });
    expect(pushed[0]!.url.href).toBe(phone.subscription.endpoint);
    const inbox = (await request({ path: "/api/inbox", cookie })).body as {
      entries: Array<{ id: string; title: string; sessionId: string }>;
    };
    const [entry] = inbox.entries;
    expect(phone.read(pushed[0]!.body)).toMatchObject({
      title: entry!.title,
      url: `/?inboxEntry=${entry!.id}&openProject=home&openSession=${entry!.sessionId}`,
    });

    // Revoking the device deletes its subscription.
    await expect(
      request({
        method: "DELETE",
        path: `/api/auth/devices/${deviceId}`,
        cookie,
      }),
    ).resolves.toMatchObject({ status: 204 });
    await vi.waitFor(async () => {
      const stored = JSON.parse(
        await fs.readFile(
          path.join(root, "data", "push", "subscriptions.json"),
          "utf8",
        ),
      ) as { subscriptions: unknown[] };
      expect(stored.subscriptions).toEqual([]);
    });
  }, 40_000);
});
