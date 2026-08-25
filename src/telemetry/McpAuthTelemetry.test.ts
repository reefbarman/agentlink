import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createMcpAuthTelemetry,
  McpAuthTelemetry,
  type McpAuthEvent,
} from "./McpAuthTelemetry.js";

let tmpDir: string;

async function readJsonLines(
  filePath: string,
): Promise<Record<string, unknown>[]> {
  const raw = await fs.readFile(filePath, "utf-8");
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentlink-mcp-auth-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("McpAuthTelemetry", () => {
  it("writes every bounded event type with the shared diagnostic fields", async () => {
    const telemetryPath = path.join(tmpDir, "mcp-auth.jsonl");
    const telemetry = createMcpAuthTelemetry({
      telemetryPath,
      flushIntervalMs: 0,
      extensionVersion: "1.2.3",
    });
    const common = {
      serverName: "notion",
      serverIdentityHash: "opaque-server-hash",
      trigger: "tool-use" as const,
      authMode: "interactive" as const,
      userInitiated: true,
      attemptId: "attempt-2",
      rootAttemptId: "attempt-1",
      parentAttemptId: "attempt-parent",
      hubScope: "project-a",
      hubGeneration: 7,
      retryCount: 2,
      dialogOpenCount: 1,
      hasSavedTokens: true,
      hasRefreshToken: true,
      tokenGenerationBefore: 3,
      tokenGenerationAfter: 4,
      leaseOutcome: "acquired" as const,
      leaseWaitMs: 12.6,
      decisionReason: "allowed" as const,
    };
    const events: McpAuthEvent[] = [
      { type: "connect_start", ...common },
      { type: "connect_success", ...common },
      { type: "connect_auth_failure", ...common, errorKind: "unauthorized" },
      { type: "refresh_fallback", ...common, errorKind: "refresh_failed" },
      { type: "browser_open_requested", ...common },
      { type: "browser_open_result", ...common, browserOpened: true },
      {
        type: "browser_open_blocked",
        ...common,
        decisionReason: "blocked_lease",
      },
      {
        type: "oauth_callback",
        ...common,
        callbackOutcome: "success",
      },
      { type: "manual_reauth_entered", ...common },
      { type: "manual_reauth_cleared", ...common },
      { type: "runtime_reconnect", ...common, errorKind: "connection_closed" },
      { type: "lease_acquired", ...common },
      { type: "lease_contended", ...common, leaseOutcome: "contended" },
    ];

    for (const event of events) telemetry.record(event);
    await telemetry.flush();

    const records = await readJsonLines(telemetryPath);
    expect(records.map((record) => record.type)).toEqual(
      events.map((event) => event.type),
    );
    expect(records[0]).toMatchObject({
      version: 1,
      extensionVersion: "1.2.3",
      pid: process.pid,
      serverName: "notion",
      serverIdentityHash: "opaque-server-hash",
      attemptId: "attempt-2",
      rootAttemptId: "attempt-1",
      parentAttemptId: "attempt-parent",
      hubScope: "project-a",
      hubGeneration: 7,
      leaseWaitMs: 13,
      hasSavedTokens: true,
      tokenGenerationBefore: 3,
    });
    expect(typeof records[0].at).toBe("string");
    expect(typeof records[0].instanceId).toBe("string");
    expect(new Set(records.map((record) => record.instanceId)).size).toBe(1);
    expect(records[5]).toMatchObject({ browserOpened: true });
    expect(records[6]).toMatchObject({ decisionReason: "blocked_lease" });
    expect(records[7]).toMatchObject({ callbackOutcome: "success" });
  });

  it("allowlists fields and never records raw errors, URLs, tokens, or headers", async () => {
    const telemetryPath = path.join(tmpDir, "mcp-auth.jsonl");
    const telemetry = new McpAuthTelemetry({
      telemetryPath,
      flushIntervalMs: 0,
    });

    telemetry.record({
      type: "connect_auth_failure",
      serverName: " notion ",
      errorKind: "unauthorized",
      retryCount: 1.7,
      hasSavedTokens: false,
      rawError: "Bearer secret-token",
      error: new Error("secret SDK failure"),
      url: "https://example.test/oauth?code=secret",
      authorizationUrl: "https://example.test/authorize",
      token: "secret-token",
      accessToken: "secret-access-token",
      refreshToken: "secret-refresh-token",
      headers: { Authorization: "Bearer secret-token" },
      callbackParameters: { code: "secret-code" },
      unknownField: "should-not-pass",
    } as McpAuthEvent);
    await telemetry.flush();

    const [record] = await readJsonLines(telemetryPath);
    expect(record).toMatchObject({
      type: "connect_auth_failure",
      serverName: "notion",
      errorKind: "unauthorized",
      retryCount: 2,
      hasSavedTokens: false,
    });
    for (const field of [
      "rawError",
      "error",
      "url",
      "authorizationUrl",
      "token",
      "accessToken",
      "refreshToken",
      "headers",
      "callbackParameters",
      "unknownField",
    ]) {
      expect(record).not.toHaveProperty(field);
    }
    expect(JSON.stringify(record)).not.toContain("secret");
  });

  it("rejects malformed required fields and strips invalid optional values", async () => {
    const telemetryPath = path.join(tmpDir, "mcp-auth.jsonl");
    const telemetry = new McpAuthTelemetry({
      telemetryPath,
      flushIntervalMs: 0,
    });

    telemetry.record({ type: "connect_start", serverName: "  " });
    telemetry.record({
      type: "connect_auth_failure",
      serverName: "missing-kind",
    } as McpAuthEvent);
    telemetry.record({
      type: "browser_open_result",
      serverName: "missing-result",
    } as McpAuthEvent);
    telemetry.record({
      type: "browser_open_blocked",
      serverName: "allowed-is-not-blocked",
      decisionReason: "allowed",
    } as unknown as McpAuthEvent);
    telemetry.record({
      type: "oauth_callback",
      serverName: "missing-outcome",
    } as McpAuthEvent);
    telemetry.record({
      type: "connect_start",
      serverName: "valid",
      trigger: "raw-secret-trigger",
      authMode: "unsafe-mode",
      retryCount: Number.NaN,
      leaseWaitMs: -1,
    } as unknown as McpAuthEvent);
    await telemetry.flush();

    const records = await readJsonLines(telemetryPath);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      type: "connect_start",
      serverName: "valid",
    });
    expect(records[0]).not.toHaveProperty("trigger");
    expect(records[0]).not.toHaveProperty("authMode");
    expect(records[0]).not.toHaveProperty("retryCount");
    expect(records[0]).not.toHaveProperty("leaseWaitMs");
  });

  it("re-buffers failed flushes while keeping the buffer bounded", async () => {
    const telemetryPath = path.join(tmpDir, "blocked-target");
    await fs.mkdir(telemetryPath, { recursive: true });
    const telemetry = new McpAuthTelemetry({
      telemetryPath,
      flushIntervalMs: 0,
      maxBufferedEvents: 3,
    });

    for (let index = 0; index < 4; index++) {
      telemetry.record({
        type: "connect_start",
        serverName: `server-${index}`,
      });
    }
    await expect(telemetry.flush()).rejects.toThrow();

    await fs.rmdir(telemetryPath);
    telemetry.record({ type: "connect_start", serverName: "server-final" });
    await telemetry.flush();

    const records = await readJsonLines(telemetryPath);
    expect(records.map((record) => record.serverName)).toEqual([
      "server-2",
      "server-3",
      "server-final",
    ]);
  });

  it("ignores records after dispose", async () => {
    const telemetryPath = path.join(tmpDir, "mcp-auth.jsonl");
    const telemetry = new McpAuthTelemetry({
      telemetryPath,
      flushIntervalMs: 0,
    });

    telemetry.dispose();
    telemetry.record({ type: "connect_start", serverName: "notion" });
    await telemetry.flush();

    await expect(fs.readFile(telemetryPath, "utf-8")).rejects.toThrow();
  });
});
