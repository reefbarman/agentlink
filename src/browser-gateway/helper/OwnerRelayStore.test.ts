import { describe, expect, it, vi } from "vitest";

import {
  BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION,
  type BrowserGatewayOwnerCheckpoint,
  type BrowserGatewayOwnerEvent,
  type BrowserGatewayOwnerPublicationBatch,
} from "../dataPlane/protocol.js";
import { OwnerRelayStore } from "./OwnerRelayStore.js";

const helperGenerationId = "helper-1";
const ownerId = "owner-1";
const ownerGenerationId = "owner-generation-1";

function checkpoint(
  sequence: number,
  generation = ownerGenerationId,
  checkpointOwnerId = ownerId,
): BrowserGatewayOwnerCheckpoint {
  return {
    protocolVersion: BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION,
    helperGenerationId,
    ownerId: checkpointOwnerId,
    ownerGenerationId: generation,
    checkpointId: `checkpoint-${sequence}`,
    checkpointSequence: sequence,
    emittedAt: 1_000 + sequence,
    foreground: null,
    catalog: {
      projects: [],
      sessions: [],
      defaultProjectId: null,
      foregroundSessionId: null,
    },
    transcript: { messages: [], earlierCursor: null, hasEarlier: false },
    ui: { interaction: null, queue: [], todos: [], operations: [] },
    background: [],
    fleet: [],
    diffs: [],
    repository: null,
    theme: { revision: "theme-1", colorScheme: "dark", variables: [] },
    modelCatalogRevision: "models-1",
    capabilities: [],
  };
}

function event(
  sequence: number,
  generation = ownerGenerationId,
): BrowserGatewayOwnerEvent {
  return {
    protocolVersion: BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION,
    helperGenerationId,
    ownerId,
    ownerGenerationId: generation,
    ownerSequence: sequence,
    eventId: `event-${sequence}`,
    kind: "foreground.control.updated",
    emittedAt: 1_000 + sequence,
    payload: { foreground: null },
  };
}

function batch(params: {
  checkpoint?: BrowserGatewayOwnerCheckpoint | null;
  events?: BrowserGatewayOwnerEvent[];
  generation?: string;
  ownerId?: string;
}): BrowserGatewayOwnerPublicationBatch {
  const events = params.events ?? [];
  const installed = params.checkpoint ?? null;
  const generation = params.generation ?? ownerGenerationId;
  const batchOwnerId = params.ownerId ?? ownerId;
  const firstSequence =
    events[0]?.ownerSequence ?? installed?.checkpointSequence ?? 0;
  const lastSequence =
    events.at(-1)?.ownerSequence ?? installed?.checkpointSequence ?? 0;
  return {
    protocolVersion: BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION,
    helperGenerationId,
    ownerId: batchOwnerId,
    ownerGenerationId: generation,
    batchId: `batch-${batchOwnerId}-${generation}-${firstSequence}-${lastSequence}`,
    firstSequence,
    lastSequence,
    checkpoint: installed,
    events,
  };
}

