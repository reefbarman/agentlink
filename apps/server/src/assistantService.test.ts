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
import { readUsageSources } from "./usageReport.js";

const updateStatus = {
  configured: true,
  managed: true,
  installedVersion: "1.2.3",
  installedCommit: null,
  updaterProtocol: 1 as const,
  canRollback: false,
  rollbackVersion: null,
  discovery: {
    status: "idle" as const,
    automaticChecks: true,
    includePreviews: false,
    checkedAt: null,
    lastAttemptAt: null,
    retryAt: null,
    stale: false,
    releases: [],
  },
  operation: null,
};

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
    cleanup.push(() =>
      fs.rm(root, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 50,
      }),
    );
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

describe("assistant service updater wiring", () => {
  it("forwards owner update confirmations to the fixed updater and blocks unsafe calls", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "assistant-updates-"));
    cleanup.push(() =>
      fs.rm(root, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 50,
      }),
    );
    await fs.mkdir(path.join(root, "projects", "home"), { recursive: true });
    const certificate = createTestCertificate();
    await fs.writeFile(path.join(root, "server.crt"), certificate.cert);
    await fs.writeFile(path.join(root, "server.key"), certificate.key, {
      mode: 0o600,
    });
    const upstreamRequests: Array<{
      path: string | undefined;
      authorization: string | undefined;
      body: unknown;
    }> = [];
    let unavailable = false;
    const updater = http.createServer((request, response) => {
      let raw = "";
      request.on("data", (chunk: Buffer) => (raw += chunk.toString()));
      request.on("end", () => {
        upstreamRequests.push({
          path: request.url,
          authorization: request.headers.authorization,
          body: raw ? JSON.parse(raw) : undefined,
        });
        response.writeHead(unavailable ? 503 : 200, {
          "content-type": "application/json",
        });
        response.end(
          JSON.stringify(
            unavailable
              ? { error: "update_unavailable" }
              : { status: updateStatus },
          ),
        );
      });
    });
    await new Promise<void>((resolve) =>
      updater.listen(0, "127.0.0.1", resolve),
    );
    cleanup.push(
      () => new Promise<void>((resolve) => updater.close(() => resolve())),
    );
    const updaterPort = (updater.address() as { port: number }).port;
    const port = await freePort();
    const origin = `https://localhost:${port}`;
    const token = "private-updater-test-token";
    await fs.writeFile(path.join(root, "updater-token"), token, {
      mode: 0o600,
    });
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
        updater: {
          host: "127.0.0.1",
          port: updaterPort,
          token: { file: "updater-token" },
        },
      },
      root,
    );
    const service = await startAssistantService({
      config,

      log: () => undefined,
    });
    cleanup.push(() => service.close());
    const { code } = service.server.store.createPairing();
    const paired = await httpsRequest({
      port,
      ca: certificate.cert,
      method: "POST",
      path: "/api/auth/pairings/redeem",
      headers: { origin },
      body: { code, deviceLabel: "Owner" },
    });
    const cookie = sessionCookieFrom(paired);
    const request = (input: {
      path: string;
      method?: string;
      body?: unknown;
      origin?: string;
      cookie?: string;
    }) =>
      httpsRequest({
        port,
        ca: certificate.cert,
        method: input.method,
        path: input.path,
        body: input.body,
        headers: {
          ...(input.method && input.method !== "GET"
            ? { origin: input.origin ?? origin }
            : {}),
          ...(input.cookie === undefined
            ? { cookie }
            : { cookie: input.cookie }),
        },
      });
    // Startup preflight also reads status; the assertions below cover browser requests.
    upstreamRequests.length = 0;
    const confirmation = {
      version: "1.3.0",
      expectedInstalledVersion: "1.2.3",
      confirmed: true,
    } as const;
    await expect(request({ path: "/api/updates" })).resolves.toMatchObject({
      status: 200,
      body: { status: { installedVersion: "1.2.3" } },
    });
    await expect(
      request({
        path: "/api/updates/preferences",
        method: "POST",
        body: { automaticChecks: false, includePreviews: true },
      }),
    ).resolves.toMatchObject({ status: 200 });
    await expect(
      request({
        path: "/api/updates/apply",
        method: "POST",
        body: confirmation,
      }),
    ).resolves.toMatchObject({ status: 202 });
    expect(upstreamRequests).toEqual([
      {
        path: "/v1/updates",
        authorization: `Bearer ${token}`,
        body: undefined,
      },
      {
        path: "/v1/updates/preferences",
        authorization: `Bearer ${token}`,
        body: { automaticChecks: false, includePreviews: true },
      },
      {
        path: "/v1/updates/apply",
        authorization: `Bearer ${token}`,
        body: confirmation,
      },
    ]);
    const beforeRejectedRequests = upstreamRequests.length;
    await expect(
      request({
        path: "/api/updates/apply",
        method: "POST",
        origin: "https://attacker.example",
        body: confirmation,
      }),
    ).resolves.toMatchObject({ status: 403 });
    await expect(
      request({
        path: "/api/updates/apply",
        method: "POST",
        cookie: "",
        body: confirmation,
      }),
    ).resolves.toMatchObject({ status: 401 });
    expect(upstreamRequests).toHaveLength(beforeRejectedRequests);
    unavailable = true;
    await expect(request({ path: "/api/updates" })).resolves.toMatchObject({
      status: 200,
      body: { configured: true, error: "update_unavailable" },
    });
  }, 30_000);
});

