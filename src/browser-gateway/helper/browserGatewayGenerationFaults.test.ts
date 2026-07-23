import * as fs from "fs/promises";
import * as http from "http";
import * as os from "os";
import * as path from "path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { BrowserGatewayAskAgentHistoryStore } from "../browserGatewayAskAgentHistory.js";
import { BrowserGatewayAskAgentMemoryStore } from "../browserGatewayAskAgentMemory.js";
import { BrowserGatewayAskAgentPreferencesStore } from "../browserGatewayAskAgentPreferences.js";
import type {
  BrowserGatewayCoreOwnerLeaseRegistration,
  BrowserGatewayCoreOwnersListResponse,
  BrowserGatewayHelperHealthResponse,
} from "../protocol.js";
import { createDeferred } from "../testing/SseFaultPeer.js";
import { BrowserGatewayHelperLeaseClient } from "./BrowserGatewayHelperLeaseClient.js";
import {
  BrowserGatewayHelper,
  type HelperRuntimeOptions,
} from "./browserGatewayHelper.js";

interface HelperFixture {
  readonly helper: BrowserGatewayHelper;
  readonly server: http.Server;
  readonly url: string;
  readonly secret: string;
  readonly storeDir: string;
  closeAbruptly(): Promise<void>;
}

const fixtures: HelperFixture[] = [];
const clients: BrowserGatewayHelperLeaseClient[] = [];
const originalFetch = globalThis.fetch;

function ownerRegistration(
  ownerGenerationId: string,
): BrowserGatewayCoreOwnerLeaseRegistration {
  return {
    ownerId: "owner-1",
    ownerKind: "vscode",
    displayName: "VS Code — Fault Harness",
    scope: {
      kind: "workspace",
      workspaceId: "workspace-1",
      displayName: "Fault Harness",
    },
    ownerGenerationId,
    instanceId: "instance-1",
    processId: process.pid,
  };
}

async function createHelperFixture(): Promise<HelperFixture> {
  const storeDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "agentlink-helper-generation-faults-"),
  );
  const server = http.createServer();
  const options: HelperRuntimeOptions = {
    port: 0,
    helperVersion: "generation-fault-test",
    idleShutdownMs: 120_000,
    extensionRootPath: storeDir,
    askAgentLogPath: path.join(storeDir, "ask-agent.jsonl"),
  };
  const helper = new BrowserGatewayHelper(options, server, {
    askAgentPreferencesStore: new BrowserGatewayAskAgentPreferencesStore({
      filePath: path.join(storeDir, "preferences.json"),
    }),
    askAgentHistoryStore: new BrowserGatewayAskAgentHistoryStore({
      filePath: path.join(storeDir, "history.json"),
    }),
    askAgentMemoryStore: new BrowserGatewayAskAgentMemoryStore({
      filePath: path.join(storeDir, "memory.json"),
    }),
  });

  Object.assign(helper, { writeDiscovery: async () => undefined });
  server.on("request", helper.handleRequest);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("helper_fixture_missing_tcp_address");
  }

  let closed = false;
  const fixture: HelperFixture = {
    helper,
    server,
    url: `http://127.0.0.1:${address.port}`,
    secret: helper.getClientSharedSecret(),
    storeDir,
    async closeAbruptly(): Promise<void> {
      if (closed) return;
      closed = true;
      await helper.dispose();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    },
  };
  fixtures.push(fixture);
  return fixture;
}

function createLeaseClient(
  fixture: HelperFixture,
  ownerGenerationId: string,
  clientId = `client-${ownerGenerationId}`,
): BrowserGatewayHelperLeaseClient {
  const client = new BrowserGatewayHelperLeaseClient({
    helperUrl: fixture.url,
    clientId,
    clientSharedSecret: fixture.secret,
    coreOwner: ownerRegistration(ownerGenerationId),
    log: vi.fn(),
    renewIntervalMs: 60_000,
    leaseTtlMs: 15_000,
  });
  clients.push(client);
  return client;
}

async function getHealth(
  fixture: HelperFixture,
): Promise<BrowserGatewayHelperHealthResponse> {
  const response = await fetch(`${fixture.url}/health`);
  expect(response.ok).toBe(true);
  return (await response.json()) as BrowserGatewayHelperHealthResponse;
}

async function getOwners(
  fixture: HelperFixture,
): Promise<BrowserGatewayCoreOwnersListResponse> {
  const response = await fetch(`${fixture.url}/internal/core-owners`, {
    headers: { Authorization: `Bearer ${fixture.secret}` },
  });
  expect(response.ok).toBe(true);
  return (await response.json()) as BrowserGatewayCoreOwnersListResponse;
}

