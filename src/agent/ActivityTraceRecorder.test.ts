import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ActivityTraceRecorder } from "./ActivityTraceRecorder.js";
import type { AgentEvent } from "./types.js";

const tempDirs: string[] = [];

function makeTempWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlink-trace-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("ActivityTraceRecorder", () => {
  it("keeps tracing in memory when persistence becomes unavailable", () => {
    const workspace = makeTempWorkspace();
    fs.writeFileSync(path.join(workspace, ".agentlink"), "not a directory");
    const log = vi.fn();
    const recorder = new ActivityTraceRecorder({
      workspaceDir: workspace,
      log,
    });

    expect(() =>
      recorder.appendAgentEvent(
        "session-1",
        "project-1",
        { type: "warning", message: "trace persistence unavailable" },
        "background_agent",
      ),
    ).not.toThrow();
    expect(recorder.getSummary("session-1")).toMatchObject({
      eventCount: 1,
      warningCount: 1,
      recordedEventCount: 0,
      droppedEventCount: 1,
      traceTruncated: true,
    });
    expect(log).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("Disabled persistence after write failure"),
    );

    recorder.appendAgentEvent(
      "session-1",
      "project-1",
      { type: "warning", message: "second warning" },
      "background_agent",
    );
    expect(recorder.getSummary("session-1").warningCount).toBe(2);
    expect(recorder.getSummary("session-1").droppedEventCount).toBe(2);
    expect(log).toHaveBeenCalledOnce();
  });

  it("persists trace events as JSONL and writes a derived summary", () => {
    const workspace = makeTempWorkspace();
    const recorder = new ActivityTraceRecorder({ workspaceDir: workspace });

    recorder.appendAgentEvent(
      "session-1",
      "project-1",
      {
        type: "tool_result",
        toolCallId: "tool-1",
        toolName: "read_file",
        result: [
          { type: "text", text: "file content" },
          { type: "text", text: "\nmore" },
        ],
        durationMs: 25,
        input: { path: "src/example.ts", ignored: "not captured" },
      },
      "foreground_agent",
    );
    recorder.appendAgentEvent(
      "session-1",
      "project-1",
      {
        type: "api_request",
        requestId: "req-1",
        model: "model-a",
        reasoningEffort: "high",
        inputTokens: 100,
        uncachedInputTokens: 80,
        outputTokens: 20,
        cacheReadTokens: 10,
        cacheCreationTokens: 5,
        durationMs: 50,
        timeToFirstToken: 12,
      },
      "foreground_agent",
    );

    const events = recorder.loadEvents("session-1");
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      sessionId: "session-1",
      projectId: "project-1",
      sequence: 1,
      kind: "tool_result",
      summary: "Completed tool read_file",
    });
    expect(events[1]?.payload).toMatchObject({ reasoningEffort: "high" });

    const summary = recorder.loadSummary("session-1");
    expect(summary).toMatchObject({
      sessionId: "session-1",
      projectId: "project-1",
      eventCount: 2,
      recordedEventCount: 2,
      droppedEventCount: 0,
      traceTruncated: false,
      toolCalls: 1,
      toolCallsByName: { read_file: 1 },
      totalToolResultTextChars: "file content\nmore".length,
      toolResultTextCharsByName: { read_file: "file content\nmore".length },
      apiCalls: 1,
      totalInputTokens: 100,
      totalOutputTokens: 20,
      totalCacheReadTokens: 10,
      totalCacheCreationTokens: 5,
    });
  });

  it("attributes events written through append and reads legacy records", () => {
    const workspace = makeTempWorkspace();
    const recorder = new ActivityTraceRecorder({ workspaceDir: workspace });

    recorder.append("project-1", {
      sessionId: "session-1",
      kind: "warning",
      source: "system",
      summary: "Warning",
    });

    const legacySessionDir = path.join(
      workspace,
      ".agentlink",
      "history",
      "legacy-session",
    );
    fs.mkdirSync(legacySessionDir, { recursive: true });
    fs.writeFileSync(
      path.join(legacySessionDir, "activity-trace.jsonl"),
      `${JSON.stringify({
        id: "legacy-event",
        sessionId: "legacy-session",
        timestamp: 1,
        sequence: 1,
        kind: "warning",
        source: "system",
        summary: "Legacy warning",
      })}\n`,
      "utf-8",
    );
    fs.writeFileSync(
      path.join(legacySessionDir, "activity-trace-summary.json"),
      JSON.stringify({
        sessionId: "legacy-session",
        eventCount: 1,
        recordedEventCount: 1,
        droppedEventCount: 0,
        traceTruncated: false,
        toolCalls: 0,
        toolCallsByName: {},
        totalToolResultTextChars: 0,
        toolResultTextCharsByName: {},
        apiCalls: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCacheReadTokens: 0,
        totalCacheCreationTokens: 0,
        condenseCount: 0,
        userInterjectionCount: 0,
        finalMarkerCount: 0,
        warningCount: 1,
        errorCount: 0,
      }),
      "utf-8",
    );

    expect(recorder.loadEvents("session-1")[0]).toMatchObject({
      sessionId: "session-1",
      projectId: "project-1",
    });
    expect(recorder.loadSummary("session-1")).toMatchObject({
      sessionId: "session-1",
      projectId: "project-1",
    });
    expect(recorder.loadEvents("legacy-session")[0]).not.toHaveProperty(
      "projectId",
    );
    expect(recorder.loadSummary("legacy-session")).not.toHaveProperty(
      "projectId",
    );

    recorder.append("project-1", {
      sessionId: "legacy-session",
      kind: "warning",
      source: "system",
      summary: "New warning",
    });
    expect(recorder.loadSummary("legacy-session")).toMatchObject({
      projectId: "project-1",
      eventCount: 2,
    });
  });

  it("records provider admission and background status-summary requests", () => {
    const workspace = makeTempWorkspace();
    const recorder = new ActivityTraceRecorder({
      workspaceDir: workspace,
      now: () => 2_000,
    });

    recorder.appendAgentEvent(
      "session-1",
      "project-1",
      {
        type: "api_request_start",
        requestId: "request-1",
        provider: "codex",
        model: "gpt-test",
        startedAt: 1_000,
        schedulerQueued: true,
      },
      "background_agent",
    );
    recorder.appendBackgroundSummaryEvent("session-1", "project-1", {
      type: "start",
      provider: "codex",
      model: "gpt-mini",
      startedAt: 1_500,
      schedulerQueued: true,
    });
    recorder.appendBackgroundSummaryEvent("session-1", "project-1", {
      type: "complete",
      provider: "codex",
      model: "gpt-mini",
      startedAt: 1_500,
      schedulerQueued: true,
      providerQueueWaitMs: 250,
      durationMs: 500,
    });

    expect(recorder.loadEvents("session-1")).toMatchObject([
      {
        kind: "api_request_start",
        timestamp: 1_000,
        payload: { schedulerQueued: true },
      },
      {
        kind: "background_summary_start",
        timestamp: 1_500,
        source: "system",
      },
      {
        kind: "background_summary_complete",
        timestamp: 2_000,
        payload: { providerQueueWaitMs: 250, durationMs: 500 },
      },
    ]);
  });

  it("caps recorded events but keeps summary counters updated", () => {
    const workspace = makeTempWorkspace();
    const recorder = new ActivityTraceRecorder({
      workspaceDir: workspace,
      maxEventsPerSession: 1,
    });

    const first = recorder.appendAgentEvent(
      "session-1",
      "project-1",
      { type: "tool_start", toolCallId: "a", toolName: "read_file" },
      "foreground_agent",
    );
    const second = recorder.appendAgentEvent(
      "session-1",
      "project-1",
      {
        type: "api_request",
        requestId: "req-1",
        model: "model-a",
        reasoningEffort: "low",
        inputTokens: 10,
        uncachedInputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        durationMs: 1,
        timeToFirstToken: 1,
      },
      "foreground_agent",
    );

    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(recorder.loadEvents("session-1")).toHaveLength(1);
    expect(recorder.loadSummary("session-1")).toMatchObject({
      eventCount: 2,
      recordedEventCount: 1,
      droppedEventCount: 1,
      traceTruncated: true,
      apiCalls: 1,
      totalInputTokens: 10,
      totalOutputTokens: 5,
    });
  });

  it("summarizes tool input with an allowlist, redacts sensitive strings, and caps payload strings", () => {
    const workspace = makeTempWorkspace();
    const recorder = new ActivityTraceRecorder({
      workspaceDir: workspace,
      maxPayloadStringChars: 80,
    });

    recorder.appendAgentEvent(
      "session-1",
      "project-1",
      {
        type: "tool_result",
        toolCallId: "tool-1",
        toolName: "write_file",
        result: [{ type: "text", text: "ok" }],
        durationMs: 1,
        input: {
          path: "very/long/path/example.ts",
          command:
            "curl -H 'Authorization: Bearer secret-token-value' https://example.test",
          content: "raw file contents should not be persisted",
        },
      },
      "foreground_agent",
    );

    const [event] = recorder.loadEvents("session-1");
    const inputSummary = (event.payload?.input ?? {}) as Record<
      string,
      unknown
    >;

    expect(inputSummary.path).toBe("very/long/path/example.ts");
    expect(inputSummary.command).toContain("[REDACTED]");
    expect(inputSummary.content).toBeUndefined();
    expect(JSON.stringify(event)).not.toContain("raw file contents");
    expect(JSON.stringify(event)).not.toContain("secret-token-value");
  });

  it("records MCP approval promotion metadata without storing full promotion details", () => {
    const workspace = makeTempWorkspace();
    const recorder = new ActivityTraceRecorder({ workspaceDir: workspace });

    recorder.appendAgentEvent(
      "session-1",
      "project-1",
      {
        type: "tool_result",
        toolCallId: "tool-1",
        toolName: "linear__list_issues",
        result: [{ type: "text", text: "ok" }],
        durationMs: 1,
        mcpApprovalPromotion: {
          serverName: "linear",
          bareToolName: "list_issues",
          scopes: ["session"],
        },
      },
      "foreground_agent",
    );

    const [event] = recorder.loadEvents("session-1");
    expect(event.payload).toMatchObject({
      mcpApprovalPromoted: true,
      mcpServerName: "linear",
    });
  });

  it("returns newest-first diagnostic evidence with write authorization provenance", () => {
    const workspace = makeTempWorkspace();
    const recorder = new ActivityTraceRecorder({ workspaceDir: workspace });

    recorder.appendAgentEvent(
      "session-1",
      "project-1",
      {
        type: "tool_result",
        toolCallId: "tool-1",
        toolName: "write_file",
        result: [
          {
            type: "text",
            text: JSON.stringify({
              status: "accepted",
              path: "src/example.ts",
              operation: "auto-approved",
              authorization: {
                allowed: true,
                basis: "write_rule",
                scope: "project",
                rule: { pattern: "src/**", mode: "glob" },
              },
              user_edits: "file contents must not enter the trace",
            }),
          },
        ],
        durationMs: 12,
        input: { path: "src/example.ts", content: "secret file body" },
      },
      "foreground_agent",
    );

    const diagnosis = recorder.diagnoseSessionActivity("session-1", {
      toolName: "write_file",
      path: "src/example.ts",
    });

    expect(diagnosis.evidence).toMatchObject([
      {
        toolCallId: "tool-1",
        toolName: "write_file",
        outcome: "ok",
        input: { path: "src/example.ts" },
        result: {
          status: "accepted",
          path: "src/example.ts",
          operation: "auto-approved",
          authorization: {
            allowed: true,
            basis: "write_rule",
            scope: "project",
            rule: { pattern: "src/**", mode: "glob" },
          },
        },
      },
    ]);
    expect(JSON.stringify(diagnosis)).not.toContain("file contents");
    expect(JSON.stringify(diagnosis)).not.toContain("secret file body");
  });

  it("records condense, interjection, final marker, warning, and error counts", () => {
    const workspace = makeTempWorkspace();
    const recorder = new ActivityTraceRecorder({ workspaceDir: workspace });

    const events: AgentEvent[] = [
      {
        type: "user_interjection",
        text: "please keep token=secret-token-value in mind",
        queueId: "q1",
      },
      {
        type: "condense",
        summary: "summary",
        prevInputTokens: 1000,
        newInputTokens: 200,
      },
      {
        type: "final_marker",
        marker: {
          status: "completed",
          source: "tool",
          summary: "done",
        },
      },
      { type: "warning", message: "careful" },
      { type: "error", error: "failed", retryable: false },
    ];

    for (const event of events) {
      recorder.appendAgentEvent(
        "session-1",
        "project-1",
        event,
        "foreground_agent",
      );
    }

    expect(JSON.stringify(recorder.loadEvents("session-1"))).not.toContain(
      "secret-token-value",
    );
    expect(recorder.loadSummary("session-1")).toMatchObject({
      condenseCount: 1,
      userInterjectionCount: 1,
      finalMarkerCount: 1,
      warningCount: 1,
      errorCount: 1,
      finalStatus: "completed",
    });
  });
});