describe("assistant service first-run setup wiring", () => {
  it("opens setup from the installer marker and starts ChatGPT sign-in through the service's own runtime", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "assistant-setup-"));
    cleanup.push(() =>
      fs.rm(root, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 50,
      }),
    );
    await fs.mkdir(path.join(root, "projects", "home"), { recursive: true });
    await fs.mkdir(path.join(root, "data", "settings"), { recursive: true });
    await fs.writeFile(
      path.join(root, "data", "settings", "onboarding.json"),
      '{"schemaVersion": 1, "revision": 0, "freshInstall": true, "steps": {}}\n',
      { mode: 0o600 },
    );
    const certificate = createTestCertificate();
    await fs.writeFile(path.join(root, "server.crt"), certificate.cert);
    await fs.writeFile(path.join(root, "server.key"), certificate.key, {
      mode: 0o600,
    });
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
          { type: "codex" },
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
    const service = await startAssistantService({
      config,
      log: () => undefined,
    });
    cleanup.push(() => service.close());
    const { code } = service.server.store.createPairing();
    const paired = await httpsRequest({
      port,
      ca: certificate.cert,
      method: "POST",
      path: "/api/auth/pairings/redeem",
      headers: { origin },
      body: { code, deviceLabel: "Owner" },
    });
    const cookie = sessionCookieFrom(paired);
    const request = (input: {
      path: string;
      method?: string;
      body?: unknown;
      origin?: string;
    }) =>
      httpsRequest({
        port,
        ca: certificate.cert,
        method: input.method,
        path: input.path,
        body: input.body,
        headers: {
          cookie,
          ...(input.method && input.method !== "GET"
            ? { origin: input.origin ?? origin }
            : {}),
        },
      });
    await expect(request({ path: "/api/onboarding" })).resolves.toMatchObject({
      status: 200,
      body: {
        openSetup: true,
        // Operator models are usable, but setup was never finished.
        status: "setup-incomplete",
        facts: {
          model: {
            codexAvailable: true,
            codexSignedIn: false,
            otherProviders: 1,
          },
          backup: { configured: false },
          features: expect.objectContaining({
            editor: expect.stringMatching(/^(on|off|needs-runners)$/u),
            browser: expect.stringMatching(/^(on|off|needs-runners)$/u),
          }),
        },
      },
    });
    await expect(
      request({ path: "/api/providers/codex" }),
    ).resolves.toMatchObject({
      status: 200,
      body: { available: true, accounts: [], pending: null },
    });
    const started = await request({
      path: "/api/providers/codex/sign-in",
      method: "POST",
      body: {},
    });
    expect(started.status).toBe(200);
    expect(
      new URL(
        (started.body as { authorizeUrl: string }).authorizeUrl,
      ).searchParams.get("redirect_uri"),
    ).toBe("http://localhost:1455/auth/callback");
    await expect(
      request({
        path: "/api/providers/codex/sign-in",
        method: "POST",
        body: {},
        origin: "https://attacker.example",
      }),
    ).resolves.toMatchObject({ status: 403 });
    await expect(
      request({
        path: "/api/onboarding",
        method: "PATCH",
        body: { expectedRevision: 0, dismiss: true },
      }),
    ).resolves.toMatchObject({ status: 200, body: { openSetup: false } });
  }, 30_000);
});

