import { describe, expect, it } from "vitest";

import {
  BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION,
  type BrowserGatewayOwnerCheckpoint,
  type BrowserGatewayOwnerEvent,
} from "../../dataPlane/protocol";
import { RelayOwnerStore } from "./RelayOwnerStore";

const helperGenerationId = "helper-1";
const ownerId = "owner-1";
const ownerGenerationId = "generation-1";

function checkpoint(
  overrides: Partial<BrowserGatewayOwnerCheckpoint> = {},
): BrowserGatewayOwnerCheckpoint {
  return {
    protocolVersion: BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION,
    helperGenerationId,
    ownerId,
    ownerGenerationId,
    checkpointId: "checkpoint-1",
    checkpointSequence: 1,
    emittedAt: 1,
    foreground: null,
    catalog: {
      projects: [],
      sessions: [],
      defaultProjectId: null,
      foregroundSessionId: null,
    },
    transcript: {
      messages: [
        {
          messageId: "message-1",
          role: "assistant",
          revision: 1,
          createdAt: 1,
          content: { kind: "inline", text: "first" },
          blocks: [
            {
              type: "text",
              blockId: "block-1",
              text: { kind: "inline", text: "first" },
            },
          ],
        },
        {
          messageId: "message-2",
          role: "user",
          revision: 1,
          createdAt: 2,
          content: { kind: "inline", text: "second" },
          blocks: [],
        },
      ],
      earlierCursor: null,
      hasEarlier: false,
    },
    ui: { interaction: null, queue: [], todos: [], operations: [] },
    background: [],
    fleet: [],
    diffs: [],
    repository: null,
    theme: { revision: "theme-1", colorScheme: "dark", variables: [] },
    modelCatalogRevision: "models-1",
    capabilities: [],
    ...overrides,
  };
}

function event(
  sequence: number,
  kind: BrowserGatewayOwnerEvent["kind"],
  payload: BrowserGatewayOwnerEvent["payload"],
  overrides: Partial<BrowserGatewayOwnerEvent> = {},
): BrowserGatewayOwnerEvent {
  return {
    protocolVersion: BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION,
    helperGenerationId,
    ownerId,
    ownerGenerationId,
    ownerSequence: sequence,
    eventId: `event-${sequence}`,
    kind,
    emittedAt: sequence,
    payload,
    ...overrides,
  };
}

