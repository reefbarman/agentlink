import { describe, expect, it } from "vitest";

import { BrowserGatewayCoreOwnerRegistry } from "./coreOwnerRegistry.js";
import type { CoreSessionScopeDto } from "../core/sessionProtocol.js";

const projectlessScope: CoreSessionScopeDto = {
  kind: "projectless",
  scopeId: "default-ask-agent",
  displayName: "Ask Agent",
};

const workspaceScope: CoreSessionScopeDto = {
  kind: "workspace",
  workspaceId: "workspace-1",
  displayName: "Workspace One",
  rootPathLabel: "/workspace/one",
};

describe("BrowserGatewayCoreOwnerRegistry", () => {
  it("registers a connected projectless gateway owner", () => {
    const registry = new BrowserGatewayCoreOwnerRegistry({
      heartbeatTtlMs: 30_000,
    });

    const record = registry.register({
      ownerId: "gateway-owner",
      ownerKind: "browser-gateway",
      displayName: "Browser Gateway",
      scope: projectlessScope,
      ownerGenerationId: "generation-1",
      now: 100,
      capabilities: [{ capabilityId: "model", state: "enabled" }],
    });

    expect(record).toMatchObject({
      status: "connected",
      ownerGenerationId: "generation-1",
      lastHeartbeatAt: 100,
      owner: {
        ownerId: "gateway-owner",
        ownerKind: "browser-gateway",
        scope: projectlessScope,
        lastHeartbeatAt: 100,
      },
      capabilities: [{ capabilityId: "model", state: "enabled" }],
    });
    expect(registry.requireConnectedOwner("gateway-owner")).toBe(record);
  });

  it("renews heartbeat for the matching owner generation", () => {
    const registry = new BrowserGatewayCoreOwnerRegistry({
      heartbeatTtlMs: 30_000,
    });
    registry.register({
      ownerId: "vscode-owner",
      ownerKind: "vscode",
      displayName: "VS Code",
      scope: workspaceScope,
      ownerGenerationId: "generation-1",
      now: 100,
    });

    const renewed = registry.heartbeat({
      ownerId: "vscode-owner",
      ownerGenerationId: "generation-1",
      now: 1_000,
    });

    expect(renewed?.status).toBe("connected");
    expect(renewed?.lastHeartbeatAt).toBe(1_000);
    expect(renewed?.owner.lastHeartbeatAt).toBe(1_000);
  });

  it("rejects stale heartbeat generations so clients can re-register", () => {
    const registry = new BrowserGatewayCoreOwnerRegistry({
      heartbeatTtlMs: 30_000,
    });
    registry.register({
      ownerId: "vscode-owner",
      ownerKind: "vscode",
      displayName: "VS Code",
      scope: workspaceScope,
      ownerGenerationId: "generation-2",
      now: 500,
    });

    const stale = registry.heartbeat({
      ownerId: "vscode-owner",
      ownerGenerationId: "generation-1",
      now: 1_000,
    });

    expect(stale).toBeUndefined();
    expect(registry.get("vscode-owner")?.ownerGenerationId).toBe(
      "generation-2",
    );
    expect(registry.get("vscode-owner")?.lastHeartbeatAt).toBe(500);
  });

  it("marks connected owners disconnected when heartbeat expires", () => {
    const registry = new BrowserGatewayCoreOwnerRegistry({
      heartbeatTtlMs: 100,
    });
    registry.register({
      ownerId: "vscode-owner",
      ownerKind: "vscode",
      displayName: "VS Code",
      scope: workspaceScope,
      ownerGenerationId: "generation-1",
      now: 100,
    });

    expect(registry.list(201)[0].status).toBe("disconnected");
    expect(() => registry.requireConnectedOwner("vscode-owner")).toThrow(
      "browser_gateway_core_owner_unavailable",
    );
  });

  it("does not disconnect owners at the exact heartbeat ttl boundary", () => {
    const registry = new BrowserGatewayCoreOwnerRegistry({
      heartbeatTtlMs: 100,
    });
    registry.register({
      ownerId: "vscode-owner",
      ownerKind: "vscode",
      displayName: "VS Code",
      scope: workspaceScope,
      ownerGenerationId: "generation-1",
      now: 100,
    });

    expect(registry.list(200)[0].status).toBe("connected");
  });

  it("lets a reconnecting owner replace a disconnected generation", () => {
    const registry = new BrowserGatewayCoreOwnerRegistry({
      heartbeatTtlMs: 100,
    });
    registry.register({
      ownerId: "vscode-owner",
      ownerKind: "vscode",
      displayName: "VS Code",
      scope: workspaceScope,
      ownerGenerationId: "generation-1",
      now: 100,
    });
    registry.list(250);

    const reconnected = registry.register({
      ownerId: "vscode-owner",
      ownerKind: "vscode",
      displayName: "VS Code",
      scope: workspaceScope,
      ownerGenerationId: "generation-2",
      now: 300,
    });

    expect(reconnected.status).toBe("connected");
    expect(reconnected.ownerGenerationId).toBe("generation-2");
    expect(registry.requireConnectedOwner("vscode-owner")).toBe(reconnected);
  });

  it("explicitly marks owners disconnected or errored", () => {
    const registry = new BrowserGatewayCoreOwnerRegistry({
      heartbeatTtlMs: 30_000,
    });
    registry.register({
      ownerId: "vscode-owner",
      ownerKind: "vscode",
      displayName: "VS Code",
      scope: workspaceScope,
      ownerGenerationId: "generation-1",
      now: 100,
    });

    expect(registry.markDisconnected("vscode-owner")?.status).toBe(
      "disconnected",
    );
    expect(registry.markDisconnected("vscode-owner", "error")?.status).toBe(
      "error",
    );
  });
});
