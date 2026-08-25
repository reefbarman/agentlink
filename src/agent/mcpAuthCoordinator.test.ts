import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  McpAuthCoordinator,
  mcpServerIdentityHash,
  type McpAuthorizationAttempt,
} from "./mcpAuthCoordinator.js";

const temporaryDirectories: string[] = [];

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "agentlink-mcp-auth-"),
  );
  temporaryDirectories.push(directory);
  return directory;
}

function request(
  overrides: Partial<McpAuthorizationAttempt> = {},
): McpAuthorizationAttempt {
  const serverName = "linear";
  const serverUrl = "https://mcp.linear.app/mcp";
  return {
    serverName,
    serverUrl,
    serverIdentityHash: mcpServerIdentityHash(serverName, serverUrl),
    trigger: "runtime-reconnect",
    userInitiated: false,
    authMode: "interactive",
    attemptId: "attempt-1",
    rootAttemptId: "attempt-1",
    retryCount: 0,
    tokenGenerationBefore: 0,
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("McpAuthCoordinator", () => {
  it("allows one cross-host browser flow and blocks a concurrent host", async () => {
    const stateDirectory = await makeTemporaryDirectory();
    const first = new McpAuthCoordinator({
      stateDirectory,
      instanceId: "window-a",
      isProcessAlive: () => true,
    });
    const second = new McpAuthCoordinator({
      stateDirectory,
      instanceId: "window-b",
      isProcessAlive: () => true,
    });

    const acquired = await first.beforeBrowserOpen(request());
    expect(acquired.allowed).toBe(true);

    await expect(
      second.beforeBrowserOpen(request({ attemptId: "attempt-2" })),
    ).resolves.toMatchObject({
      allowed: false,
      reason: "blocked_active_lease",
    });
  });

  it("turns a completed lease into cooldown and lets manual reauth bypass it", async () => {
    const stateDirectory = await makeTemporaryDirectory();
    const first = new McpAuthCoordinator({
      stateDirectory,
      instanceId: "window-a",
      isProcessAlive: () => true,
    });
    const second = new McpAuthCoordinator({
      stateDirectory,
      instanceId: "window-b",
      isProcessAlive: () => true,
    });

    const acquired = await first.beforeBrowserOpen(request());
    if (!acquired.allowed) throw new Error("expected lease acquisition");
    await acquired.lease.complete();

    await expect(
      second.beforeBrowserOpen(request({ attemptId: "attempt-2" })),
    ).resolves.toMatchObject({
      allowed: false,
      reason: "blocked_cooldown",
    });
    await expect(
      second.beforeBrowserOpen(
        request({
          attemptId: "attempt-3",
          trigger: "manual-reauth",
          userInitiated: true,
        }),
      ),
    ).resolves.toMatchObject({ allowed: true });
  });

  it("recovers an active lease whose owner process is gone", async () => {
    const stateDirectory = await makeTemporaryDirectory();
    const first = new McpAuthCoordinator({
      stateDirectory,
      instanceId: "window-a",
      isProcessAlive: () => true,
    });
    const acquired = await first.beforeBrowserOpen(request());
    expect(acquired.allowed).toBe(true);

    const recovered = new McpAuthCoordinator({
      stateDirectory,
      instanceId: "window-b",
      isProcessAlive: () => false,
    });
    await expect(
      recovered.beforeBrowserOpen(request({ attemptId: "attempt-2" })),
    ).resolves.toMatchObject({ allowed: true });
  });

  it("keeps dialog counts attempt-scoped and makes manual-reauth sticky", async () => {
    const stateDirectory = await makeTemporaryDirectory();
    const coordinator = new McpAuthCoordinator({
      stateDirectory,
      isProcessAlive: () => true,
    });
    const acquired = await coordinator.beforeBrowserOpen(request());
    expect(acquired.allowed).toBe(true);

    await expect(
      coordinator.beforeBrowserOpen(request()),
    ).resolves.toMatchObject({
      allowed: false,
      reason: "blocked_dialog_cap",
    });
    await expect(
      coordinator.beforeBrowserOpen(request({ attemptId: "attempt-2" })),
    ).resolves.toMatchObject({
      allowed: false,
      reason: "blocked_manual_reauth",
    });
  });

  it("uses one persistent local telemetry identity across coordinator instances", async () => {
    const stateDirectory = await makeTemporaryDirectory();
    const firstRecord = vi.fn();
    const secondRecord = vi.fn();
    const first = new McpAuthCoordinator({ stateDirectory });
    const second = new McpAuthCoordinator({ stateDirectory });
    first.setTelemetry({ record: firstRecord });
    second.setTelemetry({ record: secondRecord });
    const event = {
      type: "connect_start" as const,
      serverName: "linear",
      serverIdentityHash: request().serverIdentityHash,
      trigger: "startup" as const,
    };

    first.record(event);
    second.record(event);

    const firstIdentity = firstRecord.mock.calls[0]?.[0].serverIdentityHash;
    const secondIdentity = secondRecord.mock.calls[0]?.[0].serverIdentityHash;
    expect(firstIdentity).toBe(secondIdentity);
    expect(firstIdentity).not.toBe(event.serverIdentityHash);
  });

  it("increments token generations across coordinator instances", async () => {
    const stateDirectory = await makeTemporaryDirectory();
    const first = new McpAuthCoordinator({ stateDirectory });
    const second = new McpAuthCoordinator({ stateDirectory });
    const identity = request().serverIdentityHash;

    await expect(first.readTokenGeneration(identity)).resolves.toBe(0);
    await expect(first.incrementTokenGeneration(identity)).resolves.toBe(1);
    await expect(second.incrementTokenGeneration(identity)).resolves.toBe(2);
    await expect(first.readTokenGeneration(identity)).resolves.toBe(2);
  });
});