describe("RelayOwnerStore", () => {
  it("applies contiguous events, ignores duplicates, and preserves untouched identity", () => {
    const store = new RelayOwnerStore();
    const initial = checkpoint();
    expect(
      store.applyCheckpoint(helperGenerationId, {
        kind: "checkpoint",
        relaySequence: 10,
        ownerSequence: 1,
        checkpoint: initial,
      }),
    ).toMatchObject({ status: "applied" });

    const firstMessage = initial.transcript.messages[0];
    const secondMessage = initial.transcript.messages[1];
    const applied = store.applyEvent(helperGenerationId, {
      kind: "event",
      relaySequence: 12,
      ownerSequence: 2,
      event: event(2, "transcript.block.delta", {
        messageId: "message-1",
        blockId: "block-1",
        field: "text",
        delta: " update",
        revision: 2,
      }),
    });
    expect(applied.status).toBe("applied");
    const current = store.getCheckpoint(ownerId, ownerGenerationId)!;
    expect(current.transcript.messages[0]).not.toBe(firstMessage);
    expect(current.transcript.messages[1]).toBe(secondMessage);
    expect(current.transcript.messages[0]?.blocks[0]).toMatchObject({
      text: { kind: "inline", text: "first update" },
    });

    expect(
      store.applyEvent(helperGenerationId, {
        kind: "event",
        relaySequence: 12,
        ownerSequence: 2,
        event: event(2, "transcript.block.delta", {
          messageId: "message-1",
          blockId: "block-1",
          field: "text",
          delta: " duplicated",
          revision: 2,
        }),
      }),
    ).toMatchObject({ status: "duplicate", checkpoint: current });
  });

  it("accepts ordered transcript updates when stable-hash revisions decrease", () => {
    const store = new RelayOwnerStore();
    store.applyCheckpoint(helperGenerationId, {
      kind: "checkpoint",
      relaySequence: 1,
      ownerSequence: 1,
      checkpoint: checkpoint({
        transcript: {
          messages: [
            {
              messageId: "message-1",
              role: "assistant",
              revision: 100,
              createdAt: 1,
              content: { kind: "inline", text: "first" },
              blocks: [
                {
                  type: "text",
                  blockId: "block-1",
                  text: { kind: "inline", text: "first" },
                },
              ],
            },
          ],
          earlierCursor: null,
          hasEarlier: false,
        },
      }),
    });

    expect(
      store.applyEvent(helperGenerationId, {
        kind: "event",
        relaySequence: 2,
        ownerSequence: 2,
        event: event(2, "transcript.block.delta", {
          messageId: "message-1",
          blockId: "block-1",
          field: "text",
          delta: " update",
          revision: 50,
        }),
      }),
    ).toMatchObject({ status: "applied" });
    expect(
      store.applyEvent(helperGenerationId, {
        kind: "event",
        relaySequence: 3,
        ownerSequence: 3,
        event: event(3, "transcript.message.upserted", {
          message: {
            messageId: "message-1",
            role: "assistant",
            revision: 25,
            createdAt: 1,
            content: { kind: "inline", text: "failed" },
            blocks: [],
            error: { message: "failed", retryable: false },
          },
        }),
      }),
    ).toMatchObject({ status: "applied" });
    expect(
      store.getCheckpoint(ownerId, ownerGenerationId)?.transcript.messages[0],
    ).toMatchObject({
      revision: 25,
      error: { message: "failed" },
    });
  });

  it("rejects relay cursor rollback even when owner sequence advances", () => {
    const store = new RelayOwnerStore();
    store.applyCheckpoint(helperGenerationId, {
      kind: "checkpoint",
      relaySequence: 10,
      ownerSequence: 1,
      checkpoint: checkpoint(),
    });

    expect(
      store.applyEvent(helperGenerationId, {
        kind: "event",
        relaySequence: 9,
        ownerSequence: 2,
        event: event(2, "foreground.control.updated", { foreground: null }),
      }),
    ).toEqual({
      status: "checkpoint_required",
      reason: "invalid_owner_state",
    });
  });

  it("requires a checkpoint for gaps, generation changes, and invalid deltas", () => {
    const store = new RelayOwnerStore();
    store.applyCheckpoint(helperGenerationId, {
      kind: "checkpoint",
      relaySequence: 1,
      ownerSequence: 1,
      checkpoint: checkpoint(),
    });

    expect(
      store.applyEvent(helperGenerationId, {
        kind: "event",
        relaySequence: 3,
        ownerSequence: 3,
        event: event(3, "foreground.control.updated", { foreground: null }),
      }),
    ).toEqual({ status: "checkpoint_required", reason: "sequence_gap" });
    expect(
      store.applyEvent(helperGenerationId, {
        kind: "event",
        relaySequence: 2,
        ownerSequence: 2,
        event: event(2, "transcript.block.delta", {
          messageId: "missing",
          blockId: "missing",
          field: "text",
          delta: "x",
          revision: 2,
        }),
      }),
    ).toEqual({
      status: "checkpoint_required",
      reason: "invalid_owner_state",
    });
    expect(
      store.applyEvent("helper-2", {
        kind: "event",
        relaySequence: 1,
        ownerSequence: 2,
        event: event(
          2,
          "foreground.control.updated",
          { foreground: null },
          { helperGenerationId: "helper-2" },
        ),
      }),
    ).toEqual({
      status: "checkpoint_required",
      reason: "helper_generation_changed",
    });
    expect(store.getCheckpoint(ownerId, ownerGenerationId)).toBeNull();
  });

  it("evicts least-recently-used owner generations within owner and byte bounds", () => {
    const store = new RelayOwnerStore({
      maximumOwners: 2,
      maximumEstimatedBytes: 1024 * 1024,
      now: () => 1,
    });
    for (let index = 1; index <= 3; index += 1) {
      const id = `owner-${index}`;
      store.applyCheckpoint(helperGenerationId, {
        kind: "checkpoint",
        relaySequence: index,
        ownerSequence: 1,
        checkpoint: checkpoint({
          ownerId: id,
          ownerGenerationId: `generation-${index}`,
        }),
      });
      if (index === 2) store.getCheckpoint("owner-1", "generation-1");
    }

    expect(store.getCheckpoint("owner-1", "generation-1")).not.toBeNull();
    expect(store.getCheckpoint("owner-2", "generation-2")).toBeNull();
    expect(store.getCheckpoint("owner-3", "generation-3")).not.toBeNull();
  });

  it("builds a qualified cursor from the latest applied relay sequence", () => {
    const store = new RelayOwnerStore();
    store.applyCheckpoint(helperGenerationId, {
      kind: "checkpoint",
      relaySequence: 42,
      ownerSequence: 1,
      checkpoint: checkpoint({ ownerId: "owner/with/slash" }),
    });
    expect(store.getCursor("owner/with/slash", ownerGenerationId)).toBe(
      `${helperGenerationId}/owner%2Fwith%2Fslash/${ownerGenerationId}/42`,
    );
  });
});
