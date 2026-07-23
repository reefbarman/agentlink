import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ContextUsageTelemetry } from "./ContextUsageTelemetry.js";

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
    path.join(os.tmpdir(), "agentlink-context-telemetry-"),
  );
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("ContextUsageTelemetry", () => {
  it("flushes recorded events as individual JSONL rows", async () => {
    const telemetryPath = path.join(tmpDir, "context-usage.jsonl");
    const telemetry = new ContextUsageTelemetry({
      telemetryPath,
      flushIntervalMs: 0,
      extensionVersion: "1.2.3",
    });

    telemetry.record({
      kind: "condense",
      sessionId: "s1",
      model: "claude-test",
      prevInputTokens: 180_000,
      newInputTokens: 12_000,
      reclaimedTokens: 168_000,
    });
    telemetry.record({
      kind: "context_jump",
      sessionId: "s1",
      model: "claude-test",
      prevInputTokens: 50_000,
      inputTokens: 90_000,
      deltaTokens: 40_000,
      accumulatedBySource: { "tool:read_file": 30_000 },
    });

    await telemetry.flush();
    // Flushing without new events must not duplicate rows.
    await telemetry.flush();

    const records = (await readJsonLines(telemetryPath)) as Array<{
      type: string;
      extensionVersion: string;
      event: { kind: string };
    }>;
    expect(records).toHaveLength(2);
    expect(records[0].type).toBe("context_usage_event");
    expect(records[0].extensionVersion).toBe("1.2.3");
    expect(records.map((r) => r.event.kind)).toEqual([
      "condense",
      "context_jump",
    ]);
  });

  it("recovers stale append locks from dead extension hosts", async () => {
    const telemetryPath = path.join(tmpDir, "context-usage.jsonl");
    await fs.mkdir(`${telemetryPath}.lock`, { recursive: true });

    const telemetry = new ContextUsageTelemetry({
      telemetryPath,
      flushIntervalMs: 0,
      lockTimeoutMs: 200,
      staleLockMs: 0,
    });
    telemetry.record({
      kind: "condense",
      sessionId: "s1",
      model: "claude-test",
      prevInputTokens: 1,
      newInputTokens: 1,
      reclaimedTokens: 0,
    });

    await telemetry.flush();

    const records = await readJsonLines(telemetryPath);
    expect(records).toHaveLength(1);
    await expect(fs.stat(`${telemetryPath}.lock`)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("retains pending events when the flush fails", async () => {
    const telemetryPath = path.join(tmpDir, "context-usage.jsonl");
    const telemetry = new ContextUsageTelemetry({
      telemetryPath,
      flushIntervalMs: 0,
      lockTimeoutMs: 50,
      staleLockMs: 60_000,
    });
    telemetry.record({
      kind: "condense",
      sessionId: "s1",
      model: "claude-test",
      prevInputTokens: 1,
      newInputTokens: 1,
      reclaimedTokens: 0,
    });

    // A fresh (non-stale) foreign lock forces a lock timeout.
    await fs.mkdir(`${telemetryPath}.lock`, { recursive: true });
    await expect(telemetry.flush()).rejects.toThrow(
      "context_usage_telemetry_lock_timeout",
    );
    await fs.rm(`${telemetryPath}.lock`, { recursive: true, force: true });

    await telemetry.flush();
    const records = await readJsonLines(telemetryPath);
    expect(records).toHaveLength(1);
  });
});
