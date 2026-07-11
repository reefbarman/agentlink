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
      ]),
    );
  });

  it("keeps helper internal and browser APIs on distinct credentials", () => {
    const helperRoutes = BROWSER_GATEWAY_ROUTE_FAMILIES.filter(
      (route) => route.surface === "helper",
    );

    expect(helperRoutes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pathClass: "/internal/*",
          auth: "helper-shared-secret",
        }),
        expect.objectContaining({
          pathClass: expect.stringContaining("/api/ask-agent/*"),
          auth: "browser-session",
        }),
      ]),
    );
  });

  it("keeps VS Code mutations behind the per-instance bearer token", () => {
    expect(BROWSER_GATEWAY_ROUTE_FAMILIES).toContainEqual(
      expect.objectContaining({
        surface: "vscode-gateway",
        pathClass: "/api/* except public reads; /internal/ask-agent/*",
        auth: "instance-bearer",
      }),
    );
  });
});
