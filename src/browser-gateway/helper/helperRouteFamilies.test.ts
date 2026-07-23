import {
  ASK_AGENT_ROUTES,
  BROWSER_RELAY_ROUTES,
  INTERNAL_CORE_ROUTES,
  INTERNAL_DATA_PLANE_ROUTES,
  INTERNAL_DEVICE_ROUTES,
  PAIRED_BROWSER_ROUTES,
  PUBLIC_HELPER_EXACT_ROUTES,
  matchAskAgentRoute,
  matchBrowserRelayRoute,
  matchInternalCoreRoute,
  matchInternalDataPlaneRoute,
  matchInternalDeviceRoute,
  matchPairedBrowserRoute,
  matchPublicHelperRoute,
} from "./helperRouteFamilies.js";
import { describe, expect, it } from "vitest";

describe("helper route families", () => {
  it("matches every Ask Agent method and path contract", () => {
    for (const route of ASK_AGENT_ROUTES) {
      expect(matchAskAgentRoute(route.method, route.path)).toEqual({
        method: route.method,
        path: route.path,
        handler: route.handler,
      });
    }
  });

  it("keeps Ask Agent methods exact and unknown paths unmatched", () => {
    expect(matchAskAgentRoute("GET", "/api/ask-agent/send")).toBeNull();
    expect(matchAskAgentRoute("POST", "/api/ask-agent/session")).toBeNull();
    expect(matchAskAgentRoute("POST", "/api/ask-agent/unknown")).toBeNull();
  });

  it("matches every internal core method and path contract", () => {
    for (const route of INTERNAL_CORE_ROUTES) {
      expect(matchInternalCoreRoute(route.method, route.path)).toEqual(route);
    }
  });

  it("keeps internal core methods exact and excludes other internal families", () => {
    expect(matchInternalCoreRoute("GET", "/internal/client/lease")).toBeNull();
    expect(matchInternalCoreRoute("POST", "/internal/shutdown")).toBeNull();
    expect(
      matchInternalCoreRoute("POST", "/internal/pairing/create"),
    ).toBeNull();
  });

  it("matches data-plane routes exactly and keeps them out of core routing", () => {
    for (const route of INTERNAL_DATA_PLANE_ROUTES) {
      expect(matchInternalDataPlaneRoute(route.method, route.path)).toEqual(
        route,
      );
      expect(matchInternalCoreRoute(route.method, route.path)).toBeNull();
    }
    expect(
      matchInternalDataPlaneRoute("GET", "/internal/data-plane/publications"),
    ).toBeNull();
    expect(
      matchInternalDataPlaneRoute(
        "POST",
        "/internal/data-plane/publications/extra",
      ),
    ).toBeNull();
  });

  it("matches browser relay routes exactly", () => {
    for (const route of BROWSER_RELAY_ROUTES) {
      expect(matchBrowserRelayRoute(route.method, route.path)).toEqual(route);
    }
    expect(matchBrowserRelayRoute("POST", "/api/relay/events")).toBeNull();
    expect(matchBrowserRelayRoute("GET", "/api/relay/commands")).toBeNull();
    expect(matchBrowserRelayRoute("GET", "/api/relay/unknown")).toBeNull();
  });

  it("matches public pairing and internal device contracts separately", () => {
    for (const route of PAIRED_BROWSER_ROUTES) {
      expect(matchPairedBrowserRoute(route.method, route.path)).toEqual(route);
      expect(matchInternalDeviceRoute(route.method, route.path)).toBeNull();
    }
    for (const route of INTERNAL_DEVICE_ROUTES) {
      expect(matchInternalDeviceRoute(route.method, route.path)).toEqual(route);
      expect(matchPairedBrowserRoute(route.method, route.path)).toBeNull();
    }
  });

  it("matches public exact and patterned asset contracts", () => {
    for (const route of PUBLIC_HELPER_EXACT_ROUTES) {
      expect(matchPublicHelperRoute(route.method, route.path)).toEqual(route);
    }
    expect(
      matchPublicHelperRoute(
        "GET",
        "/browser-gateway-chunks/mermaid-ABC123.js",
      ),
    ).toEqual({ handler: "browserGatewayChunk" });
    expect(matchPublicHelperRoute("GET", "/browser-gateway-monaco.js")).toEqual(
      {
        method: "GET",
        path: "/browser-gateway-monaco.js",
        handler: "browserGatewayMonacoJs",
      },
    );
    expect(
      matchPublicHelperRoute("GET", "/browser-gateway-monaco.css"),
    ).toEqual({
      method: "GET",
      path: "/browser-gateway-monaco.css",
      handler: "browserGatewayMonacoCss",
    });
    expect(matchPublicHelperRoute("GET", "/monaco-editor.worker.js")).toEqual({
      handler: "monacoWorker",
    });
    expect(
      matchPublicHelperRoute("GET", "/monaco-editor.worker.js.map"),
    ).toEqual({ handler: "monacoWorkerMap" });
    expect(matchPublicHelperRoute("GET", "/codicon.ttf?v=1")).toEqual({
      handler: "codiconFont",
    });
  });

  it("rejects malformed or non-GET public asset paths", () => {
    expect(matchPublicHelperRoute("POST", "/health")).toBeNull();
    expect(matchPublicHelperRoute("GET", "/monaco-../worker.js")).toBeNull();
    expect(
      matchPublicHelperRoute(
        "GET",
        "/browser-gateway-chunks/../browser-gateway.js",
      ),
    ).toBeNull();
    expect(
      matchPublicHelperRoute(
        "GET",
        "/browser-gateway-chunks/mermaid-ABC123.js.map",
      ),
    ).toBeNull();
    expect(
      matchPublicHelperRoute(
        "GET",
        "/browser-gateway-chunks/unexpected-ABC123.css",
      ),
    ).toBeNull();
    expect(matchPublicHelperRoute("GET", "/browser-gateway.js.map")).toBeNull();
  });

  it.each([
    ["Ask Agent", ASK_AGENT_ROUTES],
    ["internal core", INTERNAL_CORE_ROUTES],
    ["internal data plane", INTERNAL_DATA_PLANE_ROUTES],
    ["browser relay", BROWSER_RELAY_ROUTES],
    ["paired browser", PAIRED_BROWSER_ROUTES],
    ["internal device", INTERNAL_DEVICE_ROUTES],
    ["public helper", PUBLIC_HELPER_EXACT_ROUTES],
  ])("contains no duplicate %s method and path contracts", (_name, routes) => {
    const keys = routes.map((route) => `${route.method} ${route.path}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