describe("assistant service managed OpenAI key", () => {
  it("offers a key saved in the browser to the running service's chats, rotates and removes it live, and keeps it across a restart", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "assistant-openai-"));
    cleanup.push(() =>
      fs.rm(root, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 50,
      }),
    );
    await fs.mkdir(path.join(root, "projects", "home"), { recursive: true });
    await fs.mkdir(path.join(root, "data", "settings"), { recursive: true });
    // What the guided installer writes: the opt-in, with no key.
    await fs.writeFile(
      path.join(root, "data", "settings", "model-providers.json"),
      '{"schemaVersion": 1, "revision": 0}\n',
      { mode: 0o600 },
    );
    const certificate = createTestCertificate();
    await fs.writeFile(path.join(root, "server.crt"), certificate.cert);
    await fs.writeFile(path.join(root, "server.key"), certificate.key, {
      mode: 0o600,
    });
    // Requests to OpenAI are answered here, as an invalid key would be.
    const realFetch = globalThis.fetch;
    const openAiCalls: string[] = [];
    vi.stubGlobal(
      "fetch",
      async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          input instanceof Request ? input.url : new URL(String(input)).href;
        if (new URL(url).hostname !== "api.openai.com") {
          return realFetch(input, init);
        }
        const headers = new Headers(
          input instanceof Request ? input.headers : init?.headers,
        );
        openAiCalls.push(headers.get("authorization") ?? "");
        return new Response(
          JSON.stringify({
            error: {
              message: "Incorrect API key provided",
              type: "invalid_request_error",
              code: "invalid_api_key",
            },
          }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
      },
    );
    cleanup.push(async () => {
      vi.unstubAllGlobals();
    });
    const port = await freePort();
    const origin = `https://localhost:${port}`;
    const config = parseAssistantServerConfig(
      {
        schemaVersion: 1,
        dataRoot: "data",
        listen: { host: "127.0.0.1", port },
        publicOrigins: [origin],
        tls: { certFile: "server.crt", keyFile: "server.key" },
        defaultModel: { providerId: "codex", modelId: "gpt-6.1-sol" },
        providers: [{ type: "codex" }],
        projects: [{ id: "home", root: "projects/home" }],
      },
      root,
    );
    let service = await startAssistantService({
      config,
      log: () => undefined,
    });
    cleanup.push(() => service.close());
    const { code } = service.server.store.createPairing();
    const cookie = sessionCookieFrom(
      await httpsRequest({
        port,
        ca: certificate.cert,
        method: "POST",
        path: "/api/auth/pairings/redeem",
        headers: { origin },
        body: { code, deviceLabel: "Owner" },
      }),
    );
    const request = (input: {
      path: string;
      method?: string;
      body?: unknown;
    }) =>
      httpsRequest({
        port,
        ca: certificate.cert,
        method: input.method,
        path: input.path,
        body: input.body,
        headers: {
          cookie,
          ...(input.method && input.method !== "GET" ? { origin } : {}),
        },
      });
    type Status = {
      revision: number;
      openai: { state: string; label?: string };
      openAiModels: Array<{ providerId: string; modelId: string }>;
      availableModels: Array<{ providerId: string; modelId: string }>;
      defaultModel: { providerId: string; modelId: string };
    };
    const status = async () =>
      (await request({ path: "/api/providers/openai" })).body as Status;
    const chatModels = async () =>
      (
        (await request({ path: "/api/ask-agent/models" })).body as {
          models: Array<{ id: string }>;
        }
      ).models.map((model) => model.id);
    const sendInNewChat = async (text: string) => {
      await request({
        path: "/api/ask-agent/session/new",
        method: "POST",
        body: {},
      });
      void request({
        path: "/api/ask-agent/send",
        method: "POST",
        body: { text },
      }).catch(() => undefined);
    };

    const initial = await status();
    expect(initial.openai.state).toBe("not-set");
    expect(initial.availableModels.every((m) => m.providerId === "codex")).toBe(
      true,
    );
    const first = initial.openAiModels[0]!;
    const model = { providerId: first.providerId, modelId: first.modelId };
    expect(model.providerId).toBe("openai");
    expect((await chatModels()).some((id) => id.startsWith("openai/"))).toBe(
      false,
    );
    // Choosing OpenAI before a key is saved is refused.
    await expect(
      request({
        path: "/api/providers/default-model",
        method: "PUT",
        body: { expectedRevision: initial.revision, model },
      }),
    ).resolves.toMatchObject({
      status: 400,
      body: { error: "model_not_available" },
    });

    const firstKey = `sk-first-${"a".repeat(32)}`;
    const saved = await request({
      path: "/api/providers/openai/key",
      method: "PUT",
      body: { expectedRevision: initial.revision, apiKey: firstKey },
    });
    expect(saved.status).toBe(200);
    expect(JSON.stringify(saved.body)).not.toContain(firstKey);
    expect((saved.body as Status).openai).toMatchObject({
      state: "saved",
      label: "sk-…aaaa",
    });
    // Saving sends nothing to OpenAI.
    expect(openAiCalls).toEqual([]);
    const keyFile = path.join(root, "data", "credentials", "openai-api-key");
    expect((await fs.stat(keyFile)).mode & 0o777).toBe(0o600);
    expect(
      await fs.readFile(
        path.join(root, "data", "settings", "model-providers.json"),
        "utf8",
      ),
    ).not.toContain("sk-");
    // The running server offers OpenAI's models at once.
    expect(await chatModels()).toContain(`openai/${model.modelId}`);
    const chosen = await request({
      path: "/api/providers/default-model",
      method: "PUT",
      body: { expectedRevision: (saved.body as Status).revision, model },
    });
    expect(chosen).toMatchObject({
      status: 200,
      body: { defaultModel: model, defaultModelSource: "setup" },
    });
    await expect(request({ path: "/api/onboarding" })).resolves.toMatchObject({
      body: { facts: { model: { openAiKeySaved: true } } },
    });

    // A new chat uses the chosen model with the saved key.
    await sendInNewChat("Hello");
    await vi.waitFor(
      () => expect(openAiCalls).toContain(`Bearer ${firstKey}`),
      {
        timeout: 20_000,
        interval: 50,
      },
    );

    // A replaced key is used by the next request, without a restart.
    const secondKey = `sk-second-${"b".repeat(32)}`;
    const rotated = await request({
      path: "/api/providers/openai/key",
      method: "PUT",
      body: {
        expectedRevision: (chosen.body as Status).revision,
        apiKey: secondKey,
      },
    });
    expect(rotated.status).toBe(200);
    await sendInNewChat("Hello again");
    await vi.waitFor(
      () => expect(openAiCalls).toContain(`Bearer ${secondKey}`),
      { timeout: 20_000, interval: 50 },
    );
    const snapshot = await request({ path: "/api/ask-agent/session" });
    expect(JSON.stringify(snapshot.body)).not.toContain(secondKey);

    // A stale tab cannot remove it.
    await expect(
      request({
        path: "/api/providers/openai/key",
        method: "DELETE",
        body: { expectedRevision: (chosen.body as Status).revision },
      }),
    ).resolves.toMatchObject({
      status: 409,
      body: { error: "providers_changed" },
    });

    // The key survives a restart, with the chosen default.
    await service.close();
    service = await startAssistantService({ config, log: () => undefined });
    const restarted = await status();
    expect(restarted.openai).toMatchObject({
      state: "saved",
      label: "sk-…bbbb",
    });
    expect(restarted.defaultModel).toEqual(model);

    // Removed: no request carries a key, and the chosen default stays (new
    // chats on it fail clearly rather than quietly using ChatGPT).
    const removed = await request({
      path: "/api/providers/openai/key",
      method: "DELETE",
      body: { expectedRevision: restarted.revision },
    });
    expect(removed).toMatchObject({
      status: 200,
      body: { openai: { state: "not-set" }, defaultModel: model },
    });
    await expect(fs.stat(keyFile)).rejects.toThrow();
    const models = await chatModels();
    expect(models.filter((id) => id.startsWith("openai/"))).toEqual([
      `openai/${model.modelId}`,
    ]);
    const callsBefore = openAiCalls.length;
    await sendInNewChat("Still there?");
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(openAiCalls).toHaveLength(callsBefore);
  }, 60_000);
});

