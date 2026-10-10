import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AssistantServerAuth } from "./assistantServer.js";
import { networkPolicyAllows } from "./egressPolicy.js";
import { HttpError } from "./httpJson.js";
import type { InboxEntry } from "./inboxStore.js";
import { TEST_PUSH_MESSAGE, createPushRoutes } from "./pushRoutes.js";
import {
  PUSH_NETWORK_POLICY,
  PushSubscriptionError,
  checkPushSubscription,
  openPushService,
  pushMessageForEntry,
  type PushRequest,
  type PushResponse,
} from "./pushService.js";
import { createTestPushSubscriber } from "./testSupport.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

async function tempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "push-"));
  cleanup.push(() => fs.rm(dir, { recursive: true, force: true }));
  return path.join(dir, "push");
}

/** A push service stand-in answering each request from a queue. */
function fakeTransport(answers: Array<PushResponse | Error> = []) {
  const requests: PushRequest[] = [];
  const transport = vi.fn(async (request: PushRequest) => {
    requests.push(request);
    const answer = answers.shift() ?? { status: 201 };
    if (answer instanceof Error) throw answer;
    return answer;
  });
  return { transport, requests };
}

async function setup(
  options: {
    answers?: Array<PushResponse | Error>;
    activeDevices?: () => ReadonlySet<string> | undefined;
    directory?: string;
  } = {},
) {
  const directory = options.directory ?? (await tempDir());
  const { transport, requests } = fakeTransport(options.answers);
  const sleeps: number[] = [];
  const log = vi.fn();
  const push = await openPushService({
    directory,
    transport,
    subject: "mailto:owner@example.com",
    log,
    now: () => Date.parse("2026-10-10T00:00:00Z"),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...(options.activeDevices ? { activeDevices: options.activeDevices } : {}),
  });
  cleanup.push(() => push.close());
  return { push, transport, requests, sleeps, log, directory };
}

const entry = (patch: Partial<InboxEntry> = {}): InboxEntry => ({
  id: "e1",
  kind: "run_completed",
  createdAt: 1,
  title: "Morning brief finished",
  body: "Three things today.\nMore detail.",
  projectId: "home",
  sessionId: "s1",
  jobId: "j1",
  runId: "r1",
  read: false,
  ...patch,
});

describe("checkPushSubscription", () => {
  it("accepts the browsers' push services only", () => {
    const { subscription } = createTestPushSubscriber();
    for (const endpoint of [
      "https://fcm.googleapis.com/fcm/send/abc",
      "https://updates.push.services.mozilla.com/wpush/v2/abc",
      "https://web.push.apple.com/QGuQ/abc",
      "https://wns2-sy3p.notify.windows.com/w/?token=abc",
    ]) {
      expect(
        checkPushSubscription({ ...subscription, endpoint }).endpoint,
      ).toBe(endpoint);
    }
    for (const endpoint of [
      "https://evil.example.com/push",
      "http://fcm.googleapis.com/fcm/send/abc",
      "https://fcm.googleapis.com:8443/fcm/send/abc",
      "https://user:pass@fcm.googleapis.com/fcm/send/abc",
      "https://192.168.1.10/push",
      "https://push.apple.com/abc",
    ]) {
      expect(() =>
        checkPushSubscription({ ...subscription, endpoint }),
      ).toThrow(PushSubscriptionError);
    }
    expect(() =>
      checkPushSubscription({ endpoint: subscription.endpoint, keys: {} }),
    ).toThrow("push_subscription_invalid");
  });

  it("sends only to push services through the egress policy", () => {
    expect(
      networkPolicyAllows(PUSH_NETWORK_POLICY, "web.push.apple.com").allowed,
    ).toBe(true);
    expect(
      networkPolicyAllows(PUSH_NETWORK_POLICY, "fcm.googleapis.com").allowed,
    ).toBe(true);
    expect(
      networkPolicyAllows(PUSH_NETWORK_POLICY, "example.com").allowed,
    ).toBe(false);
  });
});

