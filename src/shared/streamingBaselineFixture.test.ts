import {
  STREAMING_BASELINE_SCENARIOS,
  runStreamingBaselineFixture,
} from "./streamingBaselineFixture.js";
import { describe, expect, it } from "vitest";

describe("streaming baseline fixture", () => {
  it.each(STREAMING_BASELINE_SCENARIOS)(
    "measures $transcriptMessages messages with $clients client(s)",
    (options) => {
      const result = runStreamingBaselineFixture(options);
      const updates = options.textDeltas + options.semanticTransitions;

      expect(result.transcript).toHaveLength(options.transcriptMessages);
      expect(result.gateway).toMatchObject({
        snapshotBuilds: updates * 2,
        serializations: updates * 2,
        broadcasts: updates,
        broadcastDeliveries: updates * options.clients,
        connectedClientsMax: options.clients,
        textDeltas: options.textDeltas,
        semanticDeltas: options.semanticTransitions,
        coalescingOpportunities: Math.max(0, options.textDeltas - 1),
      });
      expect(result.webview).toMatchObject({
        activeRenders: updates,
        activeCommits: updates,
        historyRenders: updates * (options.transcriptMessages - 1),
        unchangedHistoryRenders: updates * (options.transcriptMessages - 1),
        historyCommits: updates * (options.transcriptMessages - 1),
        unchangedHistoryCommits: updates * (options.transcriptMessages - 1),
      });
    },
  );
});
