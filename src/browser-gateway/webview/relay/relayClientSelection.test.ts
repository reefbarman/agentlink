import { describe, expect, it } from "vitest";

import { BROWSER_GATEWAY_ASK_AGENT_OWNER_ID } from "../../browserGatewayAskAgentIdentity";
import { BROWSER_GATEWAY_ASK_AGENT_TAB_ID } from "../../askAgentTabs";
import type { RelayCatalogOwner } from "./RelayOwnerStore";
import { resolveOwnerForTab } from "./useRelayGatewayConnection";
import { resolveRelayClientEnabled } from "./relayClientSelection";

function owner(ownerId: string, instanceId?: string): RelayCatalogOwner {
  return {
    ownerId,
    ownerGenerationId: `${ownerId}-generation`,
    ownerKind: "vscode",
    displayName: ownerId,
    ...(instanceId ? { instanceId } : {}),
    scope: {
      kind: "workspace",
      workspaceId: `${ownerId}-workspace`,
      displayName: ownerId,
    },
    status: "connected",
    capabilities: [],
    lastHeartbeatAt: 1,
  };
}

describe("relay client selection", () => {
  it("keeps off authoritative and on final", () => {
    for (const override of [undefined, "1", "relay"]) {
      expect(
        resolveRelayClientEnabled({
          dataPlaneMode: "off",
          developmentBuild: true,
          search: override ? `?dataPlane=${override}` : "",
          storedOverride: override,
        }),
      ).toBe(false);
      expect(
        resolveRelayClientEnabled({
          dataPlaneMode: "on",
          developmentBuild: false,
          search: "",
          storedOverride: null,
        }),
      ).toBe(true);
    }
  });

  it("honors shadow override only in development and defaults invalid modes off", () => {
    expect(
      resolveRelayClientEnabled({
        dataPlaneMode: "shadow",
        developmentBuild: false,
        search: "?dataPlane=relay",
      }),
    ).toBe(false);
    expect(
      resolveRelayClientEnabled({
        dataPlaneMode: "shadow",
        developmentBuild: true,
        search: "?dataPlane=relay",
      }),
    ).toBe(true);
    expect(
      resolveRelayClientEnabled({
        dataPlaneMode: "invalid",
        developmentBuild: true,
        search: "?dataPlane=relay",
      }),
    ).toBe(false);
  });

  it("resolves Ask Agent by explicit owner and workspaces by stable instance ID", () => {
    const catalog = [
      owner(BROWSER_GATEWAY_ASK_AGENT_OWNER_ID),
      owner("collision-adjusted-owner", "instance-1"),
      owner("instance-1", "different-instance"),
    ];

    expect(
      resolveOwnerForTab(catalog, BROWSER_GATEWAY_ASK_AGENT_TAB_ID)?.ownerId,
    ).toBe(BROWSER_GATEWAY_ASK_AGENT_OWNER_ID);
    expect(resolveOwnerForTab(catalog, "instance-1")?.ownerId).toBe(
      "collision-adjusted-owner",
    );
    expect(resolveOwnerForTab(catalog, "missing")).toBeUndefined();
  });
});