describe("OwnerRelayStore", () => {
  it("stores checkpoints, emits globally ordered relay records, and replays after a cursor", () => {
    const store = new OwnerRelayStore({ helperGenerationId, now: () => 1_000 });
    const listener = vi.fn();
    store.subscribe(listener);

    const first = store.ingestPublication(
      batch({ checkpoint: checkpoint(0), events: [event(1), event(2)] }),
    );
    const second = store.ingestPublication(batch({ events: [event(3)] }));

    expect(first.records.map((record) => record.relaySequence)).toEqual([
      1, 2, 3,
    ]);
    expect(second.records.map((record) => record.relaySequence)).toEqual([4]);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(store.replay(ownerId, ownerGenerationId, 2)).toMatchObject({
      kind: "replay",
      records: [
        expect.objectContaining({ ownerSequence: 2 }),
        expect.objectContaining({ ownerSequence: 3 }),
      ],
    });
  });

  it("compacts replay against a dominating checkpoint", () => {
    const store = new OwnerRelayStore({ helperGenerationId, now: () => 1_000 });
    store.ingestPublication(
      batch({ checkpoint: checkpoint(0), events: [event(1), event(2)] }),
    );
    store.ingestPublication(
      batch({ checkpoint: checkpoint(2), events: [event(3)] }),
    );

    const replay = store.replay(ownerId, ownerGenerationId, 0);
    expect(replay).toMatchObject({
      kind: "reset",
      checkpoint: expect.objectContaining({ ownerSequence: 2 }),
      records: [expect.objectContaining({ ownerSequence: 3 })],
    });
  });

  it("returns checkpoint resets for stale cursors after count and age pruning", () => {
    let now = 1_000;
    const store = new OwnerRelayStore({
      helperGenerationId,
      now: () => now,
      retainedReplayEventsPerOwnerGeneration: 1,
      retainedReplayAgeMs: 10,
    });
    store.ingestPublication(
      batch({ checkpoint: checkpoint(0), events: [event(1), event(2)] }),
    );
    expect(store.replay(ownerId, ownerGenerationId, 1)).toMatchObject({
      kind: "reset",
      reason: "stale_replay_cursor",
    });

    now = 2_000;
    expect(store.replay(ownerId, ownerGenerationId, 2)).toMatchObject({
      kind: "reset",
      reason: "stale_replay_cursor",
    });
  });

  it("invalidates only prior replay and detail state for the registered owner", () => {
    const store = new OwnerRelayStore({ helperGenerationId, now: () => 1_000 });
    const nextGeneration = "owner-generation-2";
    const otherOwnerId = "owner-2";
    const otherGeneration = "other-owner-generation-1";
    store.ingestPublication(batch({ checkpoint: checkpoint(0) }));
    store.ingestPublication(
      batch({
        generation: nextGeneration,
        checkpoint: checkpoint(0, nextGeneration),
      }),
    );
    store.ingestPublication(
      batch({
        ownerId: otherOwnerId,
        generation: otherGeneration,
        checkpoint: checkpoint(0, otherGeneration, otherOwnerId),
      }),
    );
    const detail = {
      helperGenerationId,
      ownerId,
      ownerGenerationId,
      handleId: "old-owner-detail",
      kind: "message" as const,
      byteLength: 3,
      expiresAt: 2_000,
    };
    const currentDetail = {
      ...detail,
      ownerGenerationId: nextGeneration,
      handleId: "current-owner-detail",
    };
    const otherDetail = {
      ...detail,
      ownerId: otherOwnerId,
      ownerGenerationId: otherGeneration,
      handleId: "other-owner-detail",
    };
    store.putDetail(detail, Buffer.from("old"));
    store.putDetail(currentDetail, Buffer.from("new"));
    store.putDetail(otherDetail, Buffer.from("two"));

    store.ownerRegistered(ownerId, nextGeneration);

    expect(store.getCheckpoint(ownerId, ownerGenerationId)).toBeNull();
    expect(store.getCheckpoint(ownerId, nextGeneration)).not.toBeNull();
    expect(store.getCheckpoint(otherOwnerId, otherGeneration)).not.toBeNull();
    expect(
      store.getDetail({
        handleId: detail.handleId,
        ownerId,
        ownerGenerationId,
      }),
    ).toBeNull();
    expect(
      store.getDetail({
        handleId: currentDetail.handleId,
        ownerId,
        ownerGenerationId: nextGeneration,
      })?.content,
    ).toEqual(Buffer.from("new"));
    expect(
      store.getDetail({
        handleId: otherDetail.handleId,
        ownerId: otherOwnerId,
        ownerGenerationId: otherGeneration,
      })?.content,
    ).toEqual(Buffer.from("two"));
  });

  it("includes checkpoints in the aggregate relay budget", () => {
    const store = new OwnerRelayStore({
      helperGenerationId,
      now: () => 1_000,
      aggregateHelperReplayBytes: 1,
    });
    store.ingestPublication(batch({ checkpoint: checkpoint(0) }));
    expect(store.getCheckpoint(ownerId, ownerGenerationId)).toBeNull();
  });

  it("allows larger session details without relaxing ordinary detail limits", () => {
    const store = new OwnerRelayStore({
      helperGenerationId,
      now: () => 1_000,
      authenticatedDetailResponseBytes: 4,
      authenticatedSessionDetailResponseBytes: 8,
      authenticatedDetailStoreBytes: 8,
    });
    const handle = {
      helperGenerationId,
      ownerId,
      ownerGenerationId,
      handleId: "session-detail",
      kind: "session" as const,
      byteLength: 8,
      expiresAt: 2_000,
      mediaType: "application/json; charset=utf-8",
    };

    store.putDetail(handle, Buffer.from("12345678"));
    expect(
      store.getDetail({
        handleId: handle.handleId,
        ownerId,
        ownerGenerationId,
      })?.content,
    ).toEqual(Buffer.from("12345678"));
    expect(() =>
      store.putDetail(
        { ...handle, handleId: "message-detail", kind: "message" },
        Buffer.from("12345678"),
      ),
    ).toThrow("browser_gateway_relay_detail_size_mismatch");
    expect(() =>
      store.putDetail(
        { ...handle, handleId: "oversized-session", byteLength: 9 },
        Buffer.from("123456789"),
      ),
    ).toThrow("browser_gateway_relay_detail_size_mismatch");
  });

  it("binds bounded details to helper and owner generations and expires them", () => {
    let now = 1_000;
    const store = new OwnerRelayStore({
      helperGenerationId,
      now: () => now,
      authenticatedDetailResponseBytes: 16,
      authenticatedDetailStoreBytes: 16,
    });
    const handle = {
      helperGenerationId,
      ownerId,
      ownerGenerationId,
      handleId: "detail-1",
      kind: "message" as const,
      byteLength: 5,
      expiresAt: 2_000,
      mediaType: "text/plain",
    };
    store.putDetail(handle, Buffer.from("hello"));

    expect(
      store.getDetail({
        handleId: handle.handleId,
        ownerId,
        ownerGenerationId: "wrong-generation",
      }),
    ).toBeNull();
    expect(
      store.getDetail({
        handleId: handle.handleId,
        ownerId,
        ownerGenerationId,
      }),
    ).toMatchObject({ content: Buffer.from("hello") });

    const otherOwnerHandle = {
      ...handle,
      ownerId: "owner-2",
      ownerGenerationId: "owner-generation-2",
      byteLength: 5,
      expiresAt: 3_000,
    };
    store.putDetail(handle, Buffer.from("first"));
    store.putDetail(otherOwnerHandle, Buffer.from("other"));
    expect(
      store.getDetail({
        handleId: handle.handleId,
        ownerId,
        ownerGenerationId,
      })?.content,
    ).toEqual(Buffer.from("first"));
    expect(
      store.getDetail({
        handleId: otherOwnerHandle.handleId,
        ownerId: otherOwnerHandle.ownerId,
        ownerGenerationId: otherOwnerHandle.ownerGenerationId,
      })?.content,
    ).toEqual(Buffer.from("other"));

    now = 2_001;
    expect(
      store.getDetail({
        handleId: handle.handleId,
        ownerId,
        ownerGenerationId,
      }),
    ).toBeNull();
  });
});
