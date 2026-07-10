import { describe, expect, it } from "vitest";

import { StreamingBaselineRecorder } from "./streamingBaselineMetrics.js";

describe("StreamingBaselineRecorder", () => {
  it("summarizes transport, delta, and render amplification", () => {
    const recorder = new StreamingBaselineRecorder();
    recorder.record({
      type: "snapshot_build",
      surface: "vscode-gateway",
      durationMs: 2,
      messageCount: 20,
    });
    recorder.record({
      type: "message_projection",
      surface: "vscode-gateway",
      durationMs: 1,
      messageCount: 20,
    });
    recorder.record({
      type: "delta",
      surface: "vscode-gateway",
      kind: "text",
      chars: 3,
    });
    recorder.record({
      type: "serialization",
      surface: "vscode-gateway",
      durationMs: 0.5,
      bytes: 400,
    });
    recorder.record({
      type: "delta",
      surface: "vscode-gateway",
      kind: "text",
      chars: 4,
    });
    recorder.record({
      type: "delta",
      surface: "vscode-gateway",
      kind: "semantic",
      chars: 0,
    });
    recorder.record({
      type: "broadcast",
      surface: "vscode-gateway",
      clientCount: 3,
      bytes: 400,
    });
    recorder.record({
      type: "render",
      surface: "vscode-webview",
      phase: "render",
      target: "history",
      messageId: "history-1",
      scope: "session-1",
      unchanged: true,
    });
    recorder.record({
      type: "render",
      surface: "vscode-webview",
      phase: "commit",
      target: "active",
      messageId: "active-1",
      scope: "session-1",
      unchanged: false,
    });

    expect(recorder.summarize("vscode-gateway")).toMatchObject({
      snapshotBuilds: 1,
      projectedMessages: 20,
      serializations: 1,
      serializedBytes: 400,
      broadcasts: 1,
      broadcastDeliveries: 3,
      connectedClientsMax: 3,
      textDeltas: 2,
      semanticDeltas: 1,
      coalescingOpportunities: 1,
    });
    expect(recorder.summarize("vscode-webview", "session-1")).toMatchObject({
      historyRenders: 1,
      unchangedHistoryRenders: 1,
      activeCommits: 1,
    });
  });

  it("bounds retained development samples", () => {
    const recorder = new StreamingBaselineRecorder(3);
    for (let clientCount = 1; clientCount <= 5; clientCount += 1) {
      recorder.record({
        type: "sse_clients",
        surface: "vscode-gateway",
        clientCount,
      });
    }

    expect(recorder.getEvents()).toHaveLength(3);
    expect(recorder.summarize("vscode-gateway")).toMatchObject({
      droppedEvents: 2,
      connectedClientsMax: 5,
    });
  });

  it("resets recorded samples", () => {
    const recorder = new StreamingBaselineRecorder();
    recorder.record({
      type: "sse_clients",
      surface: "ask-agent-helper",
      clientCount: 2,
    });

    recorder.reset();

    expect(recorder.getEvents()).toEqual([]);
    expect(recorder.summarize()).toMatchObject({
      connectedClientsMax: 0,
      broadcasts: 0,
    });
  });
});
