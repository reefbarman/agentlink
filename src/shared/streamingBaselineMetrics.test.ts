import { describe, expect, it } from "vitest";

import {
  getDevelopmentStreamingBaselineMetrics,
  StreamingBaselineRecorder,
  type StreamingBaselineEvent,
} from "./streamingBaselineMetrics.js";

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
      deliveredClientCount: 2,
      bytes: 400,
    });
    recorder.record({
      type: "sse_first_delivery",
      surface: "vscode-gateway",
      durationMs: 12,
      bytes: 1_024,
    });
    recorder.record({
      type: "sse_client_removed",
      surface: "vscode-gateway",
      reason: "backpressure",
    });
    recorder.record({
      type: "sse_client_removed",
      surface: "vscode-gateway",
      reason: "write_error",
    });
    recorder.record({
      type: "browser_connection",
      surface: "browser-webview",
      phase: "created",
      elapsedMs: 0,
    });
    recorder.record({
      type: "browser_connection",
      surface: "browser-webview",
      phase: "open",
      elapsedMs: 25,
    });
    recorder.record({
      type: "browser_connection",
      surface: "browser-webview",
      phase: "first_commit",
      elapsedMs: 100,
    });
    recorder.record({
      type: "browser_connection",
      surface: "browser-webview",
      phase: "error",
      elapsedMs: 300,
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
      broadcastAttempts: 3,
      broadcastDeliveries: 2,
      connectedClientsMax: 3,
      firstDeliveries: 1,
      firstDeliveryDurationMs: 12,
      firstDeliveryBytes: 1_024,
      sseRemovals: 2,
      sseBackpressureRemovals: 1,
      sseTransportErrorRemovals: 1,
      textDeltas: 2,
      semanticDeltas: 1,
      coalescingOpportunities: 1,
    });
    expect(recorder.summarize("vscode-webview", "session-1")).toMatchObject({
      historyRenders: 1,
      unchangedHistoryRenders: 1,
      activeCommits: 1,
    });
    expect(recorder.summarize("browser-webview")).toMatchObject({
      browserConnectionLifecycles: 1,
      browserConnectionOpens: 1,
      browserFirstCommits: 1,
      browserConnectionErrors: 1,
      browserOpenDurationMs: 25,
      browserFirstCommitDurationMs: 100,
    });
  });

  it("treats attempted clients as delivered for legacy fixture events", () => {
    const recorder = new StreamingBaselineRecorder();
    recorder.record({
      type: "broadcast",
      surface: "vscode-gateway",
      clientCount: 3,
    });

    expect(recorder.summarize("vscode-gateway")).toMatchObject({
      broadcastAttempts: 3,
      broadcastDeliveries: 3,
    });
  });

  it("retains bounded raw source-event paint samples and resets them", () => {
    const recorder = new StreamingBaselineRecorder(2);
    for (let index = 1; index <= 3; index += 1) {
      recorder.record({
        type: "source_event_paint",
        surface: "browser-webview",
        correlationId: `helper/owner/generation/event-${index}`,
        eventId: `event-${index}`,
        ownerId: "owner",
        ownerGenerationId: "generation",
        ownerSequence: index,
        eventKind:
          index === 3 ? "interaction.updated" : "transcript.block.delta",
        category: index === 3 ? "approval" : "text",
        latencyClass: index === 3 ? "immediate" : "text_progress",
        sourceEventAt: 100 + index,
        paintedAt: 90 + index,
        elapsedMs: -10,
      });
    }

    expect(recorder.getEvents()).toEqual([
      expect.objectContaining({
        correlationId: "helper/owner/generation/event-2",
      }),
      expect.objectContaining({
        correlationId: "helper/owner/generation/event-3",
        category: "approval",
        latencyClass: "immediate",
        sourceEventAt: 103,
        paintedAt: 93,
        elapsedMs: -10,
      }),
    ]);
    expect(recorder.summarize("browser-webview").droppedEvents).toBe(1);

    recorder.reset();
    expect(recorder.getEvents()).toEqual([]);
    expect(recorder.summarize("browser-webview").droppedEvents).toBe(0);
  });

  it("exposes and resets raw source-event paint samples through the dev inspector", () => {
    const globals = globalThis as typeof globalThis & {
      __agentlinkStreamingBaseline?: {
        events(surface: string): readonly StreamingBaselineEvent[];
        reset(surface?: string): void;
      };
    };
    const metrics = getDevelopmentStreamingBaselineMetrics(
      "browser-webview",
      true,
    );
    globals.__agentlinkStreamingBaseline?.reset("browser-webview");
    metrics.record({
      type: "source_event_paint",
      surface: "browser-webview",
      correlationId: "helper/owner/generation/event-inspector",
      eventId: "event-inspector",
      ownerId: "owner",
      ownerGenerationId: "generation",
      ownerSequence: 1,
      eventKind: "transcript.message.upserted",
      category: "completion",
      latencyClass: "immediate",
      sourceEventAt: 10,
      paintedAt: 20,
      elapsedMs: 10,
    });

    expect(
      globals.__agentlinkStreamingBaseline?.events("browser-webview"),
    ).toEqual([
      expect.objectContaining({
        type: "source_event_paint",
        correlationId: "helper/owner/generation/event-inspector",
      }),
    ]);
    globals.__agentlinkStreamingBaseline?.reset("browser-webview");
    expect(
      globals.__agentlinkStreamingBaseline?.events("browser-webview"),
    ).toEqual([]);
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
