import { afterEach, describe, expect, it, vi } from "vitest";

import { BrowserGatewayCoreOwnerRegistry } from "../coreOwnerRegistry.js";
import { BROWSER_GATEWAY_DATA_PLANE_LIMITS } from "../dataPlane/limits.js";
import {
  BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION,
  type BrowserGatewayOperationState,
  type BrowserGatewayOwnerCommand,
  type BrowserGatewayOwnerCommandAck,
  type BrowserGatewayOwnerCommandBody,
} from "../dataPlane/protocol.js";
import {
  BrowserGatewayCommandRoutes,
  type BrowserGatewayCommandContext,
} from "./commandRoutes.js";

const helperGenerationId = "helper-1";
const ownerId = "owner-1";
const ownerGenerationId = "generation-1";

function context(
  overrides: Partial<BrowserGatewayCommandContext> = {},
): BrowserGatewayCommandContext {
  return {
    sessionKey: "device:1",
    browserConnectionId: "connection-1",
    subscriptionId: "subscription-1",
    ownerId,
    ownerGenerationId,
    ...overrides,
  };
}

function request(
  operationId: string,
  command: BrowserGatewayOwnerCommandBody = {
    kind: "session.select",
    sessionId: "session-1",
  },
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    browserConnectionId: "connection-1",
    csrfNonce: "nonce-1",
    subscriptionId: "subscription-1",
    operationId,
    deadlineClass: "default",
    command,
    ...overrides,
  };
}

function acknowledgement(
  operationId: string,
  operation: Partial<BrowserGatewayOperationState> = {},
): BrowserGatewayOwnerCommandAck {
  return {
    protocolVersion: BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION,
    helperGenerationId,
    ownerId,
    ownerGenerationId,
    operation: {
      operationId,
      kind: "session.select",
      state: "completed",
      ...operation,
    },
    acknowledgedAt: 2_000,
  };
}

