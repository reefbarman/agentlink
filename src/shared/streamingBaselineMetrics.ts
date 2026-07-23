export type StreamingBaselineSurface =
  | "vscode-gateway"
  | "ask-agent-helper"
  | "vscode-webview"
  | "browser-webview";

export type StreamingBaselineEvent =
  | {
      type: "snapshot_build";
      surface: StreamingBaselineSurface;
      durationMs: number;
      messageCount: number;
    }
  | {
      type: "message_projection";
      surface: StreamingBaselineSurface;
      durationMs: number;
      messageCount: number;
    }
  | {
      type: "serialization";
      surface: StreamingBaselineSurface;
      durationMs: number;
      bytes: number;
    }
  | {
      type: "broadcast";
      surface: StreamingBaselineSurface;
      clientCount: number;
      deliveredClientCount?: number;
      bytes?: number;
    }
  | {
      type: "sse_clients";
      surface: StreamingBaselineSurface;
      clientCount: number;
    }
  | {
      type: "sse_first_delivery";
      surface: StreamingBaselineSurface;
      durationMs: number;
      bytes: number;
    }
  | {
      type: "sse_client_removed";
      surface: StreamingBaselineSurface;
      reason:
        | "request_close"
        | "response_close"
        | "response_error"
        | "write_error"
        | "backpressure"
        | "ended"
        | "capture_error"
        | "scheduler_error"
        | "dispose";
    }
  | {
      type: "browser_connection";
      surface: Extract<StreamingBaselineSurface, "browser-webview">;
      phase: "created" | "open" | "first_commit" | "error";
      elapsedMs: number;
    }
  | {
      type: "source_event_paint";
      surface: Extract<StreamingBaselineSurface, "browser-webview">;
      correlationId: string;
      eventId: string;
      ownerId: string;
      ownerGenerationId: string;
      ownerSequence: number;
      eventKind: string;
      category:
        | "text"
        | "progress"
        | "approval"
        | "question"
        | "error"
        | "completion";
      latencyClass: "text_progress" | "immediate";
      sourceEventAt: number;
      paintedAt: number;
      elapsedMs: number;
    }
  | {
      type: "delta";
      surface: StreamingBaselineSurface;
      kind: "text" | "semantic";
      chars: number;
    }
  | {
      type: "render";
      surface: StreamingBaselineSurface;
      phase: "render" | "commit";
      target: "history" | "active";
      messageId: string;
      scope: string;
      unchanged: boolean;
    };

export interface StreamingBaselineMetrics {
  readonly enabled: boolean;
  record(event: StreamingBaselineEvent): void;
}

export const NOOP_STREAMING_BASELINE_METRICS: StreamingBaselineMetrics = {
  enabled: false,
  record: () => {},
};

export interface StreamingBaselineSummary {
  droppedEvents: number;
  snapshotBuilds: number;
  snapshotBuildDurationMs: number;
  projectedMessages: number;
  projectionDurationMs: number;
  serializations: number;
  serializationDurationMs: number;
  serializedBytes: number;
  broadcasts: number;
  broadcastAttempts: number;
  broadcastDeliveries: number;
  connectedClientsMax: number;
  firstDeliveries: number;
  firstDeliveryDurationMs: number;
  firstDeliveryBytes: number;
  sseRemovals: number;
  sseBackpressureRemovals: number;
  sseTransportErrorRemovals: number;
  browserConnectionLifecycles: number;
  browserConnectionOpens: number;
  browserFirstCommits: number;
  browserConnectionErrors: number;
  browserOpenDurationMs: number;
  browserFirstCommitDurationMs: number;
  textDeltas: number;
  semanticDeltas: number;
  coalescingOpportunities: number;
  historyRenders: number;
  unchangedHistoryRenders: number;
  activeRenders: number;
  historyCommits: number;
  unchangedHistoryCommits: number;
  activeCommits: number;
}

function emptySummary(): StreamingBaselineSummary {
  return {
    droppedEvents: 0,
    snapshotBuilds: 0,
    snapshotBuildDurationMs: 0,
    projectedMessages: 0,
    projectionDurationMs: 0,
    serializations: 0,
    serializationDurationMs: 0,
    serializedBytes: 0,
    broadcasts: 0,
    broadcastAttempts: 0,
    broadcastDeliveries: 0,
    connectedClientsMax: 0,
    firstDeliveries: 0,
    firstDeliveryDurationMs: 0,
    firstDeliveryBytes: 0,
    sseRemovals: 0,
    sseBackpressureRemovals: 0,
    sseTransportErrorRemovals: 0,
    browserConnectionLifecycles: 0,
    browserConnectionOpens: 0,
    browserFirstCommits: 0,
    browserConnectionErrors: 0,
    browserOpenDurationMs: 0,
    browserFirstCommitDurationMs: 0,
    textDeltas: 0,
    semanticDeltas: 0,
    coalescingOpportunities: 0,
    historyRenders: 0,
    unchangedHistoryRenders: 0,
    activeRenders: 0,
    historyCommits: 0,
    unchangedHistoryCommits: 0,
    activeCommits: 0,
  };
}

export class StreamingBaselineRecorder implements StreamingBaselineMetrics {
  readonly enabled = true;
  private readonly events: StreamingBaselineEvent[] = [];
  private droppedEvents = 0;

  constructor(private readonly maxEvents = 50_000) {}

