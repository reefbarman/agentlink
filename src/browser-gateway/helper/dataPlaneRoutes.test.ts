import * as http from "http";

import { afterEach, describe, expect, it } from "vitest";

import { BrowserGatewayCoreOwnerRegistry } from "../coreOwnerRegistry.js";
import { BROWSER_GATEWAY_DATA_PLANE_LIMITS } from "../dataPlane/limits.js";
import {
  BROWSER_GATEWAY_COMMAND_IDEMPOTENCY,
  BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION,
  type BrowserGatewayDetailHandle,
  type BrowserGatewayOwnerCheckpoint,
  type BrowserGatewayOwnerCommand,
  type BrowserGatewayOwnerEvent,
  type BrowserGatewayOwnerPublicationBatch,
} from "../dataPlane/protocol.js";
import { HelperLifecycleCoordinator } from "./HelperLifecycleCoordinator.js";
import { BrowserGatewayDataPlaneRoutes } from "./dataPlaneRoutes.js";

const helperGenerationId = "helper-generation-1";
const ownerId = "owner-1";
const ownerGenerationId = "owner-generation-1";
const servers: http.Server[] = [];

function checkpoint(sequence = 0): BrowserGatewayOwnerCheckpoint {
  return {
    protocolVersion: BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION,
    helperGenerationId,
    ownerId,
    ownerGenerationId,
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
    helperGenerationId,
    ownerId,
    ownerGenerationId,
    ownerSequence: sequence,
    eventId: `event-${sequence}`,
    kind: "foreground.control.updated",
    emittedAt: 1_000 + sequence,
    payload: { foreground: null },
  };
}

function batch(params: {
  id: string;
  checkpoint?: BrowserGatewayOwnerCheckpoint | null;
  events?: BrowserGatewayOwnerEvent[];
  first?: number;
  last?: number;
}): BrowserGatewayOwnerPublicationBatch {
  const events = params.events ?? [];
  const includedCheckpoint = params.checkpoint ?? null;
  const checkpointSequence = includedCheckpoint?.checkpointSequence ?? 0;
  return {
    protocolVersion: BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION,
    helperGenerationId,
    ownerId,
    ownerGenerationId,
    batchId: params.id,
    firstSequence:
      params.first ?? events[0]?.ownerSequence ?? checkpointSequence,
    lastSequence:
      params.last ?? events.at(-1)?.ownerSequence ?? checkpointSequence,
    checkpoint: includedCheckpoint,
    events,
  };
}

function command(operationId = "operation-1"): BrowserGatewayOwnerCommand {
  return {
    protocolVersion: BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION,
    helperGenerationId,
    ownerId,
    ownerGenerationId,
    operationId,
    emittedAt: 1_000,
    deadlineAt: 1_000 + BROWSER_GATEWAY_DATA_PLANE_LIMITS.commandDeadlineMs,
    deadlineClass: "default",
    idempotency: BROWSER_GATEWAY_COMMAND_IDEMPOTENCY["session.select"],
    command: { kind: "session.select", sessionId: "session-1" },
  };
}

