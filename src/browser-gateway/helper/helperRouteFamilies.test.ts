import { ASK_AGENT_ROUTES, matchAskAgentRoute } from "./helperRouteFamilies.js";
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

  it("contains no duplicate method and path contracts", () => {
    const keys = ASK_AGENT_ROUTES.map(
      (route) => `${route.method} ${route.path}`,
    );
    expect(new Set(keys).size).toBe(keys.length);
  });
});