describe("push service", () => {
  it("keeps its VAPID keys and subscriptions across restarts", async () => {
    const first = await setup();
    const browser = createTestPushSubscriber();
    await first.push.subscribe("laptop", browser.subscription, 1);
    await first.push.close();
    const keysFile = path.join(first.directory, "vapid.json");
    expect((await fs.stat(keysFile)).mode & 0o777).toBe(0o600);

    const second = await setup({ directory: first.directory });
    expect(second.push.publicKey).toBe(first.push.publicKey);
    expect(second.push.isSubscribed("laptop")).toBe(true);
  });

  it("replaces unusable keys and drops subscriptions made with them", async () => {
    const first = await setup();
    await first.push.subscribe(
      "laptop",
      createTestPushSubscriber().subscription,
      1,
    );
    await first.push.close();
    await fs.writeFile(path.join(first.directory, "vapid.json"), "{oops");

    const second = await setup({ directory: first.directory });
    expect(second.push.publicKey).not.toBe(first.push.publicKey);
    expect(second.push.isSubscribed("laptop")).toBe(false);
  });

  it("keeps one subscription per device and removes it on request", async () => {
    const { push } = await setup();
    const phone = createTestPushSubscriber();
    await push.subscribe("phone", phone.subscription, 1);
    await push.subscribe(
      "phone",
      createTestPushSubscriber("https://web.push.apple.com/new").subscription,
      2,
    );
    expect(push.isSubscribed("phone")).toBe(true);
    // The same browser subscription moving to another device moves.
    await push.subscribe("laptop", phone.subscription, 3);
    expect(push.isSubscribed("laptop")).toBe(true);
    expect(await push.unsubscribe("phone")).toBe(true);
    expect(await push.unsubscribe("phone")).toBe(false);
    expect(push.isSubscribed("phone")).toBe(false);
    await expect(
      push.subscribe(
        "tablet",
        {
          endpoint: "https://evil.example.com/x",
          keys: phone.subscription.keys,
        },
        4,
      ),
    ).rejects.toMatchObject({ code: "push_endpoint_not_allowed" });
  });

  it("drops subscriptions of revoked devices", async () => {
    let active = new Set(["phone", "laptop"]);
    const { push, requests } = await setup({ activeDevices: () => active });
    await push.subscribe("phone", createTestPushSubscriber().subscription, 1);
    await push.subscribe(
      "laptop",
      createTestPushSubscriber("https://fcm.googleapis.com/fcm/send/l")
        .subscription,
      1,
    );
    expect(await push.retainDevices(new Set(["phone"]))).toBe(1);
    expect(push.isSubscribed("laptop")).toBe(false);

    // Revoked while the server was running: dropped before sending.
    active = new Set();
    expect(await push.notifyAll(TEST_PUSH_MESSAGE)).toEqual([]);
    expect(requests).toHaveLength(0);
    expect(push.isSubscribed("phone")).toBe(false);
  });

  it("sends an encrypted, VAPID-signed message the browser can read", async () => {
    const { push, requests } = await setup();
    const browser = createTestPushSubscriber();
    await push.subscribe("phone", browser.subscription, 1);
    const message = pushMessageForEntry(entry({ kind: "needs_approval" }));
    expect(await push.notifyAll(message)).toEqual([
      { deviceId: "phone", outcome: "sent", status: 201 },
    ]);
    const [request] = requests;
    expect(request!.url.href).toBe(browser.subscription.endpoint);
    expect(request!.headers).toMatchObject({
      "content-encoding": "aes128gcm",
      "content-type": "application/octet-stream",
      ttl: String(12 * 60 * 60),
      urgency: "high",
    });
    expect(request!.headers.authorization).toMatch(
      new RegExp(
        `^vapid t=[\\w-]+\\.[\\w-]+\\.[\\w-]+, k=${push.publicKey}$`,
        "u",
      ),
    );
    expect(browser.read(request!.body)).toEqual({
      title: "Morning brief finished",
      body: "Waiting for your approval.",
      url: "/?inboxEntry=e1&openProject=home&openSession=s1",
      tag: "run:r1",
    });
  });

  it("removes a subscription the push service says is gone", async () => {
    const { push, log } = await setup({ answers: [{ status: 410 }] });
    await push.subscribe("phone", createTestPushSubscriber().subscription, 1);
    expect(await push.notifyAll(TEST_PUSH_MESSAGE)).toEqual([
      { deviceId: "phone", outcome: "gone", status: 410 },
    ]);
    expect(push.isSubscribed("phone")).toBe(false);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("dropped"));
  });

  it("retries rate limits, server errors and network failures, then gives up", async () => {
    const retried = await setup({
      answers: [
        { status: 429, retryAfterSeconds: 3 },
        new Error("socket hang up"),
        { status: 201 },
      ],
    });
    await retried.push.subscribe(
      "phone",
      createTestPushSubscriber().subscription,
      1,
    );
    expect(await retried.push.notifyAll(TEST_PUSH_MESSAGE)).toEqual([
      { deviceId: "phone", outcome: "sent", status: 201 },
    ]);
    expect(retried.sleeps).toEqual([3_000, 10_000]);
    // Each attempt is encrypted afresh.
    expect(retried.requests[0]!.body).not.toEqual(retried.requests[2]!.body);

    const failing = await setup({
      answers: [{ status: 503 }, { status: 502 }, { status: 500 }],
    });
    await failing.push.subscribe(
      "phone",
      createTestPushSubscriber().subscription,
      1,
    );
    expect(await failing.push.notifyAll(TEST_PUSH_MESSAGE)).toEqual([
      { deviceId: "phone", outcome: "failed", status: 500 },
    ]);
    expect(failing.requests).toHaveLength(3);
    expect(failing.push.isSubscribed("phone")).toBe(true);
    expect(failing.log).toHaveBeenCalledWith(
      expect.stringContaining("refused a notification (500)"),
    );
  });

  it("does not retry a request the push service rejects", async () => {
    const { push, requests } = await setup({ answers: [{ status: 403 }] });
    await push.subscribe("phone", createTestPushSubscriber().subscription, 1);
    expect(await push.notifyAll(TEST_PUSH_MESSAGE)).toEqual([
      { deviceId: "phone", outcome: "failed", status: 403 },
    ]);
    expect(requests).toHaveLength(1);
  });
});

