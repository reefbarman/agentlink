import type { ChatMessage } from "../agent/webview/types.js";
import {
  StreamingBaselineRecorder,
  type StreamingBaselineSummary,
  utf8ByteLength,
} from "./streamingBaselineMetrics.js";

export interface StreamingBaselineFixtureOptions {
  transcriptMessages: number;
  clients: number;
  textDeltas: number;
  semanticTransitions: number;
}

export interface StreamingBaselineFixtureResult {
  options: StreamingBaselineFixtureOptions;
  transcript: ChatMessage[];
  gateway: StreamingBaselineSummary;
  webview: StreamingBaselineSummary;
}

export const STREAMING_BASELINE_SCENARIOS: readonly StreamingBaselineFixtureOptions[] =
  [
    {
      transcriptMessages: 4,
      clients: 1,
      textDeltas: 8,
      semanticTransitions: 4,
    },
    {
      transcriptMessages: 4,
      clients: 3,
      textDeltas: 8,
      semanticTransitions: 4,
    },
    {
      transcriptMessages: 200,
      clients: 1,
      textDeltas: 8,
      semanticTransitions: 4,
    },
    {
      transcriptMessages: 200,
      clients: 3,
      textDeltas: 8,
      semanticTransitions: 4,
    },
  ];

export function makeStreamingBaselineTranscript(
  messageCount: number,
): ChatMessage[] {
  return Array.from({ length: messageCount }, (_, index) => {
    const assistant = index % 2 === 1;
    return {
      id: `fixture-message-${index + 1}`,
      role: assistant ? "assistant" : "user",
      content: assistant ? "" : `Prompt ${index + 1}`,
      timestamp: index + 1,
      blocks: assistant
        ? [{ type: "text" as const, text: `Response ${index + 1}` }]
        : [],
    };
  });
}

/**
 * Deterministic amplification model pinned to integration-tested pipeline counts.
 * Runtime duration and byte measurements come from the injected development recorder.
 */
export function runStreamingBaselineFixture(
  options: StreamingBaselineFixtureOptions,
): StreamingBaselineFixtureResult {
  const recorder = new StreamingBaselineRecorder();
  const transcript = makeStreamingBaselineTranscript(
    options.transcriptMessages,
  );
  const totalUpdates = options.textDeltas + options.semanticTransitions;
  const activeMessageId = transcript.at(-1)?.id ?? "active";

  recorder.record({
    type: "sse_clients",
    surface: "vscode-gateway",
    clientCount: options.clients,
  });

  for (let index = 0; index < totalUpdates; index += 1) {
    const textDelta = index < options.textDeltas;
    recorder.record({
      type: "delta",
      surface: "vscode-gateway",
      kind: textDelta ? "text" : "semantic",
      chars: textDelta ? 4 : 0,
    });

    for (let build = 0; build < 2; build += 1) {
      recorder.record({
        type: "snapshot_build",
        surface: "vscode-gateway",
        durationMs: 0,
        messageCount: transcript.length,
      });
      recorder.record({
        type: "serialization",
        surface: "vscode-gateway",
        durationMs: 0,
        bytes: utf8ByteLength(JSON.stringify(transcript)),
      });
    }
    recorder.record({
      type: "broadcast",
      surface: "vscode-gateway",
      clientCount: options.clients,
    });

    for (const message of transcript) {
      const active = message.id === activeMessageId;
      recorder.record({
        type: "render",
        surface: "browser-webview",
        phase: "render",
        target: active ? "active" : "history",
        messageId: message.id,
        scope: "fixture",
        unchanged: !active,
      });
      recorder.record({
        type: "render",
        surface: "browser-webview",
        phase: "commit",
        target: active ? "active" : "history",
        messageId: message.id,
        scope: "fixture",
        unchanged: !active,
      });
    }
  }

  return {
    options,
    transcript,
    gateway: recorder.summarize("vscode-gateway"),
    webview: recorder.summarize("browser-webview", "fixture"),
  };
}
