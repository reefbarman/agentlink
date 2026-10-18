import { afterEach, describe, expect, it } from "vitest";
import {
  CodexOAuthFlowError,
  type CodexCredentials,
  type CodexOAuthAccountInfo,
} from "@agentlink/node-host";
import http from "node:http";

import type { AssistantServerAuth } from "./assistantServer.js";
import { HttpError } from "./httpJson.js";
import {
  CODEX_SIGN_IN_TTL_MS,
  createProviderRoutes,
  type CodexSignInRuntime,
} from "./providerRoutes.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

function auth(
  subjectId: string,
  sessionId: string,
  valid: () => boolean = () => true,
): AssistantServerAuth {
  const signedIn: AssistantServerAuth = {
    principal: { tenantId: "agentlink-server", subjectId },
    session: {
      ownerId: subjectId,
      sessionId,
      deviceId: `device-${sessionId}`,
      deviceLabel: `Device ${sessionId}`,
      createdAt: 0,
      expiresAt: Number.MAX_SAFE_INTEGER,
    },
    signal: new AbortController().signal,
    revalidate: async () => ({ valid: valid() }),
    detach: () => signedIn,
  };
  return signedIn;
}

const CALLBACK =
  "http://localhost:1455/auth/callback?code=SECRET-CODE&state=STATE";

/** A runtime with the real flow's shape: one pending flow, state-checked. */
function fakeRuntime() {
  const accounts: CodexOAuthAccountInfo[] = [];
  const events: string[] = [];
  let pending = false;
  let fail: Error | undefined;
  const runtime: CodexSignInRuntime = {
    ready: async () => undefined,
    manager: {
      startAuthorizationFlow() {
        events.push("start");
        pending = true;
        return "https://auth.openai.com/oauth/authorize?state=STATE";
      },
      cancelAuthorizationFlow() {
        events.push("cancel");
        pending = false;
      },
      async completeAuthorizationFromRedirect(redirectUrl) {
        events.push("complete");
        if (!pending) throw new Error("No pending authorization flow");
        pending = false;
        if (fail) throw fail;
        if (!redirectUrl.startsWith("http://localhost:1455/auth/callback")) {
          throw new CodexOAuthFlowError("bad", "missing_code");
        }
        return { accessToken: "token" } as unknown as CodexCredentials;
      },
      async saveOAuthAccount(_credentials, options) {
        // As the real manager: checked under the lock, before writing.
        await options?.beforeCommit?.();
        events.push("save");
        accounts.push({
          id: "a",
          label: "owner@example.com",
          isActive: true,
          createdAt: 0,
          updatedAt: 0,
        });
        return {};
      },
      listAccounts: async () => accounts,
    },
  };
  return { runtime, events, setFail: (error?: Error) => (fail = error) };
}

async function setup(runtime: CodexSignInRuntime | undefined) {
  let clock = 1_000;
  let caller = auth("owner", "phone");
  const logs: string[] = [];
  let signedIn = 0;
  const routes = createProviderRoutes({
    codex: runtime,
    isOwner: (request) => request.principal.subjectId === "owner",
    now: () => clock,
    onSignedIn: () => (signedIn += 1),
    log: (line) => logs.push(line),
  });
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
  const call = async (method: string, suffix = "", body?: unknown) => {
    const response = await fetch(
      `http://127.0.0.1:${port}/api/providers/codex${suffix}`,
      {
        method,
        ...(body === undefined
          ? {}
          : {
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            }),
      },
    );
    const text = await response.text();
    return { status: response.status, body: JSON.parse(text), text };
  };
  return {
    call,
    logs,
    signedIn: () => signedIn,
    as: (next: AssistantServerAuth) => (caller = next),
    advance: (ms: number) => (clock += ms),
  };
}

