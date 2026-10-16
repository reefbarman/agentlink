import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AssistantServerAuth } from "./assistantServer.js";
import type { BackupStatus } from "./backupAgent.js";
import { BackupRequestError, type BackupClient } from "./backupClient.js";
import { createBackupRoutes } from "./backupRoutes.js";
import { HttpError } from "./httpJson.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

const auth = (subjectId: string, valid = true): AssistantServerAuth => {
  const signedIn: AssistantServerAuth = {
    principal: { tenantId: "agentlink-server", subjectId },
    session: {
      ownerId: subjectId,
      sessionId: "s",
      deviceId: "d",
      deviceLabel: "Laptop",
      createdAt: 0,
      expiresAt: Number.MAX_SAFE_INTEGER,
    },
    signal: new AbortController().signal,
    revalidate: async () => ({ valid }),
    detach: () => signedIn,
  };
  return signedIn;
};

async function setup(client: BackupClient | undefined) {
  const finished: Array<BackupStatus | undefined> = [];
  const routes = createBackupRoutes({
    client,
    isOwner: (request) => request.principal.subjectId === "owner",
    onFinished: (status) => finished.push(status),
  });
  let caller = auth("owner");
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
  const call = async (method: string) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/backups`, {
      method,
    });
    return { status: response.status, body: await response.json() };
  };
  return {
    call,
    finished,
    as: (next: AssistantServerAuth) => {
      caller = next;
    },
  };
}

const STATUS: BackupStatus = {
  lastSuccess: {
    at: 1,
    durationMs: 1,
    snapshotId: "abc",
    files: 1,
    bytes: 1,
    added: 1,
  },
};

const fakeClient = (overrides: Partial<BackupClient> = {}): BackupClient => ({
  health: async () => ({ protocol: 1 }),
  status: async () => STATUS,
  backupNow: async () => STATUS,
  snapshots: async () => [],
  ...overrides,
});

describe("backup routes", () => {
  it("is the owner's alone", async () => {
    const { call, as } = await setup(fakeClient());
    as(auth("guest"));
    await expect(call("GET")).resolves.toMatchObject({
      status: 403,
      body: { error: "backups_forbidden" },
    });
  });

  it("says when backups are not configured", async () => {
    const { call } = await setup(undefined);
    await expect(call("GET")).resolves.toEqual({
      status: 200,
      body: { configured: false },
    });
    await expect(call("POST")).resolves.toMatchObject({ status: 409 });
  });

  it("returns the sidecar's status, or why it is unavailable", async () => {
    const { call } = await setup(fakeClient());
    await expect(call("GET")).resolves.toMatchObject({
      status: 200,
      body: { configured: true, status: STATUS },
    });
    const down = await setup(
      fakeClient({
        status: async () => {
          throw new BackupRequestError(503, "backup_unavailable");
        },
      }),
    );
    await expect(down.call("GET")).resolves.toMatchObject({
      status: 200,
      body: { configured: true, error: "backup_unavailable" },
    });
  });

  it("starts a backup in the background", async () => {
    const backupNow = vi.fn(async () => STATUS);
    const { call, finished } = await setup(fakeClient({ backupNow }));
    await expect(call("POST")).resolves.toEqual({
      status: 202,
      body: { started: true },
    });
    await vi.waitFor(() => expect(finished).toEqual([STATUS]));
    expect(backupNow).toHaveBeenCalledTimes(1);
  });

  it("re-checks the sign-in before starting one", async () => {
    const backupNow = vi.fn(async () => STATUS);
    const { call, as } = await setup(fakeClient({ backupNow }));
    as(auth("owner", false));
    await expect(call("POST")).resolves.toMatchObject({ status: 401 });
    expect(backupNow).not.toHaveBeenCalled();
  });
});