function makeFixture(options: { now?: number; capabilities?: string[] } = {}) {
  let now = options.now ?? 1_000;
  const registry = new BrowserGatewayCoreOwnerRegistry({
    heartbeatTtlMs: 30_000,
  });
  registry.register({
    ownerId,
    ownerKind: "vscode",
    displayName: "Owner",
    scope: { kind: "workspace", workspaceId: "ws", displayName: "WS" },
    ownerGenerationId,
    now,
    capabilities: (
      options.capabilities ?? ["session.select", "session.send", "session.stop"]
    ).map((capabilityId) => ({ capabilityId, state: "enabled" as const })),
  });
  const published: BrowserGatewayOwnerCommand[] = [];
  const cancelled: BrowserGatewayOwnerCommand[] = [];
  const emitted: Array<{
    connectionId: string;
    operation: BrowserGatewayOperationState;
  }> = [];
  const routes = new BrowserGatewayCommandRoutes({
    helperGenerationId,
    ownerRegistry: registry,
    now: () => now,
    publishCommand: (command) => {
      published.push(command);
      return true;
    },
    cancelCommand: (command) => cancelled.push(command),
    emitOperation: (connectionId, _owner, _generation, operation) => {
      emitted.push({ connectionId, operation: { ...operation } });
    },
  });
  return {
    routes,
    registry,
    published,
    cancelled,
    emitted,
    setNow(value: number) {
      now = value;
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("BrowserGatewayCommandRoutes", () => {
  it("strictly parses browser requests and derives identity, idempotency, and deadlines", () => {
    const fixture = makeFixture();
    const accepted = fixture.routes.handle(context(), request("operation-1"));

    expect(accepted).toMatchObject({
      status: 202,
      payload: {
        duplicate: false,
        deadlineAt: 1_000 + BROWSER_GATEWAY_DATA_PLANE_LIMITS.commandDeadlineMs,
      },
    });
    expect(fixture.published).toEqual([
      expect.objectContaining({
        helperGenerationId,
        ownerId,
        ownerGenerationId,
        operationId: "operation-1",
        emittedAt: 1_000,
        deadlineAt: 1_000 + BROWSER_GATEWAY_DATA_PLANE_LIMITS.commandDeadlineMs,
        deadlineClass: "default",
        idempotency: "idempotent",
      }),
    ]);
    expect(
      fixture.routes.handle(
        context(),
        request("operation-2", undefined, { unexpected: true }),
      ),
    ).toMatchObject({ status: 400, payload: { error: "unknown_field" } });
    expect(
      fixture.routes.handle(
        context(),
        request("operation-3", undefined, { deadlineClass: "unbounded" }),
      ),
    ).toMatchObject({ status: 400, payload: { error: "invalid_value" } });
    fixture.routes.close();
  });

  it("re-resolves retained operations only for the owning session and owner generation", () => {
    const fixture = makeFixture();
    expect(
      fixture.routes.handle(context(), request("operation-lookup")),
    ).toMatchObject({
      status: 202,
    });
    fixture.routes.onAcknowledgement(
      acknowledgement("operation-lookup", { state: "completed" }),
    );

    expect(
      fixture.routes.lookupOperation(
        {
          sessionKey: "device:1",
          browserConnectionId: "connection-2",
          ownerId,
          ownerGenerationId,
        },
        "operation-lookup",
      ),
    ).toMatchObject({
      status: 200,
      payload: {
        helperGenerationId,
        ownerId,
        ownerGenerationId,
        idempotency: "idempotent",
        operation: {
          operationId: "operation-lookup",
          state: "completed",
        },
      },
    });
    for (const lookupContext of [
      { ...context(), sessionKey: "device:2" },
      { ...context(), ownerId: "owner-2" },
      { ...context(), ownerGenerationId: "generation-2" },
    ]) {
      expect(
        fixture.routes.lookupOperation(lookupContext, "operation-lookup"),
      ).toEqual({ status: 404, payload: { error: "operation_not_found" } });
    }
    fixture.routes.close();
  });

  it("prunes expired terminal operations before status lookup", () => {
    const fixture = makeFixture();
    fixture.routes.handle(context(), request("operation-expired"));
    fixture.routes.onAcknowledgement(acknowledgement("operation-expired"));
    fixture.setNow(
      1_000 + BROWSER_GATEWAY_DATA_PLANE_LIMITS.operationDedupeAgeMs,
    );

    expect(
      fixture.routes.lookupOperation(context(), "operation-expired"),
    ).toEqual({ status: 404, payload: { error: "operation_not_found" } });
    fixture.routes.close();
  });

  it("fails closed on missing, duplicate, disabled, and expired-owner capabilities", () => {
    const missing = makeFixture({ capabilities: [] });
    expect(missing.routes.handle(context(), request("missing"))).toMatchObject({
      status: 409,
      payload: { error: "capability_unavailable", state: "unavailable" },
    });

    const duplicate = makeFixture();
    duplicate.registry.heartbeat({
      ownerId,
      ownerGenerationId,
      now: 1_001,
      capabilities: [
        { capabilityId: "session.select", state: "enabled" },
        { capabilityId: "session.select", state: "disabled" },
      ],
    });
    expect(
      duplicate.routes.handle(context(), request("duplicate")),
    ).toMatchObject({
      status: 409,
      payload: { error: "capability_unavailable" },
    });

    const expired = makeFixture();
    expired.setNow(31_001);
    expect(expired.routes.handle(context(), request("expired"))).toMatchObject({
      status: 409,
      payload: { error: "owner_generation_unavailable" },
    });
    expect(expired.registry.get(ownerId)?.status).toBe("disconnected");
    for (const fixture of [missing, duplicate, expired]) fixture.routes.close();
  });

  it("binds detail handles to the selected helper and owner generation", () => {
    const fixture = makeFixture();
    const detailHandle = {
      helperGenerationId,
      ownerId,
      ownerGenerationId,
      handleId: "detail-1",
      kind: "media" as const,
      byteLength: 3,
      expiresAt: 2_000,
    };
    expect(
      fixture.routes.handle(
        context(),
        request("send-1", {
          kind: "session.send",
          sessionId: "session-1",
          text: "hello",
          detailHandles: [detailHandle],
        }),
      ),
    ).toMatchObject({ status: 202 });
    expect(
      fixture.routes.handle(
        context(),
        request("send-2", {
          kind: "session.send",
          sessionId: "session-1",
          text: "hello",
          detailHandles: [{ ...detailHandle, ownerGenerationId: "stale" }],
        }),
      ),
    ).toMatchObject({
      status: 409,
      payload: { error: "detail_handle_unavailable" },
    });
    fixture.routes.close();
  });

  it("deduplicates matching retries, rejects changed or cross-principal IDs, and caches terminal results", () => {
    const fixture = makeFixture();
    expect(
      fixture.routes.handle(context(), request("operation-1")),
    ).toMatchObject({
      status: 202,
      payload: { duplicate: false },
    });
    expect(
      fixture.routes.handle(context(), request("operation-1")),
    ).toMatchObject({
      status: 202,
      payload: { duplicate: true, operation: { state: "accepted" } },
    });
    expect(
      fixture.routes.handle(
        context(),
        request("operation-1", {
          kind: "session.stop",
          sessionId: "session-1",
        }),
      ),
    ).toMatchObject({ status: 409, payload: { error: "operation_conflict" } });
    expect(
      fixture.routes.handle(
        context({
          sessionKey: "device:2",
          browserConnectionId: "connection-2",
        }),
        request("operation-1", undefined, {
          browserConnectionId: "connection-2",
          csrfNonce: "nonce-2",
        }),
      ),
    ).toMatchObject({ status: 409, payload: { error: "operation_conflict" } });
    expect(fixture.published).toHaveLength(1);

    expect(
      fixture.routes.onAcknowledgement(acknowledgement("operation-1")),
    ).toBe(true);
    expect(
      fixture.routes.handle(context(), request("operation-1")),
    ).toMatchObject({
      status: 202,
      payload: { duplicate: true, operation: { state: "completed" } },
    });
    expect(fixture.published).toHaveLength(1);
    fixture.routes.close();
  });

  it("uses the maximum long deadline and enforces the exact per-owner pending boundary", () => {
    const fixture = makeFixture();
    const long = fixture.routes.handle(
      context(),
      request("long-operation", undefined, { deadlineClass: "long" }),
    );
    expect(long).toMatchObject({
      status: 202,
      payload: {
        deadlineAt:
          1_000 +
          BROWSER_GATEWAY_DATA_PLANE_LIMITS.maximumLongCommandDeadlineMs,
      },
    });
    fixture.routes.close();

    const capped = makeFixture();
    for (
      let index = 0;
      index < BROWSER_GATEWAY_DATA_PLANE_LIMITS.pendingCommandsPerOwner;
      index += 1
    ) {
      if (
        index > 0 &&
        index % BROWSER_GATEWAY_DATA_PLANE_LIMITS.browserCommandBurst === 0
      ) {
        capped.setNow(3_000 + index * 100);
      }
      expect(
        capped.routes.handle(context(), request(`pending-${index}`)),
      ).toMatchObject({ status: 202 });
    }
    capped.setNow(10_000);
    expect(
      capped.routes.handle(context(), request("pending-overflow")),
    ).toMatchObject({
      status: 429,
      payload: { error: "owner_pending_command_limit" },
    });
    capped.routes.close();
  });

  it("enforces the exact helper-wide pending boundary across owners", () => {
    const fixture = makeFixture();
    for (let ownerIndex = 0; ownerIndex < 4; ownerIndex += 1) {
      const currentOwnerId = `owner-${ownerIndex + 1}`;
      const currentGenerationId = `generation-${ownerIndex + 1}`;
      if (ownerIndex > 0) {
        fixture.registry.register({
          ownerId: currentOwnerId,
          ownerKind: "vscode",
          displayName: currentOwnerId,
          scope: {
            kind: "workspace",
            workspaceId: `workspace-${ownerIndex + 1}`,
            displayName: currentOwnerId,
          },
          ownerGenerationId: currentGenerationId,
          now: 1_000,
          capabilities: [{ capabilityId: "session.select", state: "enabled" }],
        });
      }
      for (
        let commandIndex = 0;
        commandIndex <
        BROWSER_GATEWAY_DATA_PLANE_LIMITS.pendingCommandsPerOwner;
        commandIndex += 1
      ) {
        if (
          commandIndex > 0 &&
          commandIndex %
            BROWSER_GATEWAY_DATA_PLANE_LIMITS.browserCommandBurst ===
            0
        ) {
          fixture.setNow(4_000 + ownerIndex * 3_000);
        }
        const connectionId = `connection-${ownerIndex + 1}`;
        expect(
          fixture.routes.handle(
            context({
              sessionKey: `device:${ownerIndex + 1}`,
              browserConnectionId: connectionId,
              subscriptionId: `subscription-${ownerIndex + 1}`,
              ownerId: currentOwnerId,
              ownerGenerationId: currentGenerationId,
            }),
            request(`helper-pending-${ownerIndex}-${commandIndex}`, undefined, {
              browserConnectionId: connectionId,
              csrfNonce: `nonce-${ownerIndex + 1}`,
              subscriptionId: `subscription-${ownerIndex + 1}`,
            }),
          ),
        ).toMatchObject({ status: 202 });
      }
    }

    fixture.registry.register({
      ownerId: "overflow-owner",
      ownerKind: "vscode",
      displayName: "Overflow",
      scope: {
        kind: "workspace",
        workspaceId: "overflow-workspace",
        displayName: "Overflow",
      },
      ownerGenerationId: "overflow-generation",
      now: 1_000,
      capabilities: [{ capabilityId: "session.select", state: "enabled" }],
    });
    expect(
      fixture.routes.handle(
        context({
          sessionKey: "device:overflow",
          browserConnectionId: "connection-overflow",
          subscriptionId: "subscription-overflow",
          ownerId: "overflow-owner",
          ownerGenerationId: "overflow-generation",
        }),
        request("helper-pending-overflow", undefined, {
          browserConnectionId: "connection-overflow",
          csrfNonce: "nonce-overflow",
          subscriptionId: "subscription-overflow",
        }),
      ),
    ).toMatchObject({
      status: 429,
      payload: { error: "helper_pending_command_limit" },
    });
    fixture.routes.close();
  });

  it("enforces connection and authenticated-session token buckets", () => {
    const fixture = makeFixture();
    for (
      let index = 0;
      index < BROWSER_GATEWAY_DATA_PLANE_LIMITS.browserCommandBurst;
      index += 1
    ) {
      expect(
        fixture.routes.handle(context(), request(`operation-${index}`)),
      ).toMatchObject({ status: 202 });
    }
    expect(
      fixture.routes.handle(context(), request("operation-limited")),
    ).toMatchObject({
      status: 429,
      payload: { error: "command_rate_limited" },
    });
    fixture.setNow(1_100);
    expect(
      fixture.routes.handle(context(), request("operation-refilled")),
    ).toMatchObject({ status: 202 });
    fixture.routes.close();
  });

  it("expires idempotent work as failed, non-idempotent work as uncertain, and reconciles late acknowledgements", async () => {
    vi.useFakeTimers();
    const fixture = makeFixture();
    fixture.routes.handle(context(), request("select"));
    fixture.routes.handle(
      context(),
      request("send", {
        kind: "session.send",
        sessionId: "session-1",
        text: "hello",
        detailHandles: [],
      }),
    );

    await vi.advanceTimersByTimeAsync(
      BROWSER_GATEWAY_DATA_PLANE_LIMITS.commandDeadlineMs,
    );
    expect(fixture.cancelled.map((command) => command.operationId)).toEqual([
      "select",
      "send",
    ]);
    expect(fixture.emitted.map((item) => item.operation)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ operationId: "select", state: "failed" }),
        expect.objectContaining({ operationId: "send", state: "uncertain" }),
      ]),
    );
    expect(
      fixture.routes.onAcknowledgement(
        acknowledgement("send", {
          kind: "session.send",
          state: "completed",
        }),
      ),
    ).toBe(true);
    expect(fixture.emitted.at(-1)?.operation).toMatchObject({
      operationId: "send",
      state: "completed",
    });
    fixture.routes.close();
  });

  it("keeps accepted acknowledgements pending and rejects kind mismatches", () => {
    const fixture = makeFixture();
    fixture.routes.handle(context(), request("operation-1"));
    expect(
      fixture.routes.onAcknowledgement(
        acknowledgement("operation-1", { state: "accepted" }),
      ),
    ).toBe(true);
    expect(
      fixture.routes.handle(context(), request("operation-1")),
    ).toMatchObject({
      payload: { operation: { state: "accepted" } },
    });
    expect(
      fixture.routes.onAcknowledgement(
        acknowledgement("operation-1", { kind: "session.stop" }),
      ),
    ).toBe(false);
    fixture.routes.close();
  });

  it("terminates pending operations on generation rollover and drain", () => {
    const fixture = makeFixture();
    fixture.routes.handle(context(), request("rollover"));
    fixture.routes.ownerRegistered(ownerId, "generation-2");
    expect(fixture.emitted.at(-1)?.operation).toMatchObject({
      operationId: "rollover",
      state: "failed",
      message: "owner_generation_changed",
    });

    fixture.registry.register({
      ownerId,
      ownerKind: "vscode",
      displayName: "Owner",
      scope: { kind: "workspace", workspaceId: "ws", displayName: "WS" },
      ownerGenerationId: "generation-2",
      now: 1_000,
      capabilities: [{ capabilityId: "session.send", state: "enabled" }],
    });
    fixture.routes.handle(
      context({ ownerGenerationId: "generation-2" }),
      request(
        "drain",
        {
          kind: "session.send",
          sessionId: "session-1",
          text: "hello",
          detailHandles: [],
        },
        { subscriptionId: "subscription-2" },
      ),
    );
    fixture.routes.beginDrain();
    expect(fixture.emitted.at(-1)?.operation).toMatchObject({
      operationId: "drain",
      state: "uncertain",
      message: "helper_draining",
    });
    expect(fixture.routes.handle(context(), request("rejected"))).toMatchObject(
      {
        status: 503,
        payload: { error: "helper_draining" },
      },
    );
    fixture.routes.close();
  });
});
