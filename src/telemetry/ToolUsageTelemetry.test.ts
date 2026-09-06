import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import {
  ToolUsageTelemetry,
  composeChildCountBucket,
} from "./ToolUsageTelemetry.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let tmpDir: string;

async function readJsonLines(filePath: string): Promise<unknown[]> {
  const raw = await fs.readFile(filePath, "utf-8");
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as unknown);
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentlink-telemetry-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("ToolUsageTelemetry", () => {
  it("flushes aggregate tool and parameter counts without raw parameter values", async () => {
    const telemetryPath = path.join(tmpDir, "tool-usage.jsonl");
    const telemetry = new ToolUsageTelemetry({
      telemetryPath,
      flushIntervalMs: 0,
      extensionVersion: "1.2.3",
    });

    telemetry.record({
      toolName: "read_file",
      params: { path: "/secret/project/file.ts", limit: 50 },
      source: "agent",
      mode: "code",
      outcome: "ok",
      durationMs: 12.4,
    });
    telemetry.record({
      toolName: "read_file",
      params: { path: "/other/file.ts" },
      source: "mcp",
      outcome: "error",
      durationMs: 20,
    });

    await telemetry.flush();

    const records = await readJsonLines(telemetryPath);
    expect(records).toHaveLength(1);
    const record = records[0] as {
      extensionVersion: string;
      tools: Record<
        string,
        {
          calls: number;
          outcomes: Record<string, number>;
          sources: Record<string, number>;
          modes: Record<string, number>;
          parameters: Record<string, number>;
          totalDurationMs: number;
          maxDurationMs: number;
        }
      >;
    };

    expect(record.extensionVersion).toBe("1.2.3");
    expect(record.tools.read_file).toMatchObject({
      calls: 2,
      outcomes: { ok: 1, error: 1 },
      sources: { agent: 1, mcp: 1 },
      modes: { code: 1 },
      parameters: { limit: 1, path: 2 },
      totalDurationMs: 32,
      maxDurationMs: 20,
    });
    expect(JSON.stringify(record)).not.toContain("/secret/project/file.ts");
    expect(JSON.stringify(record)).not.toContain("/other/file.ts");
    expect(record.tools.read_file).not.toHaveProperty("projects");
  });

  it("aggregates only opaque project IDs when project scope is available", async () => {
    const telemetryPath = path.join(tmpDir, "tool-usage.jsonl");
    const telemetry = new ToolUsageTelemetry({
      telemetryPath,
      flushIntervalMs: 0,
    });

    telemetry.record({
      toolName: "read_file",
      params: { path: "/sensitive/root/file.ts" },
      source: "agent",
      projectId: "project-0123456789abcdef",
      outcome: "ok",
    });
    telemetry.record({
      toolName: "read_file",
      source: "agent",
      projectId: "project-0123456789abcdef",
      outcome: "error",
    });
    telemetry.record({
      toolName: "read_file",
      source: "agent",
      projectId: "project-fedcba9876543210",
      outcome: "ok",
    });
    await telemetry.flush();

    const [record] = (await readJsonLines(telemetryPath)) as Array<{
      tools: Record<string, { projects?: Record<string, number> }>;
    }>;
    expect(record.tools.read_file.projects).toEqual({
      "project-0123456789abcdef": 2,
      "project-fedcba9876543210": 1,
    });
    expect(JSON.stringify(record)).not.toContain("/sensitive/root/file.ts");
  });

  it("aggregates compose metrics without raw script or result values", async () => {
    const telemetryPath = path.join(tmpDir, "tool-usage.jsonl");
    const telemetry = new ToolUsageTelemetry({
      telemetryPath,
      flushIntervalMs: 0,
    });

    telemetry.record({
      toolName: "compose",
      params: {
        descriptionProvided: true,
        script: "SECRET_COMPOSE_SOURCE",
        result: "SECRET_CHILD_RESULT",
      },
      source: "agent",
      outcome: "error",
      metrics: {
        childCount: 3,
        toolAllBatchCount: 1,
        bridgedBytes: 2048,
        errorKind: "child_failed",
        cancelled: false,
      },
    });
    await telemetry.flush();

    const [record] = (await readJsonLines(telemetryPath)) as Array<{
      tools: Record<
        string,
        {
          numericMetrics: Record<string, number>;
          categoricalMetrics: Record<string, number>;
        }
      >;
    }>;
    expect(record.tools.compose).toMatchObject({
      numericMetrics: {
        childCount: 3,
        toolAllBatchCount: 1,
        bridgedBytes: 2048,
      },
      categoricalMetrics: {
        "errorKind:child_failed": 1,
        "cancelled:false": 1,
      },
    });
    expect(JSON.stringify(record)).not.toContain("SECRET_COMPOSE_SOURCE");
    expect(JSON.stringify(record)).not.toContain("SECRET_CHILD_RESULT");
  });

  it("records bounded compose diagnostics through the narrow interface", async () => {
    const telemetryPath = path.join(tmpDir, "tool-usage.jsonl");
    const telemetry = new ToolUsageTelemetry({
      telemetryPath,
      flushIntervalMs: 0,
    });

    telemetry.recordCompose({
      outcome: "error",
      childCount: 5,
      completedChildCount: 5,
      succeededChildCount: 3,
      failedChildCount: 2,
      toolAllBatchCount: 2,
      toolAllSettledBatchCount: 1,
      bridgedBytes: 2_048,
      runtimeReturnedBytes: 512,
      errorKind: "child_failed",
      errorCode: "child_handler_failed",
      queueWaitBucket: "100_499ms",
      artifactRetention: "retained",
      outputSpilled: true,
      sameTurnRepair: true,
    });
    telemetry.recordCompose({
      outcome: "error",
      childCount: 99,
      errorKind: "PRIVATE_ERROR_MESSAGE",
      errorCode: "/private/path/file.ts",
    });
    await telemetry.flush();

    const [record] = (await readJsonLines(telemetryPath)) as Array<{
      tools: Record<
        string,
        {
          calls: number;
          parameters: Record<string, number>;
          numericMetrics: Record<string, number>;
          categoricalMetrics: Record<string, number>;
        }
      >;
    }>;
    expect(record.tools.compose).toMatchObject({
      calls: 2,
      parameters: {},
      numericMetrics: {
        childCount: 104,
        completedChildCount: 5,
        succeededChildCount: 3,
        failedChildCount: 2,
        toolAllBatchCount: 2,
        toolAllSettledBatchCount: 1,
        bridgedBytes: 2_048,
        runtimeReturnedBytes: 512,
      },
      categoricalMetrics: {
        "telemetrySchemaVersion:1": 2,
        "composeOutcome:error": 2,
        "childCountBucket:4-7": 1,
        "childCountBucket:16+": 1,
        "errorKind:child_failed": 1,
        "errorKind:other": 1,
        "errorCode:child_handler_failed": 1,
        "errorCode:other": 1,
        "queueWaitBucket:100_499ms": 1,
        "queueWaitBucket:none": 1,
        "artifactRetention:retained": 1,
        "artifactRetention:none": 1,
        "outputSpilled:true": 1,
        "outputSpilled:false": 1,
        "sameTurnRepair:true": 1,
        "sameTurnRepair:false": 1,
      },
    });
    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain("PRIVATE_ERROR_MESSAGE");
    expect(serialized).not.toContain("/private/path/file.ts");
  });

  it("uses the fixed compose child buckets", () => {
    expect(
      [-1, 0, 1, 2, 3, 4, 7, 8, 15, 16, 1_000].map(composeChildCountBucket),
    ).toEqual([
      "0",
      "0",
      "1",
      "2-3",
      "2-3",
      "4-7",
      "4-7",
      "8-15",
      "8-15",
      "16+",
      "16+",
    ]);
  });

  it("records diagnostic metrics without inflating tool call counts", async () => {
    const telemetryPath = path.join(tmpDir, "tool-usage.jsonl");
    const telemetry = new ToolUsageTelemetry({
      telemetryPath,
      flushIntervalMs: 0,
    });

    telemetry.recordMetrics("write_file", {
      writeApprovalPrompt: true,
      writeApprovalPromptReason: "no_matching_write_authority",
      writeApprovalSessionRuleCount: 2,
    });
    telemetry.record({
      toolName: "write_file",
      params: { path: "/sensitive/project/file.ts", content: "SECRET" },
      source: "agent",
      outcome: "ok",
    });
    await telemetry.flush();

    const [record] = (await readJsonLines(telemetryPath)) as Array<{
      tools: Record<
        string,
        {
          calls: number;
          numericMetrics: Record<string, number>;
          categoricalMetrics: Record<string, number>;
        }
      >;
    }>;
    expect(record.tools.write_file).toMatchObject({
      calls: 1,
      numericMetrics: { writeApprovalSessionRuleCount: 2 },
      categoricalMetrics: {
        "writeApprovalPrompt:true": 1,
        "writeApprovalPromptReason:no_matching_write_authority": 1,
      },
    });
    expect(JSON.stringify(record)).not.toContain("/sensitive/project/file.ts");
    expect(JSON.stringify(record)).not.toContain("SECRET");
  });

  it("appends a new JSONL record for each non-empty flush", async () => {
    const telemetryPath = path.join(tmpDir, "tool-usage.jsonl");
    const telemetry = new ToolUsageTelemetry({
      telemetryPath,
      flushIntervalMs: 0,
    });

    telemetry.record({
      toolName: "search_files",
      params: { query: "TODO" },
      source: "agent",
      outcome: "ok",
    });
    await telemetry.flush();
    await telemetry.flush();

    telemetry.record({
      toolName: "write_file",
      params: { path: "src/a.ts", content: "secret content" },
      source: "mcp",
      outcome: "cancelled",
    });
    await telemetry.flush();

    const records = await readJsonLines(telemetryPath);
    expect(records).toHaveLength(2);
    expect(
      (records[0] as { tools: Record<string, unknown> }).tools,
    ).toHaveProperty("search_files");
    expect(
      (records[1] as { tools: Record<string, unknown> }).tools,
    ).toHaveProperty("write_file");
    expect(JSON.stringify(records)).not.toContain("secret content");
  });

  it("recovers stale append locks from dead extension hosts", async () => {
    const telemetryPath = path.join(tmpDir, "tool-usage.jsonl");
    await fs.mkdir(`${telemetryPath}.lock`, { recursive: true });

    const telemetry = new ToolUsageTelemetry({
      telemetryPath,
      flushIntervalMs: 0,
      lockTimeoutMs: 200,
      staleLockMs: 0,
    });
    telemetry.record({
      toolName: "get_terminal_output",
      params: { terminal_id: "abc" },
      source: "mcp",
      outcome: "ok",
    });

    await telemetry.flush();

    const records = await readJsonLines(telemetryPath);
    expect(records).toHaveLength(1);
    await expect(fs.stat(`${telemetryPath}.lock`)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