describe("assistant service chat-created jobs", () => {
  it("creates a job a chat proposed only once the owner approves its card", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "assistant-jobs-"));
    cleanup.push(() =>
      fs.rm(root, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 50,
      }),
    );
    await fs.mkdir(path.join(root, "projects", "home"), { recursive: true });
    const certificate = createTestCertificate();
    await fs.writeFile(path.join(root, "server.crt"), certificate.cert);
    await fs.writeFile(path.join(root, "server.key"), certificate.key, {
      mode: 0o600,
    });
    const offered: string[][] = [];
    const toolResults: string[] = [];
    // Proposes a job, then reports what the tool said.
    const model = http.createServer((request, response) => {
      let raw = "";
      request.on("data", (chunk: Buffer) => (raw += chunk.toString()));
      request.on("end", () => {
        const body = JSON.parse(raw) as {
          messages: Array<{ role: string; content?: unknown }>;
          tools?: Array<{ function: { name: string } }>;
        };
        offered.push((body.tools ?? []).map((tool) => tool.function.name));
        const last = body.messages.at(-1);
        const delta =
          last?.role === "tool"
            ? (toolResults.push(String(last.content)), { content: "Done." })
            : {
                tool_calls: [
                  {
                    index: 0,
                    id: "call-job",
                    type: "function",
                    function: {
                      name: "schedule_job",
                      arguments: JSON.stringify({
                        name: "Morning brief",
                        prompt: "Brief me on today.",
                        schedule: {
                          kind: "daily",
                          time: "07:30",
                          timeZone: "Australia/Sydney",
                        },
                      }),
                    },
                  },
                ],
              };
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(
          `data: ${JSON.stringify({
            id: "r",
            choices: [
              {
                index: 0,
                delta,
                finish_reason: "tool_calls" in delta ? "tool_calls" : "stop",
              },
            ],
          })}\n\ndata: [DONE]\n\n`,
        );
      });
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
        projects: [{ id: "home", label: "Home", root: "projects/home" }],
      },
      root,
    );
    const service = await startAssistantService({
      config,
      log: () => undefined,
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
    const cookie = sessionCookieFrom(
      await request({
        method: "POST",
        path: "/api/auth/pairings/redeem",
        body: { code, deviceLabel: "Laptop" },
      }),
    );

    // Settles when the turn does, or fails when the service closes.
    void request({
      method: "POST",
      path: "/api/ask-agent/send",
      body: { text: "Brief me every morning at 7:30" },
      cookie,
    }).catch(() => undefined);
    type Approval = { id: string; filePath: string; detail: string };
    const approval = await vi.waitFor(
      async () => {
        const { body } = await request({
          path: "/api/ask-agent/session",
          cookie,
        });
        const pending = (
          body as { snapshot: { ui: { approval: Approval | null } } }
        ).snapshot.ui.approval;
        expect(pending).not.toBeNull();
        return pending!;
      },
      { timeout: 20_000, interval: 50 },
    );
    expect(offered[0]).toEqual(
      expect.arrayContaining(["list_jobs", "schedule_job", "delete_job"]),
    );
    expect(approval.filePath).toBe(
      'Schedule "Morning brief": every day at 07:30 (Australia/Sydney)?',
    );
    expect(approval.detail).toContain("Project: Home (home)");
    expect(approval.detail).toContain("Brief me on today.");
    // The chat is autonomous by default; the job still waited for the owner.
    const before = await request({ path: "/api/jobs", cookie });
    expect((before.body as { jobs: unknown[] }).jobs).toEqual([]);

    // The card can show a moment before the turn has finished pausing.
    await vi.waitFor(
      async () => {
        const answered = await request({
          method: "POST",
          path: "/api/ask-agent/approval",
          body: { id: approval.id, decision: "accept" },
          cookie,
        });
        expect(answered.status).toBe(200);
      },
      { timeout: 10_000, interval: 100 },
    );
    const jobs = await vi.waitFor(
      async () => {
        const { body } = await request({ path: "/api/jobs", cookie });
        const list = (body as { jobs: Array<Record<string, unknown>> }).jobs;
        expect(list).toHaveLength(1);
        expect(list[0]!.nextRunAt).toEqual(expect.any(Number));
        return list;
      },
      { timeout: 20_000, interval: 50 },
    );
    expect(jobs[0]).toMatchObject({
      name: "Morning brief",
      projectId: "home",
      prompt: "Brief me on today.",
      enabled: true,
      schedule: { kind: "daily", time: "07:30", timeZone: "Australia/Sydney" },
    });
    await vi.waitFor(() =>
      expect(toolResults.join("\n")).toContain(
        'Created the scheduled job "Morning brief"',
      ),
    );
  }, 40_000);
});

