import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SessionOutcomeTelemetry } from "./SessionOutcomeTelemetry.js";

let tmpDir: string;

async function readJsonLines(filePath: string): Promise<unknown[]> {
  const raw = await fs.readFile(filePath, "utf-8");
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as unknown);
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "agentlink-session-outcome-"),
  );
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("SessionOutcomeTelemetry", () => {
  it("writes one enveloped JSONL line per event", async () => {
    const telemetryPath = path.join(tmpDir, "session-outcomes.jsonl");
    const telemetry = new SessionOutcomeTelemetry({
      telemetryPath,
      flushIntervalMs: 0,
      extensionVersion: "1.2.3",
    });

    telemetry.record({
      type: "turn_completed",
      sessionId: "session-a",
      background: false,
      mode: "code",
      turnDurationMs: 120_000.6,
      streamingMs: 30_000,
      backgroundWaitMs: 60_000,
      spawns: 2,
      reviewSpawns: 1,
      spawnedBeforeFirstAction: true,
      efficiency: {
        ordinaryAgentProviderAttempts: 2,
        condenseProviderAttempts: 1,
        completedApiTurns: 1,
        usageEstimatedApiTurns: 0,
        uncachedInputTokens: 20,
        cacheReadTokens: 70,
        cacheCreationTokens: 10,
        outputTokens: 5,
        cacheBreakdownApiTurns: 1,
        cacheBreakdownInputTokens: 100,
        cacheBreakdownReadTokens: 70,
        cacheBreakdownCreationTokens: 10,
        staticFloorSamples: 2,
        staticFloorTokenSends: 50,
        contextLedgerSamples: 2,
        boundedContextRequestedTokens: 10,
        boundedContextOmittedTokens: 5,
        requestsRequestingBoundedContext: 1,
        requestsWithContextOmission: 1,
        contextOverflowTokens: 0,
        requestsWithContextOverflow: 0,
        toolCalls: 4,
      },
    });
    telemetry.record({
      type: "task_completed",
      sessionId: "session-a",
      background: false,
      status: "completed",
      taskDurationMs: 400_000,
      turns: 3,
    });
    telemetry.record({
      type: "background_lifecycle",
      sessionId: "session-bg",
      parentSessionId: "session-a",
      taskClass: "review_code",
      terminal: "completed",
      runMs: 90_000,
      parentBlockedMs: 45_000,
      reviewFindings: { high: 1, low: 2.4 },
      reviewEmptyDiff: false,
      reviewScopeBytes: 1_234,
    });
    telemetry.record({
      type: "approval_interruption",
      sessionId: "session-a",
      background: false,
      mode: "code",
      projectId: "opaque-project-id",
      approvalKind: "command",
      reason: "guardian_denied",
      guardianStatus: "reviewed",
      guardianOutcome: "deny",
      risk: "high",
      permissionIntent: "require_escalated",
      authorityReason: "explicit-escalation",
      routeReason: "explicit-native-request",
    });

    await telemetry.flush();

    const records = (await readJsonLines(telemetryPath)) as Array<
      Record<string, unknown>
    >;
    expect(records).toHaveLength(4);
    for (const record of records) {
      expect(record.version).toBe(1);
      expect(record.extensionVersion).toBe("1.2.3");
      expect(typeof record.at).toBe("string");
      expect(typeof record.instanceId).toBe("string");
    }
    expect(records[0]).toMatchObject({
      type: "turn_completed",
      sessionId: "session-a",
      turnDurationMs: 120_001,
      backgroundWaitMs: 60_000,
      spawnedBeforeFirstAction: true,
      efficiency: {
        ordinaryAgentProviderAttempts: 2,
        cacheBreakdownReadTokens: 70,
        toolCalls: 4,
      },
    });
    expect(records[1]).toMatchObject({
      type: "task_completed",
      status: "completed",
      taskDurationMs: 400_000,
    });
    expect(records[2]).toMatchObject({
      type: "background_lifecycle",
      taskClass: "review_code",
      parentBlockedMs: 45_000,
      reviewFindings: { high: 1, low: 2 },
      reviewEmptyDiff: false,
    });
    expect(records[3]).toMatchObject({
      type: "approval_interruption",
      approvalKind: "command",
      reason: "guardian_denied",
      guardianStatus: "reviewed",
      risk: "high",
      permissionIntent: "require_escalated",
    });
  });

  it("drops non-finite numbers and events without a session id", async () => {
    const telemetryPath = path.join(tmpDir, "session-outcomes.jsonl");
    const telemetry = new SessionOutcomeTelemetry({
      telemetryPath,
      flushIntervalMs: 0,
    });

    telemetry.record({
      type: "turn_completed",
      sessionId: "  ",
      background: false,
      turnDurationMs: 5,
    });
    telemetry.record({
      type: "turn_completed",
      sessionId: "session-a",
      background: true,
      turnDurationMs: Number.NaN,
      streamingMs: Number.POSITIVE_INFINITY,
      toolCalls: 4,
    });

    await telemetry.flush();

    const records = (await readJsonLines(telemetryPath)) as Array<
      Record<string, unknown>
    >;
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      sessionId: "session-a",
      background: true,
      toolCalls: 4,
    });
    expect(records[0]).not.toHaveProperty("turnDurationMs");
    expect(records[0]).not.toHaveProperty("streamingMs");
  });

  it("re-buffers events when a flush fails and bounds the buffer", async () => {
    const telemetryPath = path.join(tmpDir, "no-such-dir-file");
    // Make the target path unwritable by creating a directory in its place.
    await fs.mkdir(telemetryPath, { recursive: true });
    const telemetry = new SessionOutcomeTelemetry({
      telemetryPath,
      flushIntervalMs: 0,
      maxBufferedEvents: 3,
    });

    for (let index = 0; index < 4; index++) {
      telemetry.record({
        type: "task_completed",
        sessionId: `session-${index}`,
        background: false,
        status: "completed",
      });
    }
    await expect(telemetry.flush()).rejects.toThrow();

    // Oldest events were dropped at the cap; the rest survive the failure.
    await fs.rmdir(telemetryPath);
    telemetry.record({
      type: "task_completed",
      sessionId: "session-final",
      background: false,
      status: "completed",
    });
    await telemetry.flush();

    const records = (await readJsonLines(telemetryPath)) as Array<
      Record<string, unknown>
    >;
    const ids = records.map((record) => record.sessionId);
    expect(ids).toEqual(["session-2", "session-3", "session-final"]);
  });

  it("ignores records after dispose", async () => {
    const telemetryPath = path.join(tmpDir, "session-outcomes.jsonl");
    const telemetry = new SessionOutcomeTelemetry({
      telemetryPath,
      flushIntervalMs: 0,
    });
    telemetry.dispose();
    telemetry.record({
      type: "task_completed",
      sessionId: "session-a",
      background: false,
      status: "completed",
    });
    await telemetry.flush();
    await expect(fs.readFile(telemetryPath, "utf-8")).rejects.toThrow();
  });
});
