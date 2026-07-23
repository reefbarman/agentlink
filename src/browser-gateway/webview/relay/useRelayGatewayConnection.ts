import { useCallback, useEffect, useRef } from "preact/hooks";

import { BROWSER_GATEWAY_ASK_AGENT_OWNER_ID } from "../../browserGatewayAskAgentIdentity";
import { BROWSER_GATEWAY_ASK_AGENT_TAB_ID } from "../../askAgentTabs";
import type {
  BrowserGatewayDetailHandle,
  BrowserGatewayOperationState,
  BrowserGatewayOwnerCheckpoint,
  BrowserGatewayOwnerCommandBody,
  BrowserGatewayOwnerEvent,
} from "../../dataPlane/protocol";
import type { GatewaySnapshot } from "../BrowserGatewayApp";
import { RelayConnectionManager } from "./RelayConnectionManager";
import { RelayOwnerStore, type RelayCatalogOwner } from "./RelayOwnerStore";
import {
  parseRelayInteractionPayload,
  RelaySnapshotProjector,
} from "./relaySnapshotProjection";

export type RelaySourceEventPaintCategory =
  | "text"
  | "progress"
  | "approval"
  | "question"
  | "error"
  | "completion";

export interface RelaySourceEventPaintMarker {
  correlationId: string;
  eventId: string;
  ownerId: string;
  ownerGenerationId: string;
  ownerSequence: number;
  eventKind: string;
  category: RelaySourceEventPaintCategory;
  latencyClass: "text_progress" | "immediate";
  sourceEventAt: number;
}

export interface RelaySourceEventPaintMeasurement extends RelaySourceEventPaintMarker {
  paintedAt: number;
  elapsedMs: number;
}

export function createRelaySourceEventPaintQueue(options: {
  scheduleAfterNextPaint: (callback: () => void) => void;
  record: (measurement: RelaySourceEventPaintMeasurement) => void;
  now?: () => number;
}): (marker: RelaySourceEventPaintMarker) => void {
  const pending: RelaySourceEventPaintMarker[] = [];
  const now = options.now ?? Date.now;
  let scheduled = false;
  return (marker) => {
    pending.push(marker);
    if (scheduled) return;
    scheduled = true;
    options.scheduleAfterNextPaint(() => {
      scheduled = false;
      const markers = pending.splice(0);
      const paintedAt = now();
      for (const queued of markers) {
        options.record({
          ...queued,
          paintedAt,
          elapsedMs: paintedAt - queued.sourceEventAt,
        });
      }
    });
  };
}

export function queueAcceptedRelaySourceEventPaint(
  accepted: boolean,
  marker: RelaySourceEventPaintMarker | undefined,
  queue: ((marker: RelaySourceEventPaintMarker) => void) | undefined,
): void {
  if (accepted && marker) queue?.(marker);
}

export interface RelayGatewayConnectionOptions {
  enabled: boolean;
  selectedTabId: string;
  selectedTabGeneration: number;
  commitSnapshot: (
    snapshot: GatewaySnapshot,
    tabId: string,
    generation: number,
    sourceEventPaint?: RelaySourceEventPaintMarker,
  ) => boolean;
  setStatus: (status: string) => void;
  onOperation?: (operation: BrowserGatewayOperationState) => void;
}

export type RelayCommandDispatchResult =
  | { handled: false }
  | { handled: true; operation: BrowserGatewayOperationState };