async function createFixture(now = () => 1_100) {
  const server = http.createServer();
  servers.push(server);
  const lifecycle = new HelperLifecycleCoordinator({ server });
  const registry = new BrowserGatewayCoreOwnerRegistry({
    heartbeatTtlMs: 30_000,
  });
  registry.register({
    ownerId,
    ownerKind: "vscode",
    displayName: "Owner",
    scope: {
      kind: "workspace",
      workspaceId: "workspace-1",
      displayName: "Workspace",
    },
    ownerGenerationId,
    now: 1_000,
  });
  const acknowledgements: string[] = [];
  const details: Array<{
    handle: BrowserGatewayDetailHandle;
    content: Buffer;
  }> = [];
  const routes = new BrowserGatewayDataPlaneRoutes({
    helperGenerationId,
    ownerRegistry: registry,
    lifecycle,
    now,
    onAcknowledgement: (acknowledgement) => {
      acknowledgements.push(acknowledgement.operation.operationId);
    },
    onDetail: (handle, content) => {
      details.push({ handle, content: Buffer.from(content) });
    },
  });
  server.on("request", (req, res) => {
    const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
    if (requestUrl.pathname === "/internal/data-plane/publications") {
      void routes.handle("publications", req, res, requestUrl);
      return;
    }
    if (requestUrl.pathname === "/internal/data-plane/commands") {
      void routes.handle("commands", req, res, requestUrl);
      return;
    }
    if (requestUrl.pathname === "/internal/data-plane/acknowledgements") {
      void routes.handle("acknowledgements", req, res, requestUrl);
      return;
    }
    if (requestUrl.pathname === "/internal/data-plane/details") {
      void routes.handle("details", req, res, requestUrl);
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("missing address");
  return {
    url: `http://127.0.0.1:${address.port}`,
    server,
    lifecycle,
    registry,
    routes,
    acknowledgements,
    details,
  };
}

async function postJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function closeServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

afterEach(async () => {
  while (servers.length > 0) await closeServer(servers.pop()!);
});

describe("BrowserGatewayDataPlaneRoutes", () => {
  it("installs a checkpoint, advances a contiguous cursor, and acknowledges duplicate posts", async () => {
    const fixture = await createFixture();
    const first = batch({
      id: "batch-1",
      checkpoint: checkpoint(),
      events: [event(1)],
    });

    const accepted = await postJson(
      `${fixture.url}/internal/data-plane/publications`,
      first,
    );
    expect(accepted.ok).toBe(true);
    await expect(accepted.json()).resolves.toMatchObject({
      cursor: 1,
      duplicate: false,
      batchId: "batch-1",
    });

    const duplicate = await postJson(
      `${fixture.url}/internal/data-plane/publications`,
      first,
    );
    expect(duplicate.ok).toBe(true);
    await expect(duplicate.json()).resolves.toMatchObject({
      cursor: 1,
      duplicate: true,
    });

    const next = await postJson(
      `${fixture.url}/internal/data-plane/publications`,
      batch({ id: "batch-2", events: [event(2)] }),
    );
    expect(next.ok).toBe(true);
    await expect(next.json()).resolves.toMatchObject({ cursor: 2 });
  });

  it("rejects a fresh generation without a checkpoint and rejects sequence gaps and overlaps", async () => {
    const fixture = await createFixture();
    const noCheckpoint = await postJson(
      `${fixture.url}/internal/data-plane/publications`,
      batch({ id: "no-checkpoint", events: [event(1)] }),
    );
    expect(noCheckpoint.status).toBe(409);
    await expect(noCheckpoint.json()).resolves.toMatchObject({
      error: "checkpoint_required",
      cursor: 0,
    });

    await postJson(
      `${fixture.url}/internal/data-plane/publications`,
      batch({ id: "initial", checkpoint: checkpoint(), events: [event(1)] }),
    );
    const gap = await postJson(
      `${fixture.url}/internal/data-plane/publications`,
      batch({ id: "gap", events: [event(3)] }),
    );
    expect(gap.status).toBe(409);
    await expect(gap.json()).resolves.toMatchObject({
      error: "sequence_gap",
      cursor: 1,
      expectedSequence: 2,
    });

    const overlap = await postJson(
      `${fixture.url}/internal/data-plane/publications`,
      batch({ id: "overlap", events: [event(1), event(2)] }),
    );
    expect(overlap.status).toBe(409);
    await expect(overlap.json()).resolves.toMatchObject({
      error: "sequence_overlap",
      cursor: 1,
    });
  });

  it("rejects stale helper and owner generations before ingest", async () => {
    const fixture = await createFixture();
    const staleHelper = batch({ id: "stale", checkpoint: checkpoint() });
    staleHelper.helperGenerationId = "helper-generation-old";
    staleHelper.checkpoint!.helperGenerationId = "helper-generation-old";
    const helperResponse = await postJson(
      `${fixture.url}/internal/data-plane/publications`,
      staleHelper,
    );
    expect(helperResponse.status).toBe(409);
    await expect(helperResponse.json()).resolves.toMatchObject({
      error: "helper_generation_mismatch",
    });

    fixture.registry.register({
      ownerId,
      ownerKind: "vscode",
      displayName: "Owner",
      scope: {
        kind: "workspace",
        workspaceId: "workspace-1",
        displayName: "Workspace",
      },
      ownerGenerationId: "owner-generation-2",
      now: 2_000,
    });
    const ownerResponse = await postJson(
      `${fixture.url}/internal/data-plane/publications`,
      batch({ id: "old-owner", checkpoint: checkpoint() }),
    );
    expect(ownerResponse.status).toBe(409);
    await expect(ownerResponse.json()).resolves.toMatchObject({
      error: "owner_generation_mismatch",
    });
  });

  it("bounds publication request bodies before protocol traversal", async () => {
    const fixture = await createFixture();
    const response = await fetch(
      `${fixture.url}/internal/data-plane/publications`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "x".repeat(
          BROWSER_GATEWAY_DATA_PLANE_LIMITS.ownerPublicationRequestBytes + 1,
        ),
      },
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_json" });
  });

  it("accepts generation-bound raw details and rejects size mismatches transactionally", async () => {
    const fixture = await createFixture();
    const handle: BrowserGatewayDetailHandle = {
      helperGenerationId,
      ownerId,
      ownerGenerationId,
      handleId: "detail-1",
      kind: "message",
      byteLength: 5,
      expiresAt: 2_000,
      mediaType: "text/plain",
    };
    const detailsUrl = `${fixture.url}/internal/data-plane/details?${new URLSearchParams(
      {
        handle: JSON.stringify(handle),
      },
    )}`;

    const accepted = await fetch(detailsUrl, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: "hello",
    });
    expect(accepted.status).toBe(201);
    expect(fixture.details).toEqual([
      { handle, content: Buffer.from("hello") },
    ]);

    const rejected = await fetch(detailsUrl, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: "no",
    });
    expect(rejected.status).toBe(400);
    await expect(rejected.json()).resolves.toEqual({
      error: "detail_size_mismatch",
    });
    expect(fixture.details).toHaveLength(1);

    const expiredHandle = { ...handle, handleId: "expired", expiresAt: 1_000 };
    const expired = await fetch(
      `${fixture.url}/internal/data-plane/details?${new URLSearchParams({
        handle: JSON.stringify(expiredHandle),
      })}`,
      { method: "POST", body: "hello" },
    );
    expect(expired.status).toBe(409);
    await expect(expired.json()).resolves.toEqual({ error: "detail_expired" });
    expect(fixture.details).toHaveLength(1);

    const staleHandle = { ...handle, ownerGenerationId: "stale-generation" };
    const stale = await fetch(
      `${fixture.url}/internal/data-plane/details?${new URLSearchParams({
        handle: JSON.stringify(staleHandle),
      })}`,
      { method: "POST", body: "hello" },
    );
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toEqual({
      error: "owner_generation_mismatch",
    });
    expect(fixture.details).toHaveLength(1);
  });

  it("streams generation-bound commands without helper liveness and accepts acknowledgements", async () => {
    const fixture = await createFixture();
    const query = new URLSearchParams({
      helperGenerationId,
      ownerId,
      ownerGenerationId,
    });
    const streamResponse = await fetch(
      `${fixture.url}/internal/data-plane/commands?${query}`,
    );
    expect(streamResponse.ok).toBe(true);
    expect(streamResponse.headers.get("content-type")).toBe(
      "text/event-stream",
    );
    expect(fixture.lifecycle.activeStreamCount).toBe(1);
    expect(fixture.lifecycle.hasLivenessReasons()).toBe(false);

    expect(fixture.routes.publishCommand(command())).toBe(true);
    const reader = streamResponse.body!.getReader();
    let text = "";
    while (!text.includes("event: command")) {
      const chunk = await reader.read();
      expect(chunk.done).toBe(false);
      text += new TextDecoder().decode(chunk.value);
    }
    expect(text).toContain("event: control");
    expect(text).toContain('"kind":"hello"');
    expect(text).toContain('"operationId":"operation-1"');

    const acknowledgement = await postJson(
      `${fixture.url}/internal/data-plane/acknowledgements`,
      {
        protocolVersion: BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION,
        helperGenerationId,
        ownerId,
        ownerGenerationId,
        operation: {
          operationId: "operation-1",
          kind: "session.select",
          state: "completed",
        },
        acknowledgedAt: 1_200,
      },
    );
    expect(acknowledgement.ok).toBe(true);
    expect(fixture.acknowledgements).toEqual(["operation-1"]);

    await reader.cancel();
  });

  it("removes cancelled commands before owner stream reconnect replay", async () => {
    const fixture = await createFixture();
    const cancelledCommand = command("cancelled-operation");
    expect(fixture.routes.publishCommand(cancelledCommand)).toBe(true);
    fixture.routes.cancelCommand(cancelledCommand);

    const stream = await fetch(
      `${fixture.url}/internal/data-plane/commands?helperGenerationId=${helperGenerationId}&ownerId=${ownerId}&ownerGenerationId=${ownerGenerationId}`,
    );
    const reader = stream.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toContain('"kind":"hello"');
    expect(first).not.toContain(
      `"operationId":"${cancelledCommand.operationId}"`,
    );
    await reader.cancel();
  });

  it("keeps commands pending after accepted acknowledgements until a terminal acknowledgement", async () => {
    const fixture = await createFixture();
    const pendingCommand = command("accepted-operation");
    expect(fixture.routes.publishCommand(pendingCommand)).toBe(true);

    const accepted = await fetch(
      `${fixture.url}/internal/data-plane/acknowledgements`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          protocolVersion: BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION,
          helperGenerationId,
          ownerId,
          ownerGenerationId,
          operation: {
            operationId: pendingCommand.operationId,
            kind: pendingCommand.command.kind,
            state: "accepted",
          },
          acknowledgedAt: 1_100,
        }),
      },
    );
    expect(accepted.status).toBe(200);

    const stream = await fetch(
      `${fixture.url}/internal/data-plane/commands?helperGenerationId=${helperGenerationId}&ownerId=${ownerId}&ownerGenerationId=${ownerGenerationId}`,
    );
    const reader = stream.body!.getReader();
    let text = "";
    while (!text.includes(`"operationId":"${pendingCommand.operationId}"`)) {
      const chunk = await reader.read();
      expect(chunk.done).toBe(false);
      text += new TextDecoder().decode(chunk.value);
    }
    expect(text).toContain("event: command");
    await reader.cancel();
  });

  it("sends drain notices, rejects later publications, and closes owner streams", async () => {
    const fixture = await createFixture();
    const query = new URLSearchParams({
      helperGenerationId,
      ownerId,
      ownerGenerationId,
    });
    const streamResponse = await fetch(
      `${fixture.url}/internal/data-plane/commands?${query}`,
    );
    const reader = streamResponse.body!.getReader();

    fixture.routes.beginDrain();
    let streamText = "";
    while (!streamText.includes('"kind":"drain"')) {
      const chunk = await reader.read();
      expect(chunk.done).toBe(false);
      streamText += new TextDecoder().decode(chunk.value);
    }
    expect(streamText).toContain("event: control");

    const publication = await postJson(
      `${fixture.url}/internal/data-plane/publications`,
      batch({ id: "after-drain", checkpoint: checkpoint() }),
    );
    expect(publication.status).toBe(503);

    fixture.routes.close();
    const ended = await reader.read();
    expect(ended.done).toBe(true);
    expect(fixture.lifecycle.hasLivenessReasons()).toBe(false);
  });
});