describe("Codex sign-in routes", () => {
  it("signs in from a pasted callback address and saves the account", async () => {
    const fake = fakeRuntime();
    const t = await setup(fake.runtime);
    expect((await t.call("GET")).body).toEqual({
      available: true,
      accounts: [],
      pending: null,
    });
    const started = await t.call("POST", "/sign-in", {});
    expect(started.status).toBe(200);
    expect(started.body.authorizeUrl).toMatch(/^https:\/\/auth\.openai\.com\//);
    expect((await t.call("GET")).body.pending).toMatchObject({ mine: true });
    const done = await t.call("POST", "/sign-in/complete", {
      redirectUrl: CALLBACK,
    });
    expect(done.status).toBe(200);
    expect(done.body).toEqual({
      available: true,
      accounts: [{ label: "owner@example.com", active: true }],
      pending: null,
    });
    // Nothing secret comes back or is logged.
    expect(done.text).not.toContain("SECRET-CODE");
    expect(t.logs.join("\n")).not.toContain("SECRET-CODE");
    expect(fake.events).toEqual(["start", "complete", "save"]);
    expect(t.signedIn()).toBe(1);
    // The same address cannot be replayed.
    const replay = await t.call("POST", "/sign-in/complete", {
      redirectUrl: CALLBACK,
    });
    expect(replay).toMatchObject({
      status: 409,
      body: { error: "codex_sign_in_not_pending" },
    });
  });

  it("keeps another device's waiting sign-in instead of cancelling it", async () => {
    const fake = fakeRuntime();
    const t = await setup(fake.runtime);
    await t.call("POST", "/sign-in", {});
    t.as(auth("owner", "laptop"));
    const other = await t.call("GET");
    expect(other.body.pending).toMatchObject({
      mine: false,
      deviceLabel: "Device phone",
    });
    for (const [method, suffix, body] of [
      ["POST", "/sign-in", {}],
      ["DELETE", "/sign-in", undefined],
      ["POST", "/sign-in/complete", { redirectUrl: CALLBACK }],
    ] as const) {
      const result = await t.call(method, suffix, body);
      expect(result).toMatchObject({
        status: 409,
        body: { error: "codex_sign_in_pending_elsewhere" },
      });
    }
    expect(fake.events).toEqual(["start"]);
    // Once it expires, another device can start its own.
    t.advance(CODEX_SIGN_IN_TTL_MS);
    expect((await t.call("POST", "/sign-in", {})).status).toBe(200);
    expect(fake.events).toEqual(["start", "cancel", "start"]);
  });

  it("does not save credentials when the device is revoked during the exchange", async () => {
    const fake = fakeRuntime();
    const t = await setup(fake.runtime);
    await t.call("POST", "/sign-in", {});
    let checks = 0;
    // Valid when the request arrives, revoked after the exchange.
    t.as(auth("owner", "phone", () => (checks += 1) < 2));
    const result = await t.call("POST", "/sign-in/complete", {
      redirectUrl: CALLBACK,
    });
    expect(result.status).toBe(401);
    expect(fake.events).not.toContain("save");
  });

  it("maps flow failures to bounded codes and ends the attempt", async () => {
    const fake = fakeRuntime();
    const t = await setup(fake.runtime);
    await t.call("POST", "/sign-in", {});
    const wrong = await t.call("POST", "/sign-in/complete", {
      redirectUrl: "https://evil.example/?code=x",
    });
    expect(wrong).toMatchObject({
      status: 400,
      body: { error: "codex_sign_in_address_invalid" },
    });
    await t.call("POST", "/sign-in", {});
    fake.setFail(new Error("network detail with SECRET-CODE"));
    const failed = await t.call("POST", "/sign-in/complete", {
      redirectUrl: CALLBACK,
    });
    expect(failed).toMatchObject({
      status: 502,
      body: { error: "codex_sign_in_failed" },
    });
    expect(failed.text).not.toContain("SECRET-CODE");
    expect(t.logs.join("\n")).not.toContain("SECRET-CODE");
    for (const body of [
      {},
      { redirectUrl: "" },
      { redirectUrl: CALLBACK, extra: 1 },
      { redirectUrl: `${CALLBACK}${"x".repeat(5_000)}` },
    ]) {
      expect((await t.call("POST", "/sign-in/complete", body)).status).toBe(
        400,
      );
    }
  });

  it("cancels only this device's own sign-in", async () => {
    const fake = fakeRuntime();
    const t = await setup(fake.runtime);
    await t.call("POST", "/sign-in", {});
    const cancelled = await t.call("DELETE", "/sign-in");
    expect(cancelled.body.pending).toBe(null);
    expect(fake.events).toEqual(["start", "cancel"]);
  });

  it("reports operator-managed servers and refuses sign-in without a ChatGPT provider", async () => {
    const t = await setup(undefined);
    expect((await t.call("GET")).body).toEqual({
      available: false,
      accounts: [],
      pending: null,
    });
    expect(await t.call("POST", "/sign-in", {})).toMatchObject({
      status: 409,
      body: { error: "codex_unavailable" },
    });
  });

  it("is owner-only", async () => {
    const t = await setup(fakeRuntime().runtime);
    t.as(auth("someone-else", "x"));
    expect((await t.call("GET")).status).toBe(403);
    expect((await t.call("POST", "/sign-in", {})).status).toBe(403);
  });
});