export function useRelayGatewayConnection(
  options: RelayGatewayConnectionOptions,
): (
  command: BrowserGatewayOwnerCommandBody,
) => Promise<RelayCommandDispatchResult> {
  const latest = useRef(options);
  latest.current = options;
  const catalogRef = useRef<readonly RelayCatalogOwner[]>([]);
  const managerRef = useRef<RelayConnectionManager | null>(null);

  useEffect(() => {
    if (!options.enabled) return;
    const store = new RelayOwnerStore();
    const projectors = new Map<string, RelaySnapshotProjector>();
    const interactionCache = new Map<string, unknown>();
    let checkpointCommitId = 0;
    const manager = new RelayConnectionManager({
      store,
      onCatalog: (catalog) => {
        catalogRef.current = catalog;
        selectCurrentTab(manager, catalog, latest.current.selectedTabId);
      },
      onCheckpoint: (ownerId, ownerGenerationId, checkpoint, sourceEvent) => {
        const commitId = ++checkpointCommitId;
        void commitRelayCheckpoint({
          checkpoint,
          ownerId,
          ownerGenerationId,
          sourceEventPaint: sourceEvent
            ? createRelaySourceEventPaintMarker(sourceEvent)
            : undefined,
          projectors,
          interactionCache,
          isCurrent: () => commitId === checkpointCommitId,
          latest,
          catalog: catalogRef,
        });
      },
      onOperation: (operation) => {
        latest.current.onOperation?.(operation);
      },
      onStatus: (status) => {
        latest.current.setStatus(relayStatusLabel(status));
      },
    });
    managerRef.current = manager;
    manager.start();
    return () => {
      checkpointCommitId += 1;
      managerRef.current = null;
      manager.close();
    };
  }, [options.enabled]);

  useEffect(() => {
    if (!options.enabled) return;
    const manager = managerRef.current;
    if (!manager) return;
    selectCurrentTab(manager, catalogRef.current, options.selectedTabId);
  }, [options.enabled, options.selectedTabId, options.selectedTabGeneration]);

  return useCallback(async (command: BrowserGatewayOwnerCommandBody) => {
    if (!latest.current.enabled) return { handled: false };
    const manager = managerRef.current;
    const owner = resolveOwnerForTab(
      catalogRef.current,
      latest.current.selectedTabId,
    );
    const capability = owner?.capabilities.find(
      (candidate) => candidate.capabilityId === command.kind,
    );
    if (
      !manager ||
      !owner ||
      capability?.state !== "enabled" ||
      !manager.isSubscribedTo(owner)
    ) {
      return { handled: false };
    }
    return {
      handled: true,
      operation: await manager.sendCommand({ command }),
    };
  }, []);
}

export async function commitRelayCheckpoint(options: {
  checkpoint: BrowserGatewayOwnerCheckpoint;
  ownerId: string;
  ownerGenerationId: string;
  sourceEventPaint?: RelaySourceEventPaintMarker;
  projectors: Map<string, RelaySnapshotProjector>;
  interactionCache: Map<string, unknown>;
  fetch?: typeof globalThis.fetch;
  isCurrent: () => boolean;
  latest: { current: RelayGatewayConnectionOptions };
  catalog: { current: readonly RelayCatalogOwner[] };
}): Promise<void> {
  const current = options.latest.current;
  const owner = resolveOwnerForTab(
    options.catalog.current,
    current.selectedTabId,
  );
  if (
    !owner ||
    owner.ownerId !== options.ownerId ||
    owner.ownerGenerationId !== options.ownerGenerationId
  ) {
    return;
  }
  const key = `${options.ownerId}\u0000${options.ownerGenerationId}`;
  let projector = options.projectors.get(key);
  if (!projector) {
    projector = new RelaySnapshotProjector();
    options.projectors.set(key, projector);
  }
  const interaction = options.checkpoint.ui.interaction;
  const handle = interaction?.detailHandle;
  if (!interaction || !handle) {
    current.commitSnapshot(
      projector.project(options.checkpoint),
      current.selectedTabId,
      current.selectedTabGeneration,
      options.sourceEventPaint,
    );
    return;
  }
  current.commitSnapshot(
    projector.project(options.checkpoint),
    current.selectedTabId,
    current.selectedTabGeneration,
  );
  if (!detailMatchesCheckpoint(handle, options.checkpoint)) {
    current.setStatus("Relay interaction unavailable — reconnecting…");
    return;
  }
  try {
    const detailKey = [
      handle.helperGenerationId,
      handle.ownerId,
      handle.ownerGenerationId,
      handle.handleId,
    ].join("\u0000");
    let value = options.interactionCache.get(detailKey);
    if (value === undefined) {
      value = await fetchRelayInteractionDetail(
        handle,
        options.fetch ?? globalThis.fetch,
      );
      options.interactionCache.set(detailKey, value);
    }
    const payload = parseRelayInteractionPayload(value, interaction);
    if (!options.isCurrent()) return;
    if (!detailMatchesCheckpoint(handle, options.checkpoint)) {
      throw new Error("relay_detail_expired_during_hydration");
    }
    const latest = options.latest.current;
    const latestOwner = resolveOwnerForTab(
      options.catalog.current,
      latest.selectedTabId,
    );
    if (
      latestOwner?.ownerId !== options.ownerId ||
      latestOwner.ownerGenerationId !== options.ownerGenerationId
    ) {
      return;
    }
    latest.commitSnapshot(
      projector.project(options.checkpoint, payload),
      latest.selectedTabId,
      latest.selectedTabGeneration,
      options.sourceEventPaint,
    );
  } catch {
    if (!options.isCurrent()) return;
    current.setStatus("Relay interaction unavailable — reconnecting…");
  }
}

