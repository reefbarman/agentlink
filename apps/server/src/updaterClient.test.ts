import {
  UpdaterRequestError,
  createUpdaterClient,
  validateUpdateBody,
} from "./updaterClient.js";
import { describe, expect, it, vi } from "vitest";

const STATUS = {
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

describe("updater client", () => {
  it("forwards the complete version, expected version and confirmation tuple to fixed endpoints", async () => {
    const request = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify({ status: STATUS })),
    );
    const token = vi.fn(async () => "fixed-secret");
    const client = createUpdaterClient({
      host: "updater",
      port: 7900,
      token,
      fetch: request,
    });
    const confirmation = {
      version: "3.14.15",
      expectedInstalledVersion: "2.6.53",
      confirmed: true as const,
    };
    expect(await client.apply(confirmation)).toEqual(STATUS);
    await client.rollback(confirmation);
    await client.preferences({ automaticChecks: false, includePreviews: true });
    await client.check();
    await client.status();
    expect(request.mock.calls.map(([url]) => url)).toEqual([
      "http://updater:7900/v1/updates/apply",
      "http://updater:7900/v1/updates/rollback",
      "http://updater:7900/v1/updates/preferences",
      "http://updater:7900/v1/updates/check",
      "http://updater:7900/v1/updates",
    ]);
    for (const index of [0, 1])
      expect(request.mock.calls[index]?.[1]).toMatchObject({
        method: "POST",
        headers: { authorization: "Bearer fixed-secret" },
        body: JSON.stringify(confirmation),
        redirect: "error",
      });
    expect(token).toHaveBeenCalledTimes(5);
  });

  it("sanitises transport errors and service failures", async () => {
    const offline = createUpdaterClient({
      host: "updater",
      port: 7900,
      token: "secret",
      fetch: async () => {
        throw new Error("secret private path");
      },
    });
    await expect(offline.status()).rejects.toEqual(
      new UpdaterRequestError(503, "update_unavailable"),
    );
    const denied = createUpdaterClient({
      host: "updater",
      port: 7900,
      token: "secret",
      fetch: async () =>
        new Response(
          JSON.stringify({ error: "update_operation_active", detail: "token" }),
          { status: 409 },
        ),
    });
    await expect(
      denied.apply({
        version: "2.0.0",
        expectedInstalledVersion: "1.0.0",
        confirmed: true,
      }),
    ).rejects.toEqual(new UpdaterRequestError(409, "update_operation_active"));
  });

  it("rejects unbounded response bodies and malformed endpoint configuration", async () => {
    const client = createUpdaterClient({
      host: "updater",
      port: 7900,
      token: "secret",
      fetch: async () => new Response("a".repeat(512 * 1024 + 1)),
    });
    await expect(client.status()).rejects.toThrow("update_unavailable");
    expect(() =>
      createUpdaterClient({ host: "host/path", port: 7900, token: "secret" }),
    ).toThrow("updater_address_invalid");
  });
});

it("rejects unknown fields and exact-type violations", () => {
  for (const body of [
    { path: "/etc" },
    { automaticChecks: 1, includePreviews: false },
    { automaticChecks: true },
    { automaticChecks: true, includePreviews: false, command: "shell" },
  ]) {
    expect(() => validateUpdateBody("preferences", body)).toThrow();
  }
  expect(() => validateUpdateBody("check", { url: "https://evil" })).toThrow();
  expect(() =>
    validateUpdateBody("apply", {
      version: "latest",
      expectedInstalledVersion: "1.0.0",
      confirmed: true,
    }),
  ).toThrow();
});
