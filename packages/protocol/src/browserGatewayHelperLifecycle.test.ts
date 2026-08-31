import {
  BROWSER_GATEWAY_DATA_PLANE_FEATURES,
  BROWSER_GATEWAY_HELPER_PROTOCOL_VERSION,
  type BrowserGatewayDataPlaneFeature,
  type BrowserGatewayHelperDiscoveryRecord,
  type BrowserGatewayHelperHealthResponse,
} from "./browserGatewayHelperLifecycle.js";
import { describe, expect, it } from "vitest";

describe("browser gateway helper lifecycle", () => {
  it("pins the helper protocol version and advertised feature union", () => {
    const features: BrowserGatewayDataPlaneFeature[] = [
      "typed-background-results-v1",
    ];

    expect(BROWSER_GATEWAY_HELPER_PROTOCOL_VERSION).toBe(2);
    expect(BROWSER_GATEWAY_DATA_PLANE_FEATURES).toEqual(features);
  });

  it("shares discovery and health identity across lifecycle boundaries", () => {
    const discovery: BrowserGatewayHelperDiscoveryRecord = {
      pid: 42,
      port: 47137,
      url: "http://127.0.0.1:47137",
      protocolVersion: BROWSER_GATEWAY_HELPER_PROTOCOL_VERSION,
      startedAt: "2026-08-31T00:00:00.000Z",
      lastHeartbeatAt: "2026-08-31T00:00:01.000Z",
      helperVersion: "1.20.1",
      helperGenerationId: "helper-generation-1",
      dataPlaneMode: "on",
      dataPlaneFeatures: [...BROWSER_GATEWAY_DATA_PLANE_FEATURES],
      browserBootstrapToken: "bootstrap-token",
      clientSharedSecret: "shared-secret",
    };
    const health: BrowserGatewayHelperHealthResponse = {
      status: "ok",
      protocolVersion: discovery.protocolVersion,
      helperVersion: discovery.helperVersion,
      startedAt: discovery.startedAt,
      now: discovery.lastHeartbeatAt,
      uptimeMs: 1_000,
      activeClientLeases: 1,
      helperGenerationId: discovery.helperGenerationId,
      dataPlaneMode: discovery.dataPlaneMode,
      dataPlaneFeatures: discovery.dataPlaneFeatures,
      coreOwners: 2,
    };

    expect(health).toMatchObject({
      status: "ok",
      protocolVersion: 2,
      helperVersion: "1.20.1",
      helperGenerationId: "helper-generation-1",
      dataPlaneMode: "on",
      dataPlaneFeatures: ["typed-background-results-v1"],
      uptimeMs: 1_000,
      activeClientLeases: 1,
      coreOwners: 2,
    });
  });
});
