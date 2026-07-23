/** @vitest-environment node */

import * as fs from "fs/promises";
import * as http from "http";
import * as net from "net";
import * as os from "os";
import * as path from "path";

import { afterEach, describe, expect, it } from "vitest";

import { BrowserGatewayAskAgentHistoryStore } from "../browserGatewayAskAgentHistory.js";
import { BrowserGatewayAskAgentMemoryStore } from "../browserGatewayAskAgentMemory.js";
import { BrowserGatewayAskAgentPreferencesStore } from "../browserGatewayAskAgentPreferences.js";
import {
  clearBrowserGatewayHelperDiscovery,
  readBrowserGatewayHelperDiscovery,
  writeBrowserGatewayHelperDiscovery,
} from "../browserGatewayHelperDiscovery.js";
import type { BrowserGatewayHelperDiscoveryRecord } from "../protocol.js";
import {
  BrowserGatewayHelper,
  type HelperRuntimeOptions,
} from "./browserGatewayHelper.js";

type HelperFixture = {
  helper: BrowserGatewayHelper;
  server: http.Server;
  storeDir: string;
};

const fixtures: HelperFixture[] = [];

async function createHelperFixture(
  overrides: Partial<HelperRuntimeOptions> = {},
): Promise<HelperFixture> {
  const storeDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "agentlink-helper-lifecycle-"),
  );
  const server = http.createServer();
  const helper = new BrowserGatewayHelper(
    {
      port: 0,
      helperVersion: "lifecycle-test",
      idleShutdownMs: 120_000,
      shutdownTimeoutMs: 50,
      extensionRootPath: storeDir,
      askAgentLogPath: path.join(storeDir, "ask-agent.jsonl"),
      ...overrides,
    },
    server,
    {
      askAgentPreferencesStore: new BrowserGatewayAskAgentPreferencesStore({
        filePath: path.join(storeDir, "preferences.json"),
      }),
      askAgentHistoryStore: new BrowserGatewayAskAgentHistoryStore({
        filePath: path.join(storeDir, "history.json"),
      }),
      askAgentMemoryStore: new BrowserGatewayAskAgentMemoryStore({
        filePath: path.join(storeDir, "memory.json"),
      }),
    },
  );
  server.on("request", helper.handleRequest);
  await helper.start();
  const fixture = { helper, server, storeDir };
  fixtures.push(fixture);
  return fixture;
}

function serverPort(server: http.Server): number {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("helper_lifecycle_test_missing_server_address");
  }
  return address.port;
}

afterEach(async () => {
  while (fixtures.length > 0) {
    const fixture = fixtures.pop()!;
    await fixture.helper.stop("test-cleanup");
    await fs.rm(fixture.storeDir, { recursive: true, force: true });
  }
  await clearBrowserGatewayHelperDiscovery();
});

describe("BrowserGatewayHelper lifecycle integration", () => {
  it("shares repeated stop calls and destroys accepted sockets at the deadline", async () => {
    const { helper, server, storeDir } = await createHelperFixture();
    const socket = net.connect(serverPort(server), "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    const requestStarted = new Promise<void>((resolve) => {
      server.once("request", () => resolve());
    });
    socket.write(
      [
        "POST /internal/client/lease HTTP/1.1",
        `Host: 127.0.0.1:${serverPort(server)}`,
        `Authorization: Bearer ${helper.getClientSharedSecret()}`,
        "Content-Type: application/json",
        "Content-Length: 100",
        "Connection: keep-alive",
        "",
        "{",
      ].join("\r\n"),
    );
    await requestStarted;
    await expect
      .poll(() => helper.getLifecycleStateForTest().acceptedSocketCount)
      .toBe(1);
    const socketClosed = new Promise<void>((resolve) =>
      socket.once("close", () => resolve()),
    );

    const first = helper.stop("test-deadline");
    const second = helper.stop("ignored-second-reason");

    expect(second).toBe(first);
    await first;
    await socketClosed;

    expect(socket.destroyed).toBe(true);
    const logs = (
      await fs.readFile(path.join(storeDir, "ask-agent.jsonl"), "utf-8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(logs).toContainEqual(
      expect.objectContaining({
        event: "helper.stopped",
        timedOut: true,
        destroyedSockets: 1,
      }),
    );
    expect(helper.getLifecycleStateForTest()).toMatchObject({
      acceptedSocketCount: 0,
      activeStreamCount: 0,
      livenessReasons: [],
    });
    expect(server.listening).toBe(false);
  });

  it("does not clear discovery owned by a newer helper generation", async () => {
    const { helper } = await createHelperFixture({ shutdownTimeoutMs: 1_000 });
    const current = await readBrowserGatewayHelperDiscovery();
    expect(current?.helperGenerationId).toBeTruthy();
    const replacement = {
      ...current,
      helperGenerationId: "replacement-helper-generation",
      startedAt: new Date(Date.now() + 1_000).toISOString(),
    } as BrowserGatewayHelperDiscoveryRecord;
    await writeBrowserGatewayHelperDiscovery(replacement);

    await helper.stop("test-stale-generation-cleanup");

    await expect(readBrowserGatewayHelperDiscovery()).resolves.toMatchObject({
      helperGenerationId: "replacement-helper-generation",
    });
  });
});
