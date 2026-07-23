import { describe, expect, it } from "vitest";

import { BROWSER_GATEWAY_ROUTE_FAMILIES } from "./browserGatewayRouteInventory.js";

describe("browser gateway route auth inventory", () => {
  it("characterizes every current authentication boundary", () => {
    expect(
      new Set(BROWSER_GATEWAY_ROUTE_FAMILIES.map((route) => route.auth)),
    ).toEqual(
      new Set([
        "public",
        "instance-bearer",
        "browser-session",
        "helper-shared-secret",
        "helper-shared-secret+loopback",
        "instance-bearer+helper-shared-secret",
      ]),
    );
  });

  it("keeps helper owner-plane, internal, and browser APIs on distinct trust boundaries", () => {
    const helperRoutes = BROWSER_GATEWAY_ROUTE_FAMILIES.filter(
      (route) => route.surface === "helper",
    );

    expect(helperRoutes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pathClass: "/internal/core-owners/*, /internal/data-plane/*",
          auth: "helper-shared-secret+loopback",
          notes: expect.stringContaining(
            "forwarded headers cannot grant loopback trust",
          ),
        }),
        expect.objectContaining({
          pathClass: "/internal/* except owner-plane routes",
          auth: "helper-shared-secret",
        }),
        expect.objectContaining({
          pathClass:
            "/api/relay/events, /api/relay/subscription, /api/relay/commands, /api/relay/operations/status, /api/relay/details",
          auth: "browser-session",
          notes: expect.stringContaining("connection-bound CSRF"),
        }),
        expect.objectContaining({
          pathClass: expect.stringContaining("/api/ask-agent/*"),
          auth: "browser-session",
        }),
      ]),
    );
  });

  it("requires dual authentication for sensitive MCP config mutations", () => {
    expect(BROWSER_GATEWAY_ROUTE_FAMILIES).toContainEqual(
      expect.objectContaining({
        surface: "vscode-gateway",
        pathClass: "/internal/ask-agent/mcp-config/server",
        auth: "instance-bearer+helper-shared-secret",
      }),
    );
  });
});
