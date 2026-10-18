import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import type { AssistantServerAuth } from "./assistantServer.js";
import { HttpError } from "./httpJson.js";
import {
  onboardingFeatures,
  onboardingStatus,
  openOnboardingStore,
  type OnboardingFacts,
} from "./onboarding.js";
import { createOnboardingRoutes } from "./onboardingRoutes.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

function testAuth(
  subjectId: string,
  options: { sessionId?: string; valid?: () => boolean } = {},
): AssistantServerAuth {
  const signedIn: AssistantServerAuth = {
    principal: { tenantId: "agentlink-server", subjectId },
    session: {
      ownerId: subjectId,
      sessionId: options.sessionId ?? "s",
      deviceId: "d",
      deviceLabel: "Laptop",
      createdAt: 0,
      expiresAt: Number.MAX_SAFE_INTEGER,
    },
    signal: new AbortController().signal,
    revalidate: async () => ({ valid: options.valid?.() ?? true }),
    detach: () => signedIn,
  };
  return signedIn;
}

const READY: OnboardingFacts = {
  model: { codexAvailable: true, codexSignedIn: true, otherProviders: 0 },
  backup: { configured: true, lastSuccessAt: 10, failing: false },
};

async function setup(initial?: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "onboarding-routes-"));
  cleanup.push(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "settings", "onboarding.json");
  if (initial !== undefined) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, initial);
  }
  const store = await openOnboardingStore({ file });
  let facts = READY;
  let caller = testAuth("owner");
  const routes = createOnboardingRoutes({
    store,
    facts: async () => facts,
    isOwner: (request) => request.principal.subjectId === "owner",
    now: () => 42,
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
  const call = async (method: string, body?: unknown, suffix = "") => {
    const response = await fetch(
      `http://127.0.0.1:${port}/api/onboarding${suffix}`,
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
    return { status: response.status, body: await response.json() };
  };
  return {
    file,
    call,
    setFacts: (next: OnboardingFacts) => (facts = next),
    setCaller: (next: AssistantServerAuth) => (caller = next),
  };
}

const FRESH =
  '{"schemaVersion": 1, "revision": 0, "freshInstall": true, "steps": {}}\n';

describe("onboarding routes", () => {
  it("opens setup for the installer's fresh-install marker until it is finished", async () => {
    const t = await setup(FRESH);
    const first = await t.call("GET");
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      openSetup: true,
      status: "setup-incomplete",
      record: { revision: 0, freshInstall: true },
    });
    const step = await t.call("PATCH", {
      expectedRevision: 0,
      step: { id: "model", state: "done" },
    });
    expect(step.body.record.steps.model).toEqual({ state: "done", at: 42 });
    const done = await t.call("PATCH", {
      expectedRevision: 1,
      backupPasswordSaved: true,
      complete: true,
    });
    expect(done.body).toMatchObject({ openSetup: false, status: "ready" });
    // Persisted privately, with no credentials or sign-in material.
    const saved = await fs.readFile(t.file, "utf8");
    expect(JSON.parse(saved)).toMatchObject({
      revision: 2,
      completedAt: 42,
      backupPasswordSavedAt: 42,
    });
    expect((await fs.stat(t.file)).mode & 0o777).toBe(0o600);
    // Reopened after a restart.
    const reopened = await openOnboardingStore({ file: t.file });
    expect(reopened.get()?.completedAt).toBe(42);
  });

  it("does not open setup for an existing installation without a record", async () => {
    const t = await setup();
    const result = await t.call("GET");
    expect(result.body).toMatchObject({ record: null, openSetup: false });
    // Reviewing setup still works and creates the record.
    const step = await t.call("PATCH", {
      expectedRevision: 0,
      step: { id: "connections", state: "deferred" },
    });
    expect(step.body.record).toMatchObject({
      freshInstall: false,
      revision: 1,
    });
  });

  it("refuses a change from a stale tab, other users and revoked sessions", async () => {
    const t = await setup(FRESH);
    await t.call("PATCH", { expectedRevision: 0, dismiss: true });
    const stale = await t.call("PATCH", {
      expectedRevision: 0,
      complete: true,
    });
    expect(stale).toMatchObject({
      status: 409,
      body: { error: "onboarding_changed" },
    });
    t.setCaller(testAuth("someone-else"));
    expect((await t.call("GET")).status).toBe(403);
    t.setCaller(testAuth("owner", { valid: () => false }));
    const revoked = await t.call("PATCH", {
      expectedRevision: 1,
      complete: true,
    });
    expect(revoked.status).toBe(401);
    expect(JSON.parse(await fs.readFile(t.file, "utf8")).completedAt).toBe(
      undefined,
    );
  });

  it("rejects malformed changes and query strings", async () => {
    const t = await setup(FRESH);
    for (const body of [
      { complete: true },
      { expectedRevision: 0 },
      { expectedRevision: 0, step: { id: "billing", state: "done" } },
      { expectedRevision: 0, complete: false },
      { expectedRevision: 0, token: "x" },
    ]) {
      expect((await t.call("PATCH", body)).status).toBe(400);
    }
    expect((await t.call("GET", undefined, "?x=1")).status).toBe(400);
  });

  it("refuses to start over a corrupt setup file", async () => {
    await expect(setup("{not json")).rejects.toThrow();
  });
});

describe("onboarding status", () => {
  const record = {
    schemaVersion: 1 as const,
    revision: 3,
    freshInstall: true,
    steps: {},
    completedAt: 5,
  };
  it("puts model access first, then backups, whatever the checklist says", () => {
    expect(
      onboardingStatus(record, {
        ...READY,
        model: {
          codexAvailable: true,
          codexSignedIn: false,
          otherProviders: 0,
        },
      }),
    ).toBe("setup-incomplete");
    // A saved OpenAI key is model access (saved, not verified upstream).
    expect(
      onboardingStatus(record, {
        ...READY,
        model: {
          codexAvailable: true,
          codexSignedIn: false,
          otherProviders: 0,
          openAiKeyAvailable: true,
          openAiKeySaved: true,
        },
      }),
    ).toBe("ready");
    expect(
      onboardingStatus(record, {
        ...READY,
        backup: { configured: true, failing: true, lastSuccessAt: 1 },
      }),
    ).toBe("backup-degraded");
    expect(
      onboardingStatus(record, { ...READY, backup: { configured: true } }),
    ).toBe("backup-degraded");
    expect(onboardingStatus(record, READY)).toBe("ready");
    expect(
      onboardingStatus(
        { ...record, completedAt: undefined },
        {
          model: {
            codexAvailable: false,
            codexSignedIn: false,
            otherProviders: 1,
          },
          backup: { configured: false },
        },
      ),
    ).toBe("setup-incomplete");
  });
});

describe("optional feature status", () => {
  it("reports features from the started configuration, needing runners first", () => {
    expect(onboardingFeatures({})).toEqual({
      editor: "needs-runners",
      browser: "needs-runners",
    });
    expect(onboardingFeatures({ runners: {} })).toEqual({
      editor: "off",
      browser: "off",
    });
    expect(
      onboardingFeatures({ runners: {}, editor: { port: 8444 }, browser: {} }),
    ).toEqual({ editor: "on", browser: "on" });
  });
});
