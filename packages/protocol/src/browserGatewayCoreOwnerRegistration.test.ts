import type {
  BrowserGatewayCoreOwnerHeartbeat,
  BrowserGatewayCoreOwnerRegistration,
  BrowserGatewayCoreOwnerRegistrationResolution,
  BrowserGatewayCoreOwnerRegistrationResult,
  BrowserGatewayCoreOwnerStatus,
} from "./browserGatewayCoreOwnerRegistration.js";
import { describe, expect, it } from "vitest";

describe("browser gateway core-owner registration", () => {
  it("represents registration and heartbeat requests with capability identity", () => {
    const registration: BrowserGatewayCoreOwnerRegistration<"model"> = {
      ownerId: "owner-1",
      ownerKind: "vscode",
      displayName: "VS Code",
      scope: {
        kind: "workspace",
        workspaceId: "workspace-1",
        displayName: "Workspace One",
      },
      ownerGenerationId: "generation-1",
      capabilities: [{ capabilityId: "model", state: "enabled" }],
      instanceId: "instance-1",
      processId: 42,
      now: 100,
    };
    const heartbeat: BrowserGatewayCoreOwnerHeartbeat<"model"> = {
      ownerId: registration.ownerId,
      ownerGenerationId: registration.ownerGenerationId,
      capabilities: registration.capabilities,
      now: 200,
    };

    expect(heartbeat).toMatchObject({
      ownerId: "owner-1",
      ownerGenerationId: "generation-1",
      now: 200,
    });
  });

  it("keeps owner statuses and collision resolutions aligned with wire results", () => {
    const statuses: BrowserGatewayCoreOwnerStatus[] = [
      "connected",
      "disconnected",
      "starting",
      "error",
    ];
    const resolutions: BrowserGatewayCoreOwnerRegistrationResolution[] = [
      "registered",
      "renewed",
      "superseded",
      "taken_over",
      "collision_assigned",
    ];
    const result: BrowserGatewayCoreOwnerRegistrationResult = {
      requestedOwnerId: "owner-1",
      effectiveOwnerId: "owner-1~generation-2",
      resolution: "collision_assigned",
      registration: {
        owner: {
          ownerId: "owner-1~generation-2",
          ownerKind: "vscode",
          displayName: "VS Code",
          scope: {
            kind: "workspace",
            workspaceId: "workspace-1",
            displayName: "Workspace One",
          },
          acquiredAt: 100,
        },
        status: "connected",
        capabilities: [],
        ownerGenerationId: "generation-2",
      },
    };

    expect(statuses).toContain(result.registration.status);
    expect(resolutions).toContain(result.resolution);
  });
});
