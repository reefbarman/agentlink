import { EventEmitter } from "events";
import { Readable } from "stream";
import type * as http from "http";

import { describe, expect, it, vi } from "vitest";

import { BrowserGatewayCoreOwnerRegistry } from "../coreOwnerRegistry.js";
import {
  BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION,
  type BrowserGatewayOwnerCheckpoint,
  type BrowserGatewayOwnerEvent,
} from "../dataPlane/protocol.js";
import type { HelperLifecycleCoordinator } from "./HelperLifecycleCoordinator.js";
import { OwnerRelayStore } from "./OwnerRelayStore.js";
import { BrowserGatewayRelayRoutes } from "./relayRoutes.js";

const helperGenerationId = "helper-1";
const ownerId = "owner-1";
const ownerGenerationId = "owner-generation-1";

class ResponseFixture extends EventEmitter {
  readonly socket = { setTimeout: vi.fn() };
  readonly headers: Array<{
    status: number;
    headers: http.OutgoingHttpHeaders | undefined;
  }> = [];
  readonly writes: string[] = [];
  destroyed = false;
  writableEnded = false;

  writeHead(status: number, headers?: http.OutgoingHttpHeaders): this {
    this.headers.push({ status, headers });
    return this;
  }

  flushHeaders(): void {}

  write(chunk: string | Uint8Array): boolean {
    this.writes.push(String(chunk));
    return true;
  }

  end(chunk?: string | Uint8Array): this {
    if (chunk !== undefined) this.writes.push(String(chunk));
    this.writableEnded = true;
    return this;
  }

  destroy(): this {
    this.destroyed = true;
    this.emit("close");
    return this;
  }

  asServerResponse(): http.ServerResponse {
    return this as unknown as http.ServerResponse;
  }
}

function request(params: {
  method: string;
  url: string;
  body?: unknown;
  headers?: http.IncomingHttpHeaders;
}): http.IncomingMessage {
  const body = params.body === undefined ? [] : [JSON.stringify(params.body)];
  const req = Readable.from(body) as unknown as http.IncomingMessage;
  Object.assign(req, {
    method: params.method,
    url: params.url,
    headers: { host: "127.0.0.1:47200", ...params.headers },
    socket: { setTimeout: vi.fn() },
  });
  return req;
}