describe("pushMessageForEntry", () => {
  it("carries the title and a fixed description unless summaries are on", () => {
    expect(pushMessageForEntry(entry())).toEqual({
      title: "Morning brief finished",
      body: "Finished. Open the chat to see the result.",
      url: "/?inboxEntry=e1&openProject=home&openSession=s1",
      tag: "run:r1",
    });
    expect(pushMessageForEntry(entry(), { includeSummary: true }).body).toBe(
      "Three things today.",
    );
    expect(
      pushMessageForEntry(
        entry({ sessionId: undefined, runId: undefined, kind: "run_failed" }),
      ),
    ).toMatchObject({
      url: "/?inboxEntry=e1",
      tag: "e1",
      body: "Failed. Open the chat to see what happened.",
    });
  });
});

describe("push routes", () => {
  const auth = (subjectId: string, deviceId: string): AssistantServerAuth => {
    const signedIn: AssistantServerAuth = {
      principal: { tenantId: "agentlink-server", subjectId },
      session: {
        ownerId: subjectId,
        sessionId: `session-${deviceId}`,
        deviceId,
        deviceLabel: "Phone",
        createdAt: 0,
        expiresAt: Number.MAX_SAFE_INTEGER,
      },
      signal: new AbortController().signal,
      revalidate: async () => ({ valid: true }),
      detach: () => signedIn,
    };
    return signedIn;
  };

  async function serve(answers?: Array<PushResponse | Error>) {
    const context = await setup(answers ? { answers } : {});
    const routes = createPushRoutes({
      push: context.push,
      isOwner: (request) => request.principal.subjectId === "owner",
      now: () => 5,
    });
    let caller = auth("owner", "phone");
    const server = http.createServer((request, response) => {
      routes
        .handleRequest(request, response, caller)
        .then((handled) => {
          if (!handled) {
            response.writeHead(404);
            response.end("{}");
          }
        })
        .catch((error: unknown) => {
          response.writeHead(error instanceof HttpError ? error.status : 500, {
            "content-type": "application/json",
          });
          response.end(
            JSON.stringify({
              error: error instanceof HttpError ? error.code : String(error),
            }),
          );
        });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", () => resolve()),
    );
    const port = (server.address() as { port: number }).port;
    cleanup.push(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    const call = async (method: string, route: string, body?: unknown) => {
      const response = await fetch(`http://127.0.0.1:${port}${route}`, {
        method,
        headers:
          body === undefined ? {} : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return {
        status: response.status,
        body: (await response.json()) as Record<string, unknown>,
      };
    };
    return {
      ...context,
      call,
      setCaller(next: AssistantServerAuth) {
        caller = next;
      },
    };
  }

  it("turns this device on and off and sends it a test", async () => {
    const { call, push, requests } = await serve();
    const browser = createTestPushSubscriber();
    await expect(call("GET", "/api/push")).resolves.toEqual({
      status: 200,
      body: { publicKey: push.publicKey, subscribed: false },
    });
    await expect(call("POST", "/api/push/test")).resolves.toEqual({
      status: 409,
      body: { error: "push_not_subscribed" },
    });
    await expect(
      call("PUT", "/api/push/subscription", browser.subscription),
    ).resolves.toEqual({ status: 200, body: { subscribed: true } });
    await expect(call("GET", "/api/push")).resolves.toMatchObject({
      body: { subscribed: true },
    });
    await expect(call("POST", "/api/push/test")).resolves.toEqual({
      status: 200,
      body: { outcome: "sent", status: 201 },
    });
    expect(browser.read(requests[0]!.body)).toMatchObject({
      title: "AgentLink Assistant",
      body: "Notifications are working on this device.",
    });
    await expect(call("DELETE", "/api/push/subscription")).resolves.toEqual({
      status: 200,
      body: { subscribed: false },
    });
    expect(push.isSubscribed("phone")).toBe(false);
  });

  it("refuses bad subscriptions and other principals", async () => {
    const { call, setCaller } = await serve();
    await expect(
      call("PUT", "/api/push/subscription", {
        endpoint: "https://evil.example.com/x",
        keys: createTestPushSubscriber().subscription.keys,
      }),
    ).resolves.toEqual({
      status: 400,
      body: { error: "push_endpoint_not_allowed" },
    });
    await expect(
      call("PUT", "/api/push/subscription", { endpoint: 1 }),
    ).resolves.toEqual({
      status: 400,
      body: { error: "push_subscription_invalid" },
    });
    setCaller(auth("someone-else", "x"));
    await expect(call("GET", "/api/push")).resolves.toEqual({
      status: 403,
      body: { error: "push_forbidden" },
    });
  });
});