describe("assistant service notifications", () => {
  it("pushes a job run's inbox entry to subscribed devices until they are revoked", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "assistant-push-"));
    cleanup.push(() =>
      fs.rm(root, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 50,
      }),
    );
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
      response.end(
        JSON.stringify({
          error: { message: "fixture model is switched off today" },
        }),
      );
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
    // This test exercises delivery and revocation, not quiet-hour holding.
    // Defaults start quiet hours at 22:00, so leaving them on makes the test
    // depend on the host's clock. Quiet-hour behaviour has separate coverage.
    const persona = await request({ path: "/api/settings/persona", cookie });
    const updatedAt = (persona.body as { settings: { updatedAt: number } })
      .settings.updatedAt;
    await expect(
      request({
        method: "PATCH",
        path: "/api/settings/persona",
        cookie,
        body: { expectedUpdatedAt: updatedAt, quietHours: null },
      }),
    ).resolves.toMatchObject({ status: 200 });
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
    // The provider's reason reaches the run and the Inbox, not the push.
    const runs = (
      (await request({ path: `/api/jobs/${jobId}/runs`, cookie })).body as {
        runs: Array<{ status: string; errorDetail?: string }>;
      }
    ).runs;
    expect(runs[0]!.errorDetail).toContain("fixture model is switched off");
    expect((entry as { body?: string }).body).toContain(
      "fixture model is switched off",
    );
    // The delivered push is counted for the usage report (counts only).
    await vi.waitFor(
      async () =>
        expect((await readUsageSources(config.dataRoot)).pushes).toEqual([
          expect.objectContaining({ sent: 1, failed: 0, gone: 0 }),
        ]),
      { timeout: 5_000, interval: 50 },
    );
    expect(JSON.stringify(phone.read(pushed[0]!.body))).not.toContain(
      "switched off",
    );

    // Opening the run's chat (as the chat list does) reads its entry.
    await expect(
      request({
        method: "POST",
        path: "/api/ask-agent/projects/select",
        cookie,
        body: { projectId: "home", sessionId: entry!.sessionId },
      }),
    ).resolves.toMatchObject({ status: 200 });
    await vi.waitFor(
      async () =>
        expect(
          (await request({ path: "/api/inbox", cookie })).body,
        ).toMatchObject({
          unread: 0,
          entries: [expect.objectContaining({ id: entry!.id, read: true })],
        }),
      { timeout: 5_000, interval: 50 },
    );

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
