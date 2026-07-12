import {
  ASK_AGENT_ROUTES,
  INTERNAL_CORE_ROUTES,
  INTERNAL_DEVICE_ROUTES,
  PAIRED_BROWSER_ROUTES,
  matchAskAgentRoute,
  matchInternalCoreRoute,
  matchInternalDeviceRoute,
  matchPairedBrowserRoute,
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

  it.each([
    ["Ask Agent", ASK_AGENT_ROUTES],
    ["internal core", INTERNAL_CORE_ROUTES],
    ["paired browser", PAIRED_BROWSER_ROUTES],
    ["internal device", INTERNAL_DEVICE_ROUTES],
  ])("contains no duplicate %s method and path contracts", (_name, routes) => {
    const keys = routes.map((route) => `${route.method} ${route.path}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
