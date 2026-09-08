import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import {
  ToolUsageTelemetry,
  TOOL_TELEMETRY_LIMITS,
  composeChildCountBucket,
  type ToolUsageFlushRecord,
  type ToolExposureFlushRecord,
  type ToolRequestObservation,
} from "./ToolUsageTelemetry.js";
import { TOOL_CAPABILITIES } from "../core/tools/toolCapabilities.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getAgentToolProfileNames } from "../agent/toolAdapter.js";
import { BUILT_IN_MODES } from "../agent/modes.js";

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
  it("preserves every built-in mode and canonical tool profile", async () => {
    const telemetryPath = path.join(tmpDir, "profile-drift.jsonl");
    const telemetry = new ToolUsageTelemetry({
      telemetryPath,
      flushIntervalMs: 0,
    });
    for (const mode of BUILT_IN_MODES) {
      for (const profile of getAgentToolProfileNames()) {
        telemetry.record({
          toolName: "read_file",
          source: "agent",
          mode: mode.slug,
          outcome: "ok",
          invocation: {
            route: "direct",
            nesting: "top_level",
            profile,
            background: false,
          },
        });
      }
    }
    await telemetry.flush();
    const [record] = (await readJsonLines(telemetryPath)) as Array<{
      invocationGroups: Array<{ mode: string; profile: string }>;
    }>;
    expect(
      record.invocationGroups.every(
        (group) => group.mode !== "other" && group.profile !== "other",
      ),
    ).toBe(true);
  });
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

  it("preserves the legacy projection and separates invocation route and nesting", async () => {
    const telemetryPath = path.join(tmpDir, "tool-usage.jsonl");
    const legacy = {
      version: 1,
      type: "tool_usage_flush",
      tools: { read_file: { calls: 2 } },
    };
    await fs.writeFile(telemetryPath, `${JSON.stringify(legacy)}\n`);
    const telemetry = new ToolUsageTelemetry({
      telemetryPath,
      flushIntervalMs: 0,
    });
    telemetry.record({ toolName: "read_file", source: "agent", outcome: "ok" });
    for (const route of [
      "direct",
      "native_bridge",
      "mcp_bridge",
      "unresolved",
    ] as const) {
      telemetry.record({
        toolName: "read_file",
        source: "agent",
        outcome: route === "unresolved" ? "rejected" : "ok",
        mode: "code",
        invocation: {
          route,
          nesting: "top_level",
          profile: "default",
          background: false,
        },
      });
    }
    telemetry.record({
      toolName: "read_file",
      source: "agent",
      outcome: "partial",
      invocation: {
        route: "direct",
        nesting: "compose_child",
        profile: "review",
        background: true,
      },
    });
    telemetry.recordCompose({
      outcome: "ok",
      childCount: 1,
      invocation: {
        route: "direct",
        nesting: "top_level",
        profile: "default",
        background: false,
      },
    });
    await telemetry.flush();
    const [oldRecord, record] = (await readJsonLines(
      telemetryPath,
    )) as ToolUsageFlushRecord[];
    expect(oldRecord).toEqual(legacy);
    expect(record.version).toBe(2);
    expect(record.tools.read_file.calls).toBe(6);
    expect(record.tools.compose.calls).toBe(1);
    expect(record.tools.call_native_tool).toBeUndefined();
    expect(record.coverage).toMatchObject({
      attributedCalls: 6,
      legacyUnattributedCalls: 1,
      overflowCalls: 0,
    });
    expect(record.invocationGroups).toHaveLength(6);
    expect(
      record.invocationGroups?.filter(
        (group) => group.nesting === "compose_child",
      ),
    ).toEqual([
      expect.objectContaining({
        toolName: "read_file",
        calls: 1,
        profile: "review",
        background: true,
        outcomes: { partial: 1 },
      }),
    ]);
    expect(
      record.invocationGroups?.find((group) => group.route === "unresolved"),
    ).toMatchObject({ outcomes: { rejected: 1 } });
  });

  it("records exposure separately and excludes retries, duplicate uses, incomplete and ineligible cohorts from adoption", async () => {
    const telemetryPath = path.join(tmpDir, "tool-usage.jsonl");
    const telemetry = new ToolUsageTelemetry({
      telemetryPath,
      flushIntervalMs: 0,
    });
    const request: ToolRequestObservation = {
      inlineToolNames: [
        "read_file",
        "write_file",
        "read_file",
        "private_server__secret_tool",
      ],
      deferredToolNames: ["read_file", "get_hover"],
      eligibleToolNames: ["read_file", "get_hover", "search_files"],
      usedToolNames: ["read_file", "read_file", "get_hover", "write_file"],
      mode: "code",
      profile: "default",
      background: false,
      completed: true,
      providerAttempts: 3,
    };
    telemetry.recordRequest(request);
    telemetry.recordRequest({
      ...request,
      completed: false,
      providerAttempts: 2,
    });
    telemetry.recordRequest({ ...request, providerAttempts: 0 });
    await telemetry.flush();
    const records = (await readJsonLines(
      telemetryPath,
    )) as ToolExposureFlushRecord[];
    expect(records).toHaveLength(1);
    const record = records[0];
    expect(record.type).toBe("tool_exposure_flush");
    expect(record).not.toHaveProperty("tools");
    expect(record.coverage).toMatchObject({
      snapshot: "engine_request_snapshot",
      wireAdvertisement: "unknown",
      externalAcp: "unsupported",
    });
    expect(record.totals).toMatchObject({
      requests: 2,
      completedRequests: 1,
      incompleteRequests: 1,
      providerAttempts: 5,
      ignoredToolNames: 2,
    });
    expect(record.groups).toHaveLength(4);
    expect(
      record.groups.find((group) => group.toolName === "read_file"),
    ).toMatchObject({
      exposure: "inline",
      eligible: true,
      requests: 2,
      completedRequests: 1,
      incompleteRequests: 1,
      requestsWithUse: 1,
      eligibleCompletedRequests: 1,
      eligibleRequestsWithUse: 1,
      providerAttempts: 5,
    });
    expect(
      record.groups.find((group) => group.toolName === "get_hover"),
    ).toMatchObject({
      exposure: "discoverable",
      eligibleCompletedRequests: 1,
      eligibleRequestsWithUse: 1,
    });
    expect(
      record.groups.find((group) => group.toolName === "write_file"),
    ).toMatchObject({
      eligible: false,
      eligibleCompletedRequests: 0,
      eligibleRequestsWithUse: 0,
    });
    expect(
      record.groups.find((group) => group.toolName === "search_files"),
    ).toMatchObject({ exposure: "not_exposed", eligibleCompletedRequests: 0 });
    expect(JSON.stringify(record)).not.toContain("private_server");
  });

  it("bounds joint groups and untrusted dimensions at the recorder boundary", async () => {
    const telemetryPath = path.join(tmpDir, "tool-usage.jsonl");
    const telemetry = new ToolUsageTelemetry({
      telemetryPath,
      flushIntervalMs: 0,
    });
    const names = Object.keys(TOOL_CAPABILITIES);
    let calls = 0;
    for (const toolName of names) {
      for (const mode of ["code", "ask", "architect", "debug", "review"]) {
        for (const background of [false, true]) {
          telemetry.record({
            toolName,
            source: "agent",
            outcome: "ok",
            mode,
            invocation: {
              route: "direct",
              nesting: "top_level",
              profile: "default",
              background,
            },
          });
          calls += 1;
        }
      }
    }
    for (let index = 0; index < 400; index++) {
      telemetry.record({
        toolName: "read_file",
        source: "agent",
        outcome: "ok",
        mode: `/private/mode/${index}`,
        projectId: `project-${index.toString(16).padStart(16, "0")}`,
        params: { [`param${index}`]: "secret-value" },
        metrics: {
          [`privateKey${index}`]: "secret-category",
          errorKind: `private_category_${index}`,
        },
        invocation: {
          route: "direct",
          nesting: "top_level",
          profile: `/private/profile/${index}`,
          background: false,
        },
      });
      calls += 1;
    }
    await telemetry.flush();
    const [record] = (await readJsonLines(
      telemetryPath,
    )) as ToolUsageFlushRecord[];
    expect(record.invocationGroups!.length).toBeLessThanOrEqual(
      TOOL_TELEMETRY_LIMITS.invocationGroups,
    );
    expect(
      record.invocationGroups!.reduce((sum, group) => sum + group.calls, 0),
    ).toBe(calls);
    expect(record.coverage!.overflowCalls).toBeGreaterThan(0);
    expect(
      record.invocationGroups!.find(
        (group) => group.toolName === "__overflow__",
      )!.calls,
    ).toBe(record.coverage!.overflowCalls);
    expect(
      Object.keys(record.tools.read_file.parameters).length,
    ).toBeLessThanOrEqual(TOOL_TELEMETRY_LIMITS.dimensionValues);
    expect(
      Object.keys(record.tools.read_file.projects!).length,
    ).toBeLessThanOrEqual(TOOL_TELEMETRY_LIMITS.dimensionValues);
    expect(record.coverage!.droppedDimensions.metricKey).toBe(400);
    const serialized = JSON.stringify(record);
    for (const secret of [
      "/private/",
      "privateKey",
      "secret-category",
      "private_category_",
      "secret-value",
    ])
      expect(serialized).not.toContain(secret);
  });

  it("bounds exposure groups and labels overflow without manufacturing adoption", async () => {
    const telemetryPath = path.join(tmpDir, "tool-usage.jsonl");
    const telemetry = new ToolUsageTelemetry({
      telemetryPath,
      flushIntervalMs: 0,
    });
    const names = Object.keys(TOOL_CAPABILITIES);
    for (const mode of ["code", "ask", "architect", "debug", "review"]) {
      for (const profile of ["default", "review", "readonly-research"]) {
        for (const background of [false, true])
          telemetry.recordRequest({
            inlineToolNames: names,
            deferredToolNames: [],
            eligibleToolNames: names,
            usedToolNames: names,
            mode,
            profile,
            background,
            completed: true,
            providerAttempts: 1,
          });
      }
    }
    await telemetry.flush();
    const [record] = (await readJsonLines(
      telemetryPath,
    )) as ToolExposureFlushRecord[];
    expect(record.groups.length).toBeLessThanOrEqual(
      TOOL_TELEMETRY_LIMITS.exposureGroups,
    );
    expect(record.groups.reduce((sum, group) => sum + group.requests, 0)).toBe(
      30 * names.length,
    );
    const overflow = record.groups.find(
      (group) => group.toolName === "__overflow__",
    )!;
    expect(overflow).toMatchObject({
      exposure: "unknown",
      eligible: null,
      eligibleCompletedRequests: 0,
      eligibleRequestsWithUse: 0,
    });
    expect(overflow.requests).toBe(record.totals.overflowToolObservations);
  });

  it("merges failed invocation and exposure flushes with concurrent observations exactly once", async () => {
    const telemetryPath = path.join(tmpDir, "tool-usage.jsonl");
    const lock = `${telemetryPath}.lock`;
    await fs.mkdir(lock);
    const telemetry = new ToolUsageTelemetry({
      telemetryPath,
      flushIntervalMs: 0,
      lockTimeoutMs: 1,
      staleLockMs: 60_000,
    });
    const request: ToolRequestObservation = {
      inlineToolNames: ["read_file"],
      deferredToolNames: [],
      eligibleToolNames: ["read_file"],
      usedToolNames: ["read_file"],
      mode: "code",
      profile: "default",
      background: false,
      completed: true,
      providerAttempts: 2,
    };
    const record = () => {
      telemetry.record({
        toolName: "read_file",
        source: "agent",
        outcome: "ok",
        durationMs: 5,
        invocation: {
          route: "native_bridge",
          nesting: "top_level",
          profile: "default",
          background: false,
        },
      });
      telemetry.recordRequest(request);
    };
    record();
    const flushing = telemetry.flush();
    record();
    await expect(flushing).rejects.toThrow("tool_usage_telemetry_lock_timeout");
    await fs.rm(lock, { recursive: true });
    await telemetry.flush();
    await telemetry.flush();
    const records = await readJsonLines(telemetryPath);
    expect(records).toHaveLength(2);
    const usage = records[0] as ToolUsageFlushRecord;
    expect(usage.tools.read_file.calls).toBe(2);
    expect(usage.invocationGroups).toEqual([
      expect.objectContaining({
        calls: 2,
        totalDurationMs: 10,
        maxDurationMs: 5,
      }),
    ]);
    expect(usage.coverage).toMatchObject({
      attributedCalls: 2,
      legacyUnattributedCalls: 0,
      overflowCalls: 0,
    });
    const exposure = records[1] as ToolExposureFlushRecord;
    expect(exposure.totals).toMatchObject({ requests: 2, providerAttempts: 4 });
    expect(exposure.groups).toEqual([
      expect.objectContaining({
        requests: 2,
        eligibleCompletedRequests: 2,
        eligibleRequestsWithUse: 2,
        providerAttempts: 4,
      }),
    ]);
  });

  it("keeps bounded legacy MCP identities out of new invocation and exposure dimensions", async () => {
    const telemetryPath = path.join(tmpDir, "tool-usage.jsonl");
    const telemetry = new ToolUsageTelemetry({
      telemetryPath,
      flushIntervalMs: 0,
    });
    for (let index = 0; index < 400; index++)
      telemetry.record({
        toolName: `server__tool_${index}`,
        source: "mcp",
        outcome: "ok",
        invocation: {
          route: "mcp_bridge",
          nesting: "top_level",
          profile: "default",
          background: false,
        },
      });
    await telemetry.flush();
    const [record] = (await readJsonLines(
      telemetryPath,
    )) as ToolUsageFlushRecord[];
    expect(record.tools.server__tool_0.calls).toBe(1);
    expect(Object.keys(record.tools).length).toBeLessThanOrEqual(
      TOOL_TELEMETRY_LIMITS.tools,
    );
    expect(
      Object.values(record.tools).reduce(
        (sum, bucket) => sum + bucket.calls,
        0,
      ),
    ).toBe(400);
    expect(record.invocationGroups).toEqual([
      expect.objectContaining({
        toolName: "unknown",
        route: "mcp_bridge",
        calls: 400,
      }),
    ]);
    expect(JSON.stringify(record.invocationGroups)).not.toContain("server__");
  });

  it("retains overflow counts and bounds when failed full batches merge with a second full batch", async () => {
    const telemetryPath = path.join(tmpDir, "tool-usage.jsonl");
    await fs.mkdir(`${telemetryPath}.lock`);
    const telemetry = new ToolUsageTelemetry({
      telemetryPath,
      flushIntervalMs: 0,
      lockTimeoutMs: 1,
      staleLockMs: 60_000,
    });
    const names = Object.keys(TOOL_CAPABILITIES);
    let calls = 0;
    const batch = (reverse: boolean) => {
      for (const mode of reverse
        ? ["review", "debug", "architect", "ask", "code"]
        : ["code", "ask", "architect", "debug", "review"]) {
        for (const profile of ["default", "review", "readonly-research"]) {
          for (const background of [false, true]) {
            telemetry.recordRequest({
              inlineToolNames: names,
              deferredToolNames: [],
              eligibleToolNames: names,
              usedToolNames: names,
              mode,
              profile,
              background,
              completed: true,
              providerAttempts: 1,
            });
            for (const toolName of names) {
              telemetry.record({
                toolName,
                source: "agent",
                mode,
                outcome: "ok",
                invocation: {
                  route: "direct",
                  nesting: "top_level",
                  profile,
                  background,
                },
              });
              calls += 1;
            }
          }
        }
      }
    };
    batch(false);
    const flushing = telemetry.flush();
    batch(true);
    await expect(flushing).rejects.toThrow("tool_usage_telemetry_lock_timeout");
    await fs.rm(`${telemetryPath}.lock`, { recursive: true });
    await telemetry.flush();
    const [usage, exposure] = (await readJsonLines(telemetryPath)) as [
      ToolUsageFlushRecord,
      ToolExposureFlushRecord,
    ];
    expect(usage.invocationGroups!.length).toBeLessThanOrEqual(
      TOOL_TELEMETRY_LIMITS.invocationGroups,
    );
    expect(
      usage.invocationGroups!.reduce((sum, group) => sum + group.calls, 0),
    ).toBe(calls);
    expect(
      usage.invocationGroups!.find(
        (group) => group.toolName === "__overflow__",
      )!.calls,
    ).toBe(usage.coverage!.overflowCalls);
    expect(usage.coverage!.attributedCalls).toBe(calls);
    expect(exposure.groups.length).toBeLessThanOrEqual(
      TOOL_TELEMETRY_LIMITS.exposureGroups,
    );
    expect(
      exposure.groups.reduce((sum, group) => sum + group.requests, 0),
    ).toBe(calls);
    expect(
      exposure.groups.find((group) => group.toolName === "__overflow__")!
        .requests,
    ).toBe(exposure.totals.overflowToolObservations);
    expect(exposure.totals.requests).toBe(60);
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
