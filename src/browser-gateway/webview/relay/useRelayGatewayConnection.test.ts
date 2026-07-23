import { describe, expect, it, vi } from "vitest";

import {
  BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION,
  type BrowserGatewayDetailHandle,
  type BrowserGatewayOwnerCheckpoint,
  type BrowserGatewayOwnerEvent,
  type BrowserGatewayOwnerEventKind,
  type BrowserGatewayOwnerEventPayload,
} from "../../dataPlane/protocol";
import type { GatewaySnapshot } from "../BrowserGatewayApp";
import type { RelayCatalogOwner } from "./RelayOwnerStore";
import { RelaySnapshotProjector } from "./relaySnapshotProjection";
import {
  commitRelayCheckpoint,
  createRelaySourceEventPaintMarker,
  createRelaySourceEventPaintQueue,
  queueAcceptedRelaySourceEventPaint,
  type RelayGatewayConnectionOptions,
  type RelaySourceEventPaintMarker,
  type RelaySourceEventPaintMeasurement,
} from "./useRelayGatewayConnection";

const identity = {
  helperGenerationId: "helper-1",
  ownerId: "owner-1",
  ownerGenerationId: "generation-1",
};

function checkpoint(
  handle: BrowserGatewayDetailHandle,
): BrowserGatewayOwnerCheckpoint {
  return {
    protocolVersion: BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION,
    ...identity,
    checkpointId: "checkpoint-1",
    checkpointSequence: 1,
    emittedAt: 1,
    foreground: {
      sessionId: "session-1",
      title: "Session",
      mode: "code",
      model: "model-1",
      status: "idle",
      streaming: false,
    },
    catalog: {
      projects: [
        {
          projectId: "project-1",
          displayName: "Project",
          availability: "available",
        },
      ],
      sessions: [
        {
          sessionId: "session-1",
          projectId: "project-1",
          title: "Session",
          mode: "code",
          model: "model-1",
          messageCount: 0,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      defaultProjectId: "project-1",
      foregroundSessionId: "session-1",
    },
    transcript: { messages: [], earlierCursor: null, hasEarlier: false },
    ui: {
      interaction: {
        requestId: "approval-1",
        kind: "approval",
        state: "pending",
        summary: "Approval required",
        detailHandle: handle,
      },
      queue: [],
      todos: [],
      operations: [],
    },
    background: [],
    fleet: [],
    diffs: [],
    repository: null,
    theme: { revision: "theme-1", colorScheme: "dark", variables: [] },
    modelCatalogRevision: "models-1",
    capabilities: [],
  };
}

function sourceEvent(
  kind: BrowserGatewayOwnerEventKind,
  payload: BrowserGatewayOwnerEventPayload,
  eventId = `event-${kind}`,
): BrowserGatewayOwnerEvent {
  return {
    protocolVersion: BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION,
    ...identity,
    ownerSequence: 2,
    eventId,
    kind,
    emittedAt: 123,
    payload,
  };
}

function owner(ownerId = identity.ownerId): RelayCatalogOwner {
  return {
    ownerId,
    ownerGenerationId: identity.ownerGenerationId,
    ownerKind: "vscode",
    displayName: ownerId,
    instanceId: ownerId === identity.ownerId ? "instance-1" : "instance-2",
    scope: {
      kind: "workspace",
      workspaceId: ownerId,
      displayName: ownerId,
    },
    status: "connected",
    capabilities: [],
    lastHeartbeatAt: 1,
  };
}

function createHarness(payload: unknown) {
  const content = new TextEncoder().encode(JSON.stringify(payload));
  const handle: BrowserGatewayDetailHandle = {
    ...identity,
    handleId: "interaction-1",
    kind: "interaction",
    byteLength: content.byteLength,
    expiresAt: Date.now() + 60_000,
    mediaType: "application/json; charset=utf-8",
  };
  const commits: GatewaySnapshot[] = [];
  const latest = {
    current: {
      enabled: true,
      selectedTabId: "instance-1",
      selectedTabGeneration: 1,
      commitSnapshot: vi.fn(
        (
          snapshot: GatewaySnapshot,
          _tabId: string,
          _generation: number,
          _sourceEventPaint?: RelaySourceEventPaintMarker,
        ) => {
          commits.push(snapshot);
          return true;
        },
      ),
      setStatus: vi.fn(),
    } satisfies RelayGatewayConnectionOptions,
  };
  const catalog = { current: [owner()] as readonly RelayCatalogOwner[] };
  return { catalog, commits, content, handle, latest };
}

describe("commitRelayCheckpoint", () => {
  it("classifies only the Phase 3 source-event paint categories with priority", () => {
    expect(
      createRelaySourceEventPaintMarker(
        sourceEvent("transcript.message.upserted", {
          message: {
            messageId: "message-1",
            role: "assistant",
            revision: 2,
            createdAt: 1,
            content: { kind: "inline", text: "failed" },
            blocks: [],
            error: { message: "failed", retryable: false },
            finalMarker: {
              status: "completed",
              source: "engine",
            },
          },
        }),
      ),
    ).toEqual({
      correlationId:
        "helper-1/owner-1/generation-1/event-transcript.message.upserted",
      eventId: "event-transcript.message.upserted",
      ownerId: "owner-1",
      ownerGenerationId: "generation-1",
      ownerSequence: 2,
      eventKind: "transcript.message.upserted",
      category: "error",
      latencyClass: "immediate",
      sourceEventAt: 123,
    });
    expect(
      createRelaySourceEventPaintMarker(
        sourceEvent("transcript.message.appended", {
          message: {
            messageId: "message-2",
            role: "assistant",
            revision: 1,
            createdAt: 1,
            content: { kind: "inline", text: "done" },
            blocks: [],
            finalMarker: {
              status: "completed",
              source: "engine",
            },
          },
        }),
      ),
    ).toMatchObject({ category: "completion", latencyClass: "immediate" });
    expect(
      createRelaySourceEventPaintMarker(
        sourceEvent("interaction.updated", {
          interaction: {
            requestId: "approval-1",
            kind: "approval",
            state: "pending",
            summary: "Approve",
          },
        }),
      ),
    ).toMatchObject({ category: "approval", latencyClass: "immediate" });
    expect(
      createRelaySourceEventPaintMarker(
        sourceEvent("interaction.updated", {
          interaction: {
            requestId: "question-1",
            kind: "question",
            state: "pending",
            summary: "Choose",
          },
        }),
      ),
    ).toMatchObject({ category: "question", latencyClass: "immediate" });
    expect(
      createRelaySourceEventPaintMarker(
        sourceEvent("transcript.block.delta", {
          messageId: "message-1",
          blockId: "block-1",
          field: "text",
          delta: "x",
          revision: 2,
        }),
      ),
    ).toMatchObject({ category: "text", latencyClass: "text_progress" });
    expect(
      createRelaySourceEventPaintMarker(
        sourceEvent("queue.updated", { queue: [] }),
      ),
    ).toMatchObject({ category: "progress", latencyClass: "text_progress" });
    expect(
      createRelaySourceEventPaintMarker({
        ...sourceEvent("queue.updated", { queue: [] }),
        ownerId: "owner/with/slashes",
        eventId: "event/with/slashes",
      }),
    ).toMatchObject({
      correlationId:
        "helper-1/owner%2Fwith%2Fslashes/generation-1/event%2Fwith%2Fslashes",
    });
    expect(
      createRelaySourceEventPaintMarker(
        sourceEvent("repository.updated", { repository: null }),
      ),
    ).toBeUndefined();
  });

  it("records accepted coalesced markers only after paint without clamping", () => {
    const scheduled: Array<() => void> = [];
    const measurements: RelaySourceEventPaintMeasurement[] = [];
    const queue = createRelaySourceEventPaintQueue({
      scheduleAfterNextPaint: (callback) => scheduled.push(callback),
      record: (measurement) => measurements.push(measurement),
      now: () => 100,
    });
    const first: RelaySourceEventPaintMarker = {
      correlationId: "first",
      eventId: "event-1",
      ownerId: "owner-1",
      ownerGenerationId: "generation-1",
      ownerSequence: 1,
      eventKind: "transcript.block.delta",
      category: "text",
      latencyClass: "text_progress",
      sourceEventAt: 90,
    };
    const second: RelaySourceEventPaintMarker = {
      correlationId: "second",
      eventId: "event-2",
      ownerId: "owner-1",
      ownerGenerationId: "generation-1",
      ownerSequence: 2,
      eventKind: "queue.updated",
      category: "progress",
      latencyClass: "text_progress",
      sourceEventAt: 110,
    };

    queueAcceptedRelaySourceEventPaint(false, first, queue);
    queueAcceptedRelaySourceEventPaint(true, first, queue);
    queueAcceptedRelaySourceEventPaint(true, second, queue);

    expect(scheduled).toHaveLength(1);
    expect(measurements).toEqual([]);
    scheduled[0]!();
    expect(measurements).toEqual([
      { ...first, paintedAt: 100, elapsedMs: 10 },
      { ...second, paintedAt: 100, elapsedMs: -10 },
    ]);
  });

  it("clears stale interaction UI before hydrating the identity-bound detail", async () => {
    const payload = {
      approval: { id: "approval-1", kind: "command", command: "npm test" },
      question: {
        id: "question-1",
        context: "Continue?",
        questions: [{ id: "continue", type: "yes_no", question: "Continue?" }],
      },
      questionProgress: {
        id: "question-1",
        step: 0,
        answers: { continue: true },
        notes: {},
        origin: "browser",
      },
      formElicitation: null,
      urlElicitation: null,
    };
    const harness = createHarness(payload);
    const fetch = vi.fn(
      async (_input: RequestInfo | URL) =>
        new Response(harness.content, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );

    const marker: RelaySourceEventPaintMarker = {
      correlationId: "interaction-event",
      eventId: "event-approval",
      ownerId: "owner-1",
      ownerGenerationId: "generation-1",
      ownerSequence: 2,
      eventKind: "interaction.updated",
      category: "approval",
      latencyClass: "immediate",
      sourceEventAt: 123,
    };
    await commitRelayCheckpoint({
      checkpoint: checkpoint(harness.handle),
      ...identity,
      sourceEventPaint: marker,
      projectors: new Map<string, RelaySnapshotProjector>(),
      interactionCache: new Map(),
      fetch: fetch as unknown as typeof globalThis.fetch,
      isCurrent: () => true,
      latest: harness.latest,
      catalog: harness.catalog,
    });

    expect(harness.commits).toHaveLength(2);
    expect(harness.commits[0]?.ui.approval).toBeNull();
    expect(harness.commits[1]?.ui.approval).toEqual(payload.approval);
    expect(harness.commits[1]?.ui.question).toEqual(payload.question);
    expect(harness.commits[1]?.ui.questionProgress).toEqual(
      payload.questionProgress,
    );
    expect(
      harness.latest.current.commitSnapshot.mock.calls[0]?.[3],
    ).toBeUndefined();
    expect(harness.latest.current.commitSnapshot.mock.calls[1]?.[3]).toBe(
      marker,
    );
    expect(String(fetch.mock.calls[0]?.[0])).toContain(
      "ownerGenerationId=generation-1",
    );
  });

  it("does not commit an interaction detail that expires during hydration", async () => {
    const payload = {
      approval: { id: "approval-1", kind: "command", command: "npm test" },
      question: null,
      questionProgress: null,
      formElicitation: null,
      urlElicitation: null,
    };
    const harness = createHarness(payload);
    let resolveFetch!: (response: Response) => void;
    const fetch = vi.fn(
      (_input: RequestInfo | URL) =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    const pending = commitRelayCheckpoint({
      checkpoint: checkpoint(harness.handle),
      ...identity,
      projectors: new Map<string, RelaySnapshotProjector>(),
      interactionCache: new Map(),
      fetch: fetch as unknown as typeof globalThis.fetch,
      isCurrent: () => true,
      latest: harness.latest,
      catalog: harness.catalog,
    });

    harness.handle.expiresAt = Date.now() - 1;
    resolveFetch(new Response(harness.content, { status: 200 }));
    await pending;

    expect(harness.commits).toHaveLength(1);
    expect(harness.commits[0]?.ui.approval).toBeNull();
    expect(harness.latest.current.setStatus).toHaveBeenCalledWith(
      "Relay interaction unavailable — reconnecting…",
    );
  });

  it("does not commit a hydrated interaction after the active tab changes", async () => {
    const payload = {
      approval: { id: "approval-1", kind: "command", command: "npm test" },
      question: null,
      questionProgress: null,
      formElicitation: null,
      urlElicitation: null,
    };
    const harness = createHarness(payload);
    let resolveFetch!: (response: Response) => void;
    const fetch = vi.fn(
      (_input: RequestInfo | URL) =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    const marker: RelaySourceEventPaintMarker = {
      correlationId: "superseded-interaction",
      eventId: "event-superseded-approval",
      ownerId: "owner-1",
      ownerGenerationId: "generation-1",
      ownerSequence: 2,
      eventKind: "interaction.updated",
      category: "approval",
      latencyClass: "immediate",
      sourceEventAt: 123,
    };
    const pending = commitRelayCheckpoint({
      checkpoint: checkpoint(harness.handle),
      ...identity,
      sourceEventPaint: marker,
      projectors: new Map<string, RelaySnapshotProjector>(),
      interactionCache: new Map(),
      fetch: fetch as unknown as typeof globalThis.fetch,
      isCurrent: () => true,
      latest: harness.latest,
      catalog: harness.catalog,
    });

    harness.latest.current.selectedTabId = "instance-2";
    harness.catalog.current = [owner(), owner("owner-2")];
    resolveFetch(new Response(harness.content, { status: 200 }));
    await pending;

    expect(harness.commits).toHaveLength(1);
    expect(harness.commits[0]?.ui.approval).toBeNull();
    expect(
      harness.latest.current.commitSnapshot.mock.calls[0]?.[3],
    ).toBeUndefined();
  });
});