function checkpoint(sequence = 0): BrowserGatewayOwnerCheckpoint {
  return {
    protocolVersion: BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION,
    helperGenerationId,
    ownerId,
    ownerGenerationId,
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

function parseSseEvent(
  text: string,
  eventName: string,
): Record<string, unknown> {
  const match = new RegExp(`event: ${eventName}\\ndata: (\\{[^\\n]+\\})`).exec(
    text,
  );
  if (!match?.[1]) throw new Error(`missing ${eventName} event`);
  return JSON.parse(match[1]) as Record<string, unknown>;
}

function makeFixture(
  options: {
    onCommand?: ConstructorParameters<
      typeof BrowserGatewayRelayRoutes
    >[0]["onCommand"];
    onOperationStatus?: ConstructorParameters<
      typeof BrowserGatewayRelayRoutes
    >[0]["onOperationStatus"];
  } = {},
) {
  const registry = new BrowserGatewayCoreOwnerRegistry({
    heartbeatTtlMs: 30_000,
  });
  registry.register({
    ownerId,
    ownerKind: "vscode",
    displayName: "Workspace owner",
    instanceId: "instance-1",
    scope: {
      kind: "workspace",
      workspaceId: "workspace-1",
      displayName: "Workspace",
    },
    ownerGenerationId,
    now: 1_000,
  });
  const store = new OwnerRelayStore({
    helperGenerationId,
    now: () => 1_100,
  });
  store.ingestPublication({
    protocolVersion: BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION,
    helperGenerationId,
    ownerId,
    ownerGenerationId,
    batchId: "checkpoint",
    firstSequence: 0,
    lastSequence: 0,
    checkpoint: checkpoint(),
    events: [],
  });
  const subscriberChanges: number[] = [];
  const checkpointRequests: number[] = [];
  const routes = new BrowserGatewayRelayRoutes({
    helperGenerationId,
    ownerRegistry: registry,
    store,
    lifecycle: {
      trackStream: () => () => undefined,
    } as unknown as HelperLifecycleCoordinator,
    now: () => 1_100,
    keepaliveIntervalMs: 0,
    isAllowedHost: (host) => host === "127.0.0.1:47200",
    onSubscriberCountChanged: (_owner, _generation, count) => {
      subscriberChanges.push(count);
    },
    onCheckpointRequested: (_owner, _generation, sequence) => {
      checkpointRequests.push(sequence);
    },
    onCommand: options.onCommand,
    onOperationStatus: options.onOperationStatus,
  });
  return { routes, store, registry, subscriberChanges, checkpointRequests };
}

describe("BrowserGatewayRelayRoutes", () => {
  it("mints independent browser connections and keeps unselected tabs catalog-only", async () => {
    const fixture = makeFixture();
    const first = new ResponseFixture();
    const second = new ResponseFixture();
    const auth = { sessionKey: "device:1", deviceId: "device-1" };

    await fixture.routes.handle(
      "events",
      auth,
      request({ method: "GET", url: "/api/relay/events" }),
      first.asServerResponse(),
      new URL("http://127.0.0.1:47200/api/relay/events"),
    );
    await fixture.routes.handle(
      "events",
      auth,
      request({ method: "GET", url: "/api/relay/events" }),
      second.asServerResponse(),
      new URL("http://127.0.0.1:47200/api/relay/events"),
    );

    const firstHello = parseSseEvent(first.writes.join(""), "hello");
    const secondHello = parseSseEvent(second.writes.join(""), "hello");
    expect(firstHello.browserConnectionId).not.toBe(
      secondHello.browserConnectionId,
    );
    const catalog = parseSseEvent(first.writes.join(""), "catalog") as {
      owners: Array<{ ownerId: string; instanceId?: string }>;
    };
    expect(catalog.owners).toContainEqual(
      expect.objectContaining({ ownerId, instanceId: "instance-1" }),
    );
    expect(first.writes.join("")).not.toContain("event: checkpoint");
    expect(second.writes.join("")).not.toContain("event: checkpoint");
    fixture.routes.close();
  });

  it("omits a disconnected workspace owner when a live replacement is registered", async () => {
    const fixture = makeFixture();
    const oldOwnerId = "workspace-old";
    fixture.registry.register({
      ownerId: oldOwnerId,
      ownerKind: "vscode",
      displayName: "Old Workspace",
      scope: {
        kind: "workspace",
        workspaceId: "workspace-1",
        displayName: "Workspace",
      },
      ownerGenerationId: "generation-old",
      instanceId: "instance-old",
      now: 1_000,
    });
    fixture.registry.markDisconnected(oldOwnerId);
    fixture.registry.register({
      ownerId: "workspace-new",
      ownerKind: "vscode",
      displayName: "New Workspace",
      scope: {
        kind: "workspace",
        workspaceId: "workspace-1",
        displayName: "Workspace",
      },
      ownerGenerationId: "generation-new",
      instanceId: "instance-new",
      now: 1_100,
    });
    const response = new ResponseFixture();

    await fixture.routes.handle(
      "events",
      { sessionKey: "device:1", deviceId: "device-1" },
      request({ method: "GET", url: "/api/relay/events" }),
      response.asServerResponse(),
      new URL("http://127.0.0.1:47200/api/relay/events"),
    );

    const catalog = parseSseEvent(response.writes.join(""), "catalog") as {
      owners: Array<{ ownerId: string }>;
    };
    expect(catalog.owners.map((owner) => owner.ownerId)).toContain(
      "workspace-new",
    );
    expect(catalog.owners.map((owner) => owner.ownerId)).not.toContain(
      oldOwnerId,
    );
    fixture.routes.close();
  });

  it("binds subscriptions to connection CSRF and publishes only to the selected tab", async () => {
    const fixture = makeFixture();
    const selected = new ResponseFixture();
    const catalogOnly = new ResponseFixture();
    const auth = { sessionKey: "device:1", deviceId: "device-1" };
    for (const response of [selected, catalogOnly]) {
      await fixture.routes.handle(
        "events",
        auth,
        request({ method: "GET", url: "/api/relay/events" }),
        response.asServerResponse(),
        new URL("http://127.0.0.1:47200/api/relay/events"),
      );
    }
    const hello = parseSseEvent(selected.writes.join(""), "hello");

    const rejected = new ResponseFixture();
    await fixture.routes.handle(
      "subscription",
      auth,
      request({
        method: "POST",
        url: "/api/relay/subscription",
        headers: {
          host: "127.0.0.1:47200",
          origin: "http://127.0.0.1:47200",
        },
        body: {
          browserConnectionId: hello.browserConnectionId,
          csrfNonce: "wrong-tab-nonce",
          ownerId,
          ownerGenerationId,
        },
      }),
      rejected.asServerResponse(),
      new URL("http://127.0.0.1:47200/api/relay/subscription"),
    );
    expect(rejected.headers.at(-1)?.status).toBe(403);

    const accepted = new ResponseFixture();
    await fixture.routes.handle(
      "subscription",
      auth,
      request({
        method: "POST",
        url: "/api/relay/subscription",
        headers: {
          host: "127.0.0.1:47200",
          origin: "http://127.0.0.1:47200",
        },
        body: {
          browserConnectionId: hello.browserConnectionId,
          csrfNonce: hello.csrfNonce,
          ownerId,
          ownerGenerationId,
        },
      }),
      accepted.asServerResponse(),
      new URL("http://127.0.0.1:47200/api/relay/subscription"),
    );
    expect(accepted.headers.at(-1)?.status).toBe(202);
    expect(selected.writes.join("")).toContain("event: checkpoint");

    fixture.store.ingestPublication({
      protocolVersion: BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION,
      helperGenerationId,
      ownerId,
      ownerGenerationId,
      batchId: "event-1",
      firstSequence: 1,
      lastSequence: 1,
      checkpoint: null,
      events: [event(1)],
    });
    expect(selected.writes.join("")).toContain("event: owner.event");
    expect(catalogOnly.writes.join("")).not.toContain("event: owner.event");
    expect(fixture.subscriberChanges).toEqual([1]);
    fixture.routes.close();
    expect(fixture.subscriberChanges).toEqual([1, 0]);
  });

  it("fans 30 ordered events out to four browser connections without compaction or stalls", async () => {
    const fixture = makeFixture();
    const auth = { sessionKey: "device:fanout", deviceId: "device-fanout" };
    const streams = Array.from({ length: 4 }, () => new ResponseFixture());

    for (const stream of streams) {
      await fixture.routes.handle(
        "events",
        auth,
        request({ method: "GET", url: "/api/relay/events" }),
        stream.asServerResponse(),
        new URL("http://127.0.0.1:47200/api/relay/events"),
      );
      const hello = parseSseEvent(stream.writes.join(""), "hello");
      const subscription = new ResponseFixture();
      await fixture.routes.handle(
        "subscription",
        auth,
        request({
          method: "POST",
          url: "/api/relay/subscription",
          headers: { origin: "http://127.0.0.1:47200" },
          body: {
            browserConnectionId: hello.browserConnectionId,
            csrfNonce: hello.csrfNonce,
            ownerId,
            ownerGenerationId,
          },
        }),
        subscription.asServerResponse(),
        new URL("http://127.0.0.1:47200/api/relay/subscription"),
      );
      expect(subscription.headers.at(-1)?.status).toBe(202);
    }
    expect(fixture.subscriberChanges).toEqual([1, 2, 3, 4]);

    fixture.store.ingestPublication({
      protocolVersion: BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION,
      helperGenerationId,
      ownerId,
      ownerGenerationId,
      batchId: "four-client-fanout",
      firstSequence: 1,
      lastSequence: 30,
      checkpoint: null,
      events: Array.from({ length: 30 }, (_, index) => event(index + 1)),
    });

    for (const stream of streams) {
      const text = stream.writes.join("");
      expect(text.match(/event: owner\.event/g)).toHaveLength(30);
      expect(text).toContain('"ownerSequence":1');
      expect(text).toContain('"ownerSequence":30');
      expect(stream.destroyed).toBe(false);
    }
    expect(fixture.checkpointRequests).toEqual([]);

    fixture.routes.close();
    expect(fixture.subscriberChanges.at(-1)).toBe(0);
    expect(streams.every((stream) => stream.destroyed === false)).toBe(true);
    expect(streams.every((stream) => stream.writableEnded)).toBe(true);
  });

  it("binds commands to connection CSRF and the current subscription and emits sequence-free local operations", async () => {
    const commandContexts: unknown[] = [];
    const fixture = makeFixture({
      onCommand: (commandContext) => {
        commandContexts.push(commandContext);
        return {
          status: 202,
          payload: {
            ok: true,
            operation: {
              operationId: "operation-1",
              kind: "session.select",
              state: "accepted",
            },
          },
        };
      },
    });
    const stream = new ResponseFixture();
    const auth = { sessionKey: "device:1", deviceId: "device-1" };
    await fixture.routes.handle(
      "events",
      auth,
      request({ method: "GET", url: "/api/relay/events" }),
      stream.asServerResponse(),
      new URL("http://127.0.0.1:47200/api/relay/events"),
    );
    const hello = parseSseEvent(stream.writes.join(""), "hello");
    const subscriptionResponse = new ResponseFixture();
    await fixture.routes.handle(
      "subscription",
      auth,
      request({
        method: "POST",
        url: "/api/relay/subscription",
        headers: { origin: "http://127.0.0.1:47200" },
        body: {
          browserConnectionId: hello.browserConnectionId,
          csrfNonce: hello.csrfNonce,
          ownerId,
          ownerGenerationId,
        },
      }),
      subscriptionResponse.asServerResponse(),
      new URL("http://127.0.0.1:47200/api/relay/subscription"),
    );
    const subscription = JSON.parse(subscriptionResponse.writes.join("")) as {
      subscriptionId: string;
    };
    const commandBody = {
      browserConnectionId: hello.browserConnectionId,
      csrfNonce: hello.csrfNonce,
      subscriptionId: subscription.subscriptionId,
      operationId: "operation-1",
      deadlineClass: "default",
      command: { kind: "session.select", sessionId: "session-1" },
    };

    const stale = new ResponseFixture();
    await fixture.routes.handle(
      "commands",
      auth,
      request({
        method: "POST",
        url: "/api/relay/commands",
        headers: { origin: "http://127.0.0.1:47200" },
        body: { ...commandBody, subscriptionId: "stale-subscription" },
      }),
      stale.asServerResponse(),
      new URL("http://127.0.0.1:47200/api/relay/commands"),
    );
    expect(stale.headers.at(-1)?.status).toBe(409);

    const wrongTab = new ResponseFixture();
    await fixture.routes.handle(
      "commands",
      auth,
      request({
        method: "POST",
        url: "/api/relay/commands",
        headers: { origin: "http://127.0.0.1:47200" },
        body: { ...commandBody, csrfNonce: "wrong" },
      }),
      wrongTab.asServerResponse(),
      new URL("http://127.0.0.1:47200/api/relay/commands"),
    );
    expect(wrongTab.headers.at(-1)?.status).toBe(403);

    const accepted = new ResponseFixture();
    await fixture.routes.handle(
      "commands",
      auth,
      request({
        method: "POST",
        url: "/api/relay/commands",
        headers: { origin: "http://127.0.0.1:47200" },
        body: commandBody,
      }),
      accepted.asServerResponse(),
      new URL("http://127.0.0.1:47200/api/relay/commands"),
    );
    expect(accepted.headers.at(-1)?.status).toBe(202);
    expect(commandContexts).toEqual([
      {
        sessionKey: "device:1",
        browserConnectionId: hello.browserConnectionId,
        subscriptionId: subscription.subscriptionId,
        ownerId,
        ownerGenerationId,
      },
    ]);

    const beforeOperation = stream.writes.join("").length;
    expect(
      fixture.routes.emitOperation(
        String(hello.browserConnectionId),
        ownerId,
        ownerGenerationId,
        {
          operationId: "operation-1",
          kind: "session.select",
          state: "completed",
        },
      ),
    ).toBe(true);
    const operationFrame = stream.writes.join("").slice(beforeOperation);
    expect(operationFrame).toContain("event: relay.operation");
    expect(operationFrame).not.toContain("id:");
    expect(operationFrame).not.toContain("ownerSequence");
    expect(operationFrame).not.toContain("relaySequence");
    fixture.routes.close();
  });

  it("binds operation status lookup to same-origin connection CSRF and subscription", async () => {
    const lookupContexts: unknown[] = [];
    const fixture = makeFixture({
      onOperationStatus: (lookupContext, operationId) => {
        lookupContexts.push({ lookupContext, operationId });
        return {
          status: 200,
          payload: {
            ok: true,
            operation: {
              operationId,
              kind: "session.select",
              state: "accepted",
            },
          },
        };
      },
    });
    const stream = new ResponseFixture();
    const auth = { sessionKey: "device:1", deviceId: "device-1" };
    await fixture.routes.handle(
      "events",
      auth,
      request({ method: "GET", url: "/api/relay/events" }),
      stream.asServerResponse(),
      new URL("http://127.0.0.1:47200/api/relay/events"),
    );
    const hello = parseSseEvent(stream.writes.join(""), "hello");
    const subscriptionResponse = new ResponseFixture();
    await fixture.routes.handle(
      "subscription",
      auth,
      request({
        method: "POST",
        url: "/api/relay/subscription",
        headers: { origin: "http://127.0.0.1:47200" },
        body: {
          browserConnectionId: hello.browserConnectionId,
          csrfNonce: hello.csrfNonce,
          ownerId,
          ownerGenerationId,
        },
      }),
      subscriptionResponse.asServerResponse(),
      new URL("http://127.0.0.1:47200/api/relay/subscription"),
    );
    const subscription = JSON.parse(subscriptionResponse.writes.join("")) as {
      subscriptionId: string;
    };
    const body = {
      browserConnectionId: hello.browserConnectionId,
      csrfNonce: hello.csrfNonce,
      subscriptionId: subscription.subscriptionId,
      operationId: "operation-1",
    };

    for (const [bodyOverride, expectedStatus] of [
      [{ subscriptionId: "stale" }, 409],
      [{ csrfNonce: "wrong" }, 403],
    ] as const) {
      const response = new ResponseFixture();
      await fixture.routes.handle(
        "operationStatus",
        auth,
        request({
          method: "POST",
          url: "/api/relay/operations/status",
          headers: { origin: "http://127.0.0.1:47200" },
          body: { ...body, ...bodyOverride },
        }),
        response.asServerResponse(),
        new URL("http://127.0.0.1:47200/api/relay/operations/status"),
      );
      expect(response.headers.at(-1)?.status).toBe(expectedStatus);
    }

    const response = new ResponseFixture();
    await fixture.routes.handle(
      "operationStatus",
      auth,
      request({
        method: "POST",
        url: "/api/relay/operations/status",
        headers: { origin: "http://127.0.0.1:47200" },
        body,
      }),
      response.asServerResponse(),
      new URL("http://127.0.0.1:47200/api/relay/operations/status"),
    );
    expect(response.headers.at(-1)?.status).toBe(200);
    expect(lookupContexts).toEqual([
      {
        lookupContext: {
          sessionKey: "device:1",
          browserConnectionId: hello.browserConnectionId,
          ownerId,
          ownerGenerationId,
        },
        operationId: "operation-1",
      },
    ]);
    fixture.routes.close();
  });

  it("rejects disallowed Hosts before opening relay streams", async () => {
    const fixture = makeFixture();
    const response = new ResponseFixture();
    await fixture.routes.handle(
      "events",
      { sessionKey: "bootstrap" },
      request({
        method: "GET",
        url: "/api/relay/events",
        headers: { host: "attacker.example:47200" },
      }),
      response.asServerResponse(),
      new URL("http://attacker.example:47200/api/relay/events"),
    );
    expect(response.headers.at(-1)?.status).toBe(403);
    expect(response.writes.join("")).toContain("host_not_allowed");
    fixture.routes.close();
  });

  it("rejects bad Host/Origin mutations and severs revoked device streams", async () => {
    const fixture = makeFixture();
    const response = new ResponseFixture();
    const auth = { sessionKey: "device:1", deviceId: "device-1" };
    await fixture.routes.handle(
      "events",
      auth,
      request({ method: "GET", url: "/api/relay/events" }),
      response.asServerResponse(),
      new URL("http://127.0.0.1:47200/api/relay/events"),
    );
    const hello = parseSseEvent(response.writes.join(""), "hello");
    const rejected = new ResponseFixture();
    await fixture.routes.handle(
      "subscription",
      auth,
      request({
        method: "POST",
        url: "/api/relay/subscription",
        headers: {
          host: "attacker.example",
          origin: "http://attacker.example",
        },
        body: {
          browserConnectionId: hello.browserConnectionId,
          csrfNonce: hello.csrfNonce,
          ownerId,
          ownerGenerationId,
        },
      }),
      rejected.asServerResponse(),
      new URL("http://127.0.0.1:47200/api/relay/subscription"),
    );
    expect(rejected.headers.at(-1)?.status).toBe(403);

    fixture.routes.closeDevice("device-1");
    expect(response.destroyed).toBe(true);
    fixture.routes.close();
  });

  it("rate-limits rapid subscription changes per browser connection", async () => {
    const fixture = makeFixture();
    const response = new ResponseFixture();
    const auth = { sessionKey: "device:1", deviceId: "device-1" };
    await fixture.routes.handle(
      "events",
      auth,
      request({ method: "GET", url: "/api/relay/events" }),
      response.asServerResponse(),
      new URL("http://127.0.0.1:47200/api/relay/events"),
    );
    const hello = parseSseEvent(response.writes.join(""), "hello");
    let lastStatus = 0;
    for (let index = 0; index < 6; index += 1) {
      const mutation = new ResponseFixture();
      await fixture.routes.handle(
        "subscription",
        auth,
        request({
          method: "POST",
          url: "/api/relay/subscription",
          headers: {
            host: "127.0.0.1:47200",
            origin: "http://127.0.0.1:47200",
          },
          body: {
            browserConnectionId: hello.browserConnectionId,
            csrfNonce: hello.csrfNonce,
            ownerId,
            ownerGenerationId,
          },
        }),
        mutation.asServerResponse(),
        new URL("http://127.0.0.1:47200/api/relay/subscription"),
      );
      lastStatus = mutation.headers.at(-1)?.status ?? 0;
    }
    expect(lastStatus).toBe(429);
    fixture.routes.close();
  });

  it("resets an active subscription when its owner generation restarts", async () => {
    const fixture = makeFixture();
    const response = new ResponseFixture();
    const auth = { sessionKey: "device:1", deviceId: "device-1" };
    await fixture.routes.handle(
      "events",
      auth,
      request({ method: "GET", url: "/api/relay/events" }),
      response.asServerResponse(),
      new URL("http://127.0.0.1:47200/api/relay/events"),
    );
    const hello = parseSseEvent(response.writes.join(""), "hello");
    await fixture.routes.handle(
      "subscription",
      auth,
      request({
        method: "POST",
        url: "/api/relay/subscription",
        headers: {
          host: "127.0.0.1:47200",
          origin: "http://127.0.0.1:47200",
        },
        body: {
          browserConnectionId: hello.browserConnectionId,
          csrfNonce: hello.csrfNonce,
          ownerId,
          ownerGenerationId,
        },
      }),
      new ResponseFixture().asServerResponse(),
      new URL("http://127.0.0.1:47200/api/relay/subscription"),
    );

    const nextGeneration = "owner-generation-2";
    fixture.routes.ownerRegistered(ownerId, nextGeneration);
    const text = response.writes.join("");
    expect(text).toContain('"reason":"owner_generation_changed"');
    expect(text).toContain(`"ownerGenerationId":"${nextGeneration}"`);
    expect(fixture.subscriberChanges).toEqual([1, 0, 1]);
    expect(fixture.checkpointRequests).toEqual([0]);
    fixture.routes.close();
  });

  it("replays retained records after Last-Event-ID on reconnect", async () => {
    const fixture = makeFixture();
    fixture.store.ingestPublication({
      protocolVersion: BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION,
      helperGenerationId,
      ownerId,
      ownerGenerationId,
      batchId: "events",
      firstSequence: 1,
      lastSequence: 2,
      checkpoint: null,
      events: [event(1), event(2)],
    });
    const response = new ResponseFixture();
    await fixture.routes.handle(
      "events",
      { sessionKey: "bootstrap" },
      request({
        method: "GET",
        url: "/api/relay/events",
        headers: {
          "last-event-id": `${helperGenerationId}/${ownerId}/${ownerGenerationId}/2`,
        },
      }),
      response.asServerResponse(),
      new URL("http://127.0.0.1:47200/api/relay/events"),
    );

    const text = response.writes.join("");
    expect(text).toContain(
      `id: ${helperGenerationId}/${ownerId}/${ownerGenerationId}/3`,
    );
    expect(text).not.toContain(
      `id: ${helperGenerationId}/${ownerId}/${ownerGenerationId}/2\n`,
    );
    expect(fixture.checkpointRequests).toEqual([]);
    fixture.routes.close();
  });

  it("replays a qualified manual cursor query", async () => {
    const fixture = makeFixture();
    fixture.store.ingestPublication({
      protocolVersion: BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION,
      helperGenerationId,
      ownerId,
      ownerGenerationId,
      batchId: "events",
      firstSequence: 1,
      lastSequence: 2,
      checkpoint: null,
      events: [event(1), event(2)],
    });
    const response = new ResponseFixture();
    const cursor = `${helperGenerationId}/${ownerId}/${ownerGenerationId}/2`;
    await fixture.routes.handle(
      "events",
      { sessionKey: "bootstrap" },
      request({ method: "GET", url: `/api/relay/events?cursor=${cursor}` }),
      response.asServerResponse(),
      new URL(
        `http://127.0.0.1:47200/api/relay/events?cursor=${encodeURIComponent(cursor)}`,
      ),
    );

    const text = response.writes.join("");
    expect(text).toContain(
      `id: ${helperGenerationId}/${ownerId}/${ownerGenerationId}/3`,
    );
    expect(text).not.toContain(
      `id: ${helperGenerationId}/${ownerId}/${ownerGenerationId}/2\n`,
    );
    fixture.routes.close();
  });

  it("prefers Last-Event-ID over a manual cursor query", async () => {
    const fixture = makeFixture();
    fixture.store.ingestPublication({
      protocolVersion: BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION,
      helperGenerationId,
      ownerId,
      ownerGenerationId,
      batchId: "events",
      firstSequence: 1,
      lastSequence: 2,
      checkpoint: null,
      events: [event(1), event(2)],
    });
    const response = new ResponseFixture();
    const headerCursor = `${helperGenerationId}/${ownerId}/${ownerGenerationId}/2`;
    const queryCursor = `${helperGenerationId}/${ownerId}/${ownerGenerationId}/1`;
    await fixture.routes.handle(
      "events",
      { sessionKey: "bootstrap" },
      request({
        method: "GET",
        url: `/api/relay/events?cursor=${queryCursor}`,
        headers: { "last-event-id": headerCursor },
      }),
      response.asServerResponse(),
      new URL(
        `http://127.0.0.1:47200/api/relay/events?cursor=${encodeURIComponent(queryCursor)}`,
      ),
    );

    expect(response.writes.join("")).not.toContain(
      `id: ${helperGenerationId}/${ownerId}/${ownerGenerationId}/2\n`,
    );
    fixture.routes.close();
  });

  it("resets a reconnect cursor from a prior helper generation", async () => {
    const fixture = makeFixture();
    const response = new ResponseFixture();
    await fixture.routes.handle(
      "events",
      { sessionKey: "bootstrap" },
      request({
        method: "GET",
        url: "/api/relay/events",
        headers: {
          "last-event-id": `old-helper/${ownerId}/${ownerGenerationId}/99`,
        },
      }),
      response.asServerResponse(),
      new URL(
        `http://127.0.0.1:47200/api/relay/events?ownerId=${ownerId}&ownerGenerationId=${ownerGenerationId}`,
      ),
    );

    expect(response.writes.join("")).toContain(
      '"reason":"helper_generation_changed"',
    );
    fixture.routes.close();
  });
});
