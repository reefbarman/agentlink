import { describe, expect, it } from "vitest";

import { BrowserGatewayCoreOwnerRegistry } from "../coreOwnerRegistry.js";
import {
  BROWSER_GATEWAY_COMMAND_IDEMPOTENCY,
  BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION,
  type BrowserGatewayOwnerCheckpoint,
  type BrowserGatewayOwnerEvent,
  type BrowserGatewayOwnerPublicationBatch,
} from "../dataPlane/protocol.js";
import {
  ControllableSseRequest,
  ControllableSseResponse,
  createDeferred,
} from "../testing/SseFaultPeer.js";
import type { HelperLifecycleCoordinator } from "./HelperLifecycleCoordinator.js";
import { BrowserGatewayDataPlaneRoutes } from "./dataPlaneRoutes.js";

const identity = {
  helperGenerationId: "helper-generation-1",
  ownerId: "owner-1",
  ownerGenerationId: "owner-generation-1",
};

function checkpoint(sequence = 0): BrowserGatewayOwnerCheckpoint {
  return {
    protocolVersion: BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION,
    ...identity,
    checkpointId: `checkpoint-${sequence}`,
    checkpointSequence: sequence,
    emittedAt: 1_000,
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

function event(sequence: number): BrowserGatewayOwnerEvent {
  return {
    protocolVersion: BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION,
    ...identity,
    ownerSequence: sequence,
    eventId: `event-${sequence}`,
    kind: "foreground.control.updated",
    emittedAt: 1_000 + sequence,
    payload: { foreground: null },
  };
}

function batch(
  id: string,
  events: BrowserGatewayOwnerEvent[],
  includedCheckpoint: BrowserGatewayOwnerCheckpoint | null = null,
): BrowserGatewayOwnerPublicationBatch {
  const sequence = includedCheckpoint?.checkpointSequence ?? 0;
  return {
    protocolVersion: BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION,
    ...identity,
    batchId: id,
    firstSequence: events[0]?.ownerSequence ?? sequence,
    lastSequence: events.at(-1)?.ownerSequence ?? sequence,
    checkpoint: includedCheckpoint,
    events,
  };
}

function makeRoutes(
  onPublication: NonNullable<
    ConstructorParameters<
      typeof BrowserGatewayDataPlaneRoutes
    >[0]["onPublication"]
  >,
): BrowserGatewayDataPlaneRoutes {
  const registry = new BrowserGatewayCoreOwnerRegistry({
    heartbeatTtlMs: 30_000,
  });
  registry.register({
    ownerId: identity.ownerId,
    ownerKind: "vscode",
    displayName: "Owner",
    scope: {
      kind: "workspace",
      workspaceId: "workspace-1",
      displayName: "Workspace",
    },
    ownerGenerationId: identity.ownerGenerationId,
    now: 1_000,
  });
  return new BrowserGatewayDataPlaneRoutes({
    helperGenerationId: identity.helperGenerationId,
    ownerRegistry: registry,
    lifecycle: {
      trackStream: () => () => undefined,
    } as unknown as HelperLifecycleCoordinator,
    now: () => 1_100,
    commandKeepaliveIntervalMs: 0,
    onPublication,
  });
}

describe("BrowserGatewayDataPlaneRoutes transactional ingest", () => {
  it("does not advance the cursor when the publication consumer fails", async () => {
    let attempts = 0;
    const routes = makeRoutes(() => {
      attempts += 1;
      if (attempts === 1) throw new Error("relay_store_failed");
    });
    const initial = batch("batch-1", [event(1)], checkpoint());

    await expect(routes.ingestPublication(initial)).rejects.toThrow(
      "relay_store_failed",
    );
    await expect(routes.ingestPublication(initial)).resolves.toMatchObject({
      cursor: 1,
      duplicate: false,
    });
    await expect(routes.ingestPublication(initial)).resolves.toMatchObject({
      cursor: 1,
      duplicate: true,
    });
    expect(attempts).toBe(2);
  });

  it("serializes concurrent publications for one owner generation", async () => {
    const firstEntered = createDeferred<void>();
    const releaseFirst = createDeferred<void>();
    const applied: string[] = [];
    const routes = makeRoutes(async (publication) => {
      applied.push(publication.batchId);
      if (publication.batchId === "batch-1") {
        firstEntered.resolve();
        await releaseFirst.promise;
      }
    });

    const first = routes.ingestPublication(
      batch("batch-1", [event(1)], checkpoint()),
    );
    await firstEntered.promise;
    const second = routes.ingestPublication(batch("batch-2", [event(2)]));
    await Promise.resolve();
    expect(applied).toEqual(["batch-1"]);

    releaseFirst.resolve();
    await expect(first).resolves.toMatchObject({ cursor: 1 });
    await expect(second).resolves.toMatchObject({ cursor: 2 });
    expect(applied).toEqual(["batch-1", "batch-2"]);
  });

  it("retains demand and checkpoint controls until the owner stream connects", async () => {
    const routes = makeRoutes(() => undefined);
    expect(
      routes.publishControl({
        protocolVersion: BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION,
        ...identity,
        kind: "demand.changed",
        emittedAt: 1_000,
        payload: { subscriberCount: 2 },
      }),
    ).toBe(false);
    expect(
      routes.publishControl({
        protocolVersion: BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION,
        ...identity,
        kind: "checkpoint.requested",
        emittedAt: 1_001,
        payload: { reason: "checkpoint_required", latestSequence: 0 },
      }),
    ).toBe(false);

    const request = new ControllableSseRequest();
    const response = new ControllableSseResponse();
    await routes.handle(
      "commands",
      request.asIncomingMessage(),
      response.asServerResponse(),
      new URL(
        `http://127.0.0.1/internal/data-plane/commands?${new URLSearchParams(identity)}`,
      ),
    );
    const text = response.writes.join("");
    expect(text).toContain('"subscriberCount":2');
    expect(text).toContain('"kind":"checkpoint.requested"');
    routes.close();
  });

  it("supersedes an old command stream without duplicate delivery", async () => {
    const routes = makeRoutes(() => undefined);
    const firstRequest = new ControllableSseRequest();
    const firstResponse = new ControllableSseResponse();
    const secondRequest = new ControllableSseRequest();
    const secondResponse = new ControllableSseResponse();
    const requestUrl = new URL(
      `http://127.0.0.1/internal/data-plane/commands?${new URLSearchParams(identity)}`,
    );

    await routes.handle(
      "commands",
      firstRequest.asIncomingMessage(),
      firstResponse.asServerResponse(),
      requestUrl,
    );
    await routes.handle(
      "commands",
      secondRequest.asIncomingMessage(),
      secondResponse.asServerResponse(),
      requestUrl,
    );
    expect(firstResponse.endCount).toBe(1);

    expect(
      routes.publishCommand({
        protocolVersion: BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION,
        ...identity,
        operationId: "operation-1",
        emittedAt: 1_000,
        deadlineAt: 2_000,
        deadlineClass: "default",
        idempotency: BROWSER_GATEWAY_COMMAND_IDEMPOTENCY["session.select"],
        command: { kind: "session.select", sessionId: "session-1" },
      }),
    ).toBe(true);
    expect(firstResponse.writes.join("")).not.toContain("operation-1");
    expect(secondResponse.writes.join("")).toContain("operation-1");

    firstRequest.close();
    expect(
      routes.publishCommand({
        protocolVersion: BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION,
        ...identity,
        operationId: "operation-2",
        emittedAt: 1_000,
        deadlineAt: 2_000,
        deadlineClass: "default",
        idempotency: BROWSER_GATEWAY_COMMAND_IDEMPOTENCY["session.stop"],
        command: { kind: "session.stop", sessionId: "session-1" },
      }),
    ).toBe(true);
    expect(secondResponse.writes.join("")).toContain("operation-2");
    routes.close();
  });

  it("deduplicates identical commands and rejects operation ID conflicts", () => {
    const routes = makeRoutes(() => undefined);
    const first = {
      protocolVersion: BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION,
      ...identity,
      operationId: "operation-1",
      emittedAt: 1_000,
      deadlineAt: 2_000,
      deadlineClass: "default" as const,
      idempotency: BROWSER_GATEWAY_COMMAND_IDEMPOTENCY["session.select"],
      command: { kind: "session.select" as const, sessionId: "session-1" },
    };
    expect(routes.publishCommand(first)).toBe(true);
    expect(routes.publishCommand(first)).toBe(true);
    expect(() =>
      routes.publishCommand({
        ...first,
        command: { kind: "session.stop", sessionId: "session-1" },
      }),
    ).toThrow("operation_conflict");
    routes.close();
  });

  it("coalesces checkpoint requests until a checkpoint commits", async () => {
    const routes = makeRoutes(() => undefined);
    const request = new ControllableSseRequest();
    const response = new ControllableSseResponse();
    const requestUrl = new URL(
      `http://127.0.0.1/internal/data-plane/commands?${new URLSearchParams(identity)}`,
    );
    await routes.handle(
      "commands",
      request.asIncomingMessage(),
      response.asServerResponse(),
      requestUrl,
    );

    const missingCheckpoint = batch("missing", [event(1)]);
    await expect(routes.ingestPublication(missingCheckpoint)).rejects.toThrow(
      "checkpoint_required",
    );
    await expect(routes.ingestPublication(missingCheckpoint)).rejects.toThrow(
      "checkpoint_required",
    );
    expect(
      response.writes.filter((write) =>
        write.includes('"kind":"checkpoint.requested"'),
      ),
    ).toHaveLength(1);

    await routes.ingestPublication(batch("checkpoint", [], checkpoint()));
    await expect(
      routes.ingestPublication(missingCheckpoint),
    ).resolves.toMatchObject({
      cursor: 1,
    });
    await expect(
      routes.ingestPublication(batch("gap", [event(3)])),
    ).rejects.toThrow("sequence_gap");
    expect(
      response.writes.filter((write) =>
        write.includes('"kind":"checkpoint.requested"'),
      ),
    ).toHaveLength(2);
    routes.close();
  });
});
