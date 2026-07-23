import { isDeepStrictEqual } from "node:util";

import { BROWSER_GATEWAY_DATA_PLANE_LIMITS } from "../dataPlane/limits.js";
import {
  runOwnerDataPlaneLoad,
  type OwnerDataPlaneLoadOptions,
  type OwnerDataPlaneLoadResult,
} from "./ownerDataPlaneLoadFixture.js";

export const PHASE3_PERFORMANCE_FOCUSED_SUITES = [
  "src/shared/streamingBaselineMetrics.test.ts",
  "src/agent/webview/components/TranscriptMessageList.test.ts",
  "src/browser-gateway/webview/BrowserGatewayApp.test.ts",
  "src/browser-gateway/webview/relay/RelayOwnerStore.test.ts",
] as const;

export interface Phase3PerformanceGateOptions extends Omit<
  OwnerDataPlaneLoadOptions,
  "relayBrowserConnections"
> {
  readonly enforceSustainedTiming?: boolean;
}

export interface Phase3PerformanceGateReport {
  readonly load: OwnerDataPlaneLoadResult;
  readonly limits: {
    readonly retainedCheckpointMessages: number;
    readonly ownerPublicationRequestBytes: number;
    readonly ownerPublicationQueueBytes: number;
  };
  readonly delegatedFocusedSuites: readonly string[];
  readonly violations: readonly string[];
  readonly passed: boolean;
}

export async function runPhase3PerformanceGate(
  options: Phase3PerformanceGateOptions,
): Promise<Phase3PerformanceGateReport> {
  const load = await runOwnerDataPlaneLoad({
    ...options,
    relayBrowserConnections: 4,
  });
  const violations = evaluatePhase3PerformanceLoad(load, {
    enforceSustainedTiming: options.enforceSustainedTiming === true,
  });
  return {
    load,
    limits: {
      retainedCheckpointMessages:
        BROWSER_GATEWAY_DATA_PLANE_LIMITS.selectedOwnerCheckpointMessages,
      ownerPublicationRequestBytes:
        BROWSER_GATEWAY_DATA_PLANE_LIMITS.ownerPublicationRequestBytes,
      ownerPublicationQueueBytes:
        BROWSER_GATEWAY_DATA_PLANE_LIMITS.ownerPublicationQueueBytes,
    },
    delegatedFocusedSuites: PHASE3_PERFORMANCE_FOCUSED_SUITES,
    violations,
    passed: violations.length === 0,
  };
}

export function evaluatePhase3PerformanceLoad(
  load: OwnerDataPlaneLoadResult,
  options: { readonly enforceSustainedTiming?: boolean } = {},
): string[] {
  const violations: string[] = [];
  const require = (condition: boolean, message: string): void => {
    if (!condition) violations.push(message);
  };

  require(load.sourceUpdates > 0, "no source updates were produced");
  require(load.sourceHistoryMessages >
    BROWSER_GATEWAY_DATA_PLANE_LIMITS.selectedOwnerCheckpointMessages, "source history did not exceed the bounded checkpoint window");
  require(load.retainedCheckpointMessages ===
    BROWSER_GATEWAY_DATA_PLANE_LIMITS.selectedOwnerCheckpointMessages, "retained checkpoint history exceeded or missed the configured bound");
  require(load.eventCounts["transcript.block.delta"] >
    0, "transcript delta traffic was not exercised");
  require(load.eventCounts["interaction.updated"] >
    0, "immediate interaction traffic was not exercised");
  require(load.eventCounts["queue.updated"] >
    0, "batched queue traffic was not exercised");
  require(load.immediateLatency.count >
    0, "no immediate latency samples recorded");
  require(load.batchedLatency.count > 0, "no batched latency samples recorded");
  require(load.publicationBatches >
    0, "no publication batches reached the helper");
  require(load.publicationWireBytes >
    0, "no publication bytes reached the helper");
  require(load.maximumPublicationWireBatchBytes <=
    BROWSER_GATEWAY_DATA_PLANE_LIMITS.ownerPublicationRequestBytes, "publication request exceeded the configured byte limit");
  require(load.maximumPendingBatches <=
    2, "owner publication backlog exceeded two batches");
  require(load.maximumQueuedBytes >
    0, "owner publication queue was not exercised");
  require(load.maximumQueuedBytes <
    BROWSER_GATEWAY_DATA_PLANE_LIMITS.ownerPublicationQueueBytes, "owner publication queue reached the compaction limit");
  require(load.finalPendingBatches ===
    0, "owner publication backlog did not drain");
  require(isDeepStrictEqual(
    load.sourceCheckpoint,
    load.relayCheckpoint,
  ), "relay checkpoint did not converge to the source checkpoint");
  require(load.relayBrowserClients.length ===
    4, "load gate did not open four relay browser clients");
  require(load.maximumRelaySubscribers ===
    4, "relay subscriber count did not reach four");
  require(load.finalRelaySubscribers ===
    0, "relay subscribers did not cleanly disconnect");
  require(load.relayCheckpointRequests ===
    0, "healthy relay load unexpectedly requested a checkpoint");
  for (const [index, client] of load.relayBrowserClients.entries()) {
    require(client.ownerEventFrames >
      0, `relay browser client ${index + 1} received no owner events`);
    require(client.checkpointFrames >
      0, `relay browser client ${index + 1} received no initial checkpoint`);
    require(client.orderingViolationFrames ===
      0, `relay browser client ${index + 1} received duplicate or out-of-order owner sequences`);
    require(client.sequenceGapFrames ===
      0, `relay browser client ${index + 1} received non-contiguous owner sequences`);
    require(client.lastOwnerSequence ===
      load.relayCheckpoint
        .checkpointSequence, `relay browser client ${index + 1} missed the terminal owner sequence`);
    require(!client.closedUnexpectedly, `relay browser client ${index + 1} closed unexpectedly`);
    require(client.resetFramesDuringLoad ===
      0, `relay browser client ${index + 1} reset during healthy load`);
  }

  if (options.enforceSustainedTiming) {
    require(load.durationMs >=
      60_000, "sustained gate ran for less than 60 seconds");
    require(load.requestedSourceUpdatesPerSecond ===
      30, "sustained gate did not request 30 source updates per second");
    require(load.measuredSourceUpdatesPerSecond >=
      29.5, "sustained source update rate fell below 29.5 updates per second");
    require(load.immediateLatency.p95Ms <
      50, "immediate publication p95 latency reached 50ms");
    require(load.batchedLatency.p95Ms <
      120, "batched publication p95 latency reached 120ms");
    require(load.drainDurationMs <
      1_000, "publication drain reached one second");
  }

  return violations;
}
