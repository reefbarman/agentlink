import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AssistantUpdateStatus } from "../../../src/shared/assistantUpdates.js";
import type { AssistantServerAuth } from "./assistantServer.js";
import { HttpError, sendJson } from "./httpJson.js";
import { createUpdateRoutes } from "./updateRoutes.js";
import { createUpdaterClient, type UpdaterClient } from "./updaterClient.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const STATUS: AssistantUpdateStatus = {
  configured: true,
  managed: false,
  installedVersion: null,
  installedCommit: null,
  updaterProtocol: 1,
  canRollback: false,
  rollbackVersion: null,
  operation: null,
  discovery: {
    status: "unsupported",
    automaticChecks: true,
    includePreviews: false,
    checkedAt: null,
    lastAttemptAt: null,
    retryAt: null,
    stale: false,
    releases: [],
  },
};
async function setup(client: UpdaterClient | undefined) {
  let owner = true;
  const revalidate = vi.fn(async () => ({ valid: true }));
  const auth = {
    principal: { subjectId: "owner", tenantId: "server" },
    signal: new AbortController().signal,
    revalidate,
  } as unknown as AssistantServerAuth;
  const routes = createUpdateRoutes({ client, isOwner: () => owner });
  const server = http.createServer((request, response) => {
    void routes
      .handleRequest(request, response, auth)
      .then((handled) => {
        if (!handled) sendJson(response, 404, {});
      })
      .catch((error: unknown) => {
        sendJson(response, error instanceof HttpError ? error.status : 500, {
          error: error instanceof HttpError ? error.code : "unexpected",
        });
      });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const call = async (
    action = "",
    body?: unknown,
    method = action ? "POST" : "GET",
  ) => {
    const response = await fetch(
      `http://127.0.0.1:${(server.address() as { port: number }).port}/api/updates${action}`,
      {
        method,
        headers: { "content-type": "application/json" },
        ...(method === "POST" ? { body: JSON.stringify(body ?? {}) } : {}),
      },
    );
    return {
      status: response.status,
      body: (await response.json()) as unknown,
    };
  };
  return {
    call,
    revalidate,
    asGuest: () => {
      owner = false;
    },
  };
}
const fakeClient = (): UpdaterClient => ({
  status: vi.fn(async () => STATUS),
  check: vi.fn(async () => STATUS),
  preferences: vi.fn(async () => STATUS),
  apply: vi.fn(async () => STATUS),
  rollback: vi.fn(async () => STATUS),
});

describe("owner update routes", () => {
  it("checks ownership for reads and writes and revalidates unsafe requests", async () => {
    const client = fakeClient();
    const guest = await setup(client);
    guest.asGuest();
    expect((await guest.call()).status).toBe(403);
    expect((await guest.call("/apply", {})).status).toBe(403);
    expect(client.status).not.toHaveBeenCalled();
    const owner = await setup(client);
    owner.revalidate.mockResolvedValue({ valid: false });
    expect((await owner.call("/check")).status).toBe(401);
    expect(client.check).not.toHaveBeenCalled();
  });

  it("revalidates again after reading the request body", async () => {
    const client = fakeClient();
    const { call, revalidate } = await setup(client);
    revalidate
      .mockResolvedValueOnce({ valid: true })
      .mockResolvedValueOnce({ valid: false });
    expect((await call("/check")).status).toBe(401);
    expect(client.check).not.toHaveBeenCalled();
  });

  it("rejects extra fields and never exposes a generic proxy", async () => {
    const client = fakeClient();
    const { call } = await setup(client);
    expect(
      (
        await call("/apply", {
          version: "2.0.0",
          expectedInstalledVersion: "1.0.0",
          confirmed: true,
          image: "bad",
        })
      ).status,
    ).toBe(400);
    expect((await call("/check", { fetchURL: "http://internal" })).status).toBe(
      400,
    );
    expect((await call("/proxy", {})).status).toBe(404);
    expect((await call("/check", undefined, "GET")).status).toBe(405);
    expect(client.apply).not.toHaveBeenCalled();
  });

  it("reports absent configuration and unavailable updater without raw logs", async () => {
    const unconfigured = await setup(undefined);
    expect(await unconfigured.call()).toEqual({
      status: 200,
      body: { configured: false },
    });
    expect((await unconfigured.call("/check")).status).toBe(409);
    const client = fakeClient();
    vi.mocked(client.status).mockRejectedValue(new Error("token /private"));
    const offline = await setup(client);
    expect(await offline.call()).toEqual({
      status: 200,
      body: { configured: true, error: "update_unavailable" },
    });
  });

  it("forwards distinctive confirmation data across route and production client composition", async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    const client = createUpdaterClient({
      host: "updater",
      port: 7900,
      token: "secret",
      fetch: async (url, init) => {
        requests.push({
          url: String(url),
          body: JSON.parse(String(init?.body)) as unknown,
        });
        return new Response(JSON.stringify({ status: STATUS }));
      },
    });
    const { call, revalidate } = await setup(client);
    const confirmation = {
      version: "4.12.99",
      expectedInstalledVersion: "3.7.42",
      confirmed: true,
    };
    expect((await call("/apply", confirmation)).status).toBe(202);
    expect((await call("/rollback", confirmation)).status).toBe(202);
    const preferences = { automaticChecks: false, includePreviews: true };
    expect((await call("/preferences", preferences)).status).toBe(200);
    expect(requests).toEqual([
      { url: "http://updater:7900/v1/updates/apply", body: confirmation },
      { url: "http://updater:7900/v1/updates/rollback", body: confirmation },
      { url: "http://updater:7900/v1/updates/preferences", body: preferences },
    ]);
    expect(revalidate).toHaveBeenCalledTimes(6);
  });
});