export function createRelaySourceEventPaintMarker(
  event: BrowserGatewayOwnerEvent,
): RelaySourceEventPaintMarker | undefined {
  const classification = classifyRelaySourceEvent(event);
  if (!classification) return undefined;
  return {
    correlationId: [
      event.helperGenerationId,
      event.ownerId,
      event.ownerGenerationId,
      event.eventId,
    ]
      .map(encodeURIComponent)
      .join("/"),
    eventId: event.eventId,
    ownerId: event.ownerId,
    ownerGenerationId: event.ownerGenerationId,
    ownerSequence: event.ownerSequence,
    eventKind: event.kind,
    ...classification,
    sourceEventAt: event.emittedAt,
  };
}

function classifyRelaySourceEvent(
  event: BrowserGatewayOwnerEvent,
): Pick<RelaySourceEventPaintMarker, "category" | "latencyClass"> | undefined {
  if (
    event.kind === "transcript.message.appended" ||
    event.kind === "transcript.message.upserted"
  ) {
    const message = (
      event.payload as { message: { error?: unknown; finalMarker?: unknown } }
    ).message;
    if (message.error) return { category: "error", latencyClass: "immediate" };
    if (message.finalMarker) {
      return { category: "completion", latencyClass: "immediate" };
    }
    return { category: "text", latencyClass: "text_progress" };
  }
  if (event.kind === "interaction.updated") {
    const interaction = (
      event.payload as {
        interaction: { kind?: string } | null;
      }
    ).interaction;
    if (interaction?.kind === "approval") {
      return { category: "approval", latencyClass: "immediate" };
    }
    if (interaction?.kind === "question") {
      return { category: "question", latencyClass: "immediate" };
    }
    return undefined;
  }
  if (event.kind === "transcript.block.delta") {
    return { category: "text", latencyClass: "text_progress" };
  }
  if (
    event.kind === "foreground.control.updated" ||
    event.kind === "queue.updated" ||
    event.kind === "todo.updated"
  ) {
    return { category: "progress", latencyClass: "text_progress" };
  }
  return undefined;
}

async function fetchRelayInteractionDetail(
  handle: BrowserGatewayDetailHandle,
  fetch: typeof globalThis.fetch,
): Promise<unknown> {
  const query = new URLSearchParams({
    handleId: handle.handleId,
    ownerId: handle.ownerId,
    ownerGenerationId: handle.ownerGenerationId,
  });
  const response = await fetch(`/api/relay/details?${query}`, {
    credentials: "same-origin",
  });
  if (!response.ok) throw new Error(`relay_detail_failed_${response.status}`);
  const content = new Uint8Array(await response.arrayBuffer());
  if (content.byteLength !== handle.byteLength) {
    throw new Error("relay_detail_size_mismatch");
  }
  return JSON.parse(new TextDecoder().decode(content));
}

function detailMatchesCheckpoint(
  handle: BrowserGatewayDetailHandle,
  checkpoint: BrowserGatewayOwnerCheckpoint,
): boolean {
  return (
    handle.kind === "interaction" &&
    handle.helperGenerationId === checkpoint.helperGenerationId &&
    handle.ownerId === checkpoint.ownerId &&
    handle.ownerGenerationId === checkpoint.ownerGenerationId &&
    handle.expiresAt > Date.now()
  );
}

export function resolveOwnerForTab(
  catalog: readonly RelayCatalogOwner[],
  tabId: string,
): RelayCatalogOwner | undefined {
  if (tabId === BROWSER_GATEWAY_ASK_AGENT_TAB_ID) {
    return catalog.find(
      (owner) => owner.ownerId === BROWSER_GATEWAY_ASK_AGENT_OWNER_ID,
    );
  }
  return catalog.find((owner) => owner.instanceId === tabId);
}

function selectCurrentTab(
  manager: RelayConnectionManager,
  catalog: readonly RelayCatalogOwner[],
  tabId: string,
): void {
  const owner = resolveOwnerForTab(catalog, tabId);
  if (!owner || owner.status !== "connected") return;
  manager.selectOwner({
    ownerId: owner.ownerId,
    ownerGenerationId: owner.ownerGenerationId,
  });
}

function relayStatusLabel(
  status: "connecting" | "connected" | "offline" | "reconnecting" | "closed",
): string {
  switch (status) {
    case "connected":
      return "Connected (relay)";
    case "offline":
      return "Offline — waiting for network…";
    case "reconnecting":
      return "Relay disconnected — retrying…";
    case "closed":
      return "Disconnected";
    case "connecting":
      return "Connecting to relay…";
  }
}
