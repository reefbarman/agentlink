import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import { ToolUsageTelemetry } from "./ToolUsageTelemetry.js";

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
    expect((records[0] as { tools: Record<string, unknown> }).tools).toHaveProperty(
      "search_files",
    );
    expect((records[1] as { tools: Record<string, unknown> }).tools).toHaveProperty(
      "write_file",
    );
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