  record(event: StreamingBaselineEvent): void {
    if (this.events.length >= this.maxEvents) {
      const removeCount = Math.max(1, Math.floor(this.maxEvents / 10));
      this.events.splice(0, removeCount);
      this.droppedEvents += removeCount;
    }
    this.events.push(event);
  }

  getEvents(): readonly StreamingBaselineEvent[] {
    return this.events;
  }

  reset(): void {
    this.events.length = 0;
    this.droppedEvents = 0;
  }

  summarize(
    surface?: StreamingBaselineSurface,
    scope?: string,
  ): StreamingBaselineSummary {
    const summary = emptySummary();
    summary.droppedEvents = this.droppedEvents;
    let previousWasTextDelta = false;

    for (const event of this.events) {
      if (surface && event.surface !== surface) continue;
      if (scope && event.type === "render" && event.scope !== scope) continue;

      switch (event.type) {
        case "snapshot_build":
          summary.snapshotBuilds += 1;
          summary.snapshotBuildDurationMs += event.durationMs;
          break;
        case "message_projection":
          summary.projectedMessages += event.messageCount;
          summary.projectionDurationMs += event.durationMs;
          break;
        case "serialization":
          summary.serializations += 1;
          summary.serializationDurationMs += event.durationMs;
          summary.serializedBytes += event.bytes;
          break;
        case "broadcast":
          summary.broadcasts += 1;
          summary.broadcastAttempts += event.clientCount;
          summary.broadcastDeliveries +=
            event.deliveredClientCount ?? event.clientCount;
          summary.connectedClientsMax = Math.max(
            summary.connectedClientsMax,
            event.clientCount,
          );
          break;
        case "sse_clients":
          summary.connectedClientsMax = Math.max(
            summary.connectedClientsMax,
            event.clientCount,
          );
          break;
        case "sse_first_delivery":
          summary.firstDeliveries += 1;
          summary.firstDeliveryDurationMs += event.durationMs;
          summary.firstDeliveryBytes += event.bytes;
          break;
        case "sse_client_removed":
          summary.sseRemovals += 1;
          if (event.reason === "backpressure") {
            summary.sseBackpressureRemovals += 1;
          }
          if (
            event.reason === "response_error" ||
            event.reason === "write_error"
          ) {
            summary.sseTransportErrorRemovals += 1;
          }
          break;
        case "browser_connection":
          if (event.phase === "created") {
            summary.browserConnectionLifecycles += 1;
          } else if (event.phase === "open") {
            summary.browserConnectionOpens += 1;
            summary.browserOpenDurationMs += event.elapsedMs;
          } else if (event.phase === "first_commit") {
            summary.browserFirstCommits += 1;
            summary.browserFirstCommitDurationMs += event.elapsedMs;
          } else {
            summary.browserConnectionErrors += 1;
          }
          break;
        case "source_event_paint":
          break;
        case "delta":
          if (event.kind === "text") {
            summary.textDeltas += 1;
            if (previousWasTextDelta) summary.coalescingOpportunities += 1;
            previousWasTextDelta = true;
          } else {
            summary.semanticDeltas += 1;
            previousWasTextDelta = false;
          }
          break;
        case "render":
          if (event.phase === "render") {
            if (event.target === "history") {
              summary.historyRenders += 1;
              if (event.unchanged) summary.unchangedHistoryRenders += 1;
            } else {
              summary.activeRenders += 1;
            }
          } else if (event.target === "history") {
            summary.historyCommits += 1;
            if (event.unchanged) summary.unchangedHistoryCommits += 1;
          } else {
            summary.activeCommits += 1;
          }
          break;
      }
    }

    return summary;
  }
}

const developmentRecorders = new Map<
  StreamingBaselineSurface,
  StreamingBaselineRecorder
>();

interface StreamingBaselineInspector {
  events(surface: StreamingBaselineSurface): readonly StreamingBaselineEvent[];
  reset(surface?: StreamingBaselineSurface): void;
  summarize(
    surface: StreamingBaselineSurface,
    scope?: string,
  ): StreamingBaselineSummary | undefined;
}

function installDevelopmentInspector(): void {
  const globals = globalThis as typeof globalThis & {
    __agentlinkStreamingBaseline?: StreamingBaselineInspector;
  };
  globals.__agentlinkStreamingBaseline ??= {
    events: (surface) => developmentRecorders.get(surface)?.getEvents() ?? [],
    reset: (surface) => {
      if (surface) developmentRecorders.get(surface)?.reset();
      else
        for (const recorder of developmentRecorders.values()) recorder.reset();
    },
    summarize: (surface, scope) =>
      developmentRecorders.get(surface)?.summarize(surface, scope),
  };
}

export function getDevelopmentStreamingBaselineMetrics(
  surface: StreamingBaselineSurface,
  enabled: boolean,
): StreamingBaselineMetrics {
  if (!enabled) return NOOP_STREAMING_BASELINE_METRICS;
  installDevelopmentInspector();
  let recorder = developmentRecorders.get(surface);
  if (!recorder) {
    recorder = new StreamingBaselineRecorder();
    developmentRecorders.set(surface, recorder);
  }
  return recorder;
}

export function getDevelopmentStreamingBaselineRecorder(
  surface: StreamingBaselineSurface,
): StreamingBaselineRecorder | undefined {
  return developmentRecorders.get(surface);
}

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