async function expectCurrentOwner(
  fixture: HelperFixture,
  ownerGenerationId: string,
): Promise<void> {
  const owners = await getOwners(fixture);
  expect(owners.owners).toHaveLength(1);
  expect(owners.owners[0]).toMatchObject({
    owner: { ownerId: "owner-1" },
    ownerGenerationId,
    status: "connected",
  });
}

afterEach(async () => {
  globalThis.fetch = originalFetch;
  while (clients.length > 0) {
    await clients.pop()!.stop();
  }
  while (fixtures.length > 0) {
    const fixture = fixtures.pop()!;
    await fixture.closeAbruptly();
    await fs.rm(fixture.storeDir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

describe("browser gateway helper generation fault injection", () => {
  it("re-registers an owner after an abrupt helper-generation restart", async () => {
    const firstHelper = await createHelperFixture();
    const firstHealth = await getHealth(firstHelper);
    const firstClient = createLeaseClient(firstHelper, "owner-generation-1");
    await firstClient.start();
    await expectCurrentOwner(firstHelper, "owner-generation-1");

    await firstHelper.closeAbruptly();

    const secondHelper = await createHelperFixture();
    const secondHealth = await getHealth(secondHelper);
    expect(secondHealth.helperGenerationId).not.toBe(
      firstHealth.helperGenerationId,
    );

    const secondClient = createLeaseClient(secondHelper, "owner-generation-1");
    await secondClient.start();
    await expectCurrentOwner(secondHelper, "owner-generation-1");

    const staleGenerationResponse = await fetch(
      `${secondHelper.url}/internal/model-auth/leases`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${secondHelper.secret}`,
        },
        body: JSON.stringify({
          providerId: "openai-codex",
          method: "oauth",
          grantedByOwnerId: "owner-1",
          grantedToOwnerId: "owner-1",
          grantedToOwnerGenerationId: "owner-generation-1",
          modelScopes: ["chat"],
          helperGenerationId: firstHealth.helperGenerationId,
        }),
      },
    );
    expect(staleGenerationResponse.status).toBe(409);
  });

  it("keeps a replacement owner connected when the stale client releases", async () => {
    const fixture = await createHelperFixture();
    const firstClient = createLeaseClient(fixture, "owner-generation-1");
    await firstClient.start();
    await expectCurrentOwner(fixture, "owner-generation-1");

    const secondClient = createLeaseClient(fixture, "owner-generation-2");
    await secondClient.start();
    await expectCurrentOwner(fixture, "owner-generation-2");

    await firstClient.stop();

    await expectCurrentOwner(fixture, "owner-generation-2");
  });

  it("does not let a stopped in-flight renewal reclaim a replaced owner", async () => {
    const fixture = await createHelperFixture();
    const firstClient = createLeaseClient(fixture, "owner-generation-1");
    await firstClient.start();

    const leaseEntered = createDeferred<void>();
    const releaseLease = createDeferred<void>();
    globalThis.fetch = (async (input, init) => {
      const requestUrl = new URL(String(input));
      const body = typeof init?.body === "string" ? init.body : "";
      const response = await originalFetch(input, init);
      if (
        requestUrl.pathname === "/internal/client/lease" &&
        body.includes('"clientId":"client-owner-generation-1"')
      ) {
        leaseEntered.resolve();
        await releaseLease.promise;
      }
      return response;
    }) as typeof fetch;

    const staleRenewal = (
      firstClient as unknown as { renewLease(): Promise<void> }
    ).renewLease();
    await leaseEntered.promise;
    await firstClient.stop();

    const secondClient = createLeaseClient(fixture, "owner-generation-2");
    await secondClient.start();
    await expectCurrentOwner(fixture, "owner-generation-2");

    releaseLease.resolve();
    await staleRenewal;

    await expectCurrentOwner(fixture, "owner-generation-2");
  });

  it("does not install a renewal timer when start is stopped in flight", async () => {
    const fixture = await createHelperFixture();
    const client = createLeaseClient(fixture, "owner-generation-1");
    const leaseEntered = createDeferred<void>();
    const releaseLease = createDeferred<void>();
    globalThis.fetch = (async (input, init) => {
      const requestUrl = new URL(String(input));
      if (requestUrl.pathname === "/internal/client/lease") {
        leaseEntered.resolve();
        await releaseLease.promise;
      }
      return originalFetch(input, init);
    }) as typeof fetch;

    const start = client.start();
    await leaseEntered.promise;
    await client.stop();
    releaseLease.resolve();
    await start;

    expect(
      (client as unknown as { timer: NodeJS.Timeout | undefined }).timer,
    ).toBeUndefined();
    expect((await getOwners(fixture)).owners).toEqual([]);
  });
});
