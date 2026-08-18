import type * as http from "http";

import { describe, expect, it, vi } from "vitest";

import {
  BrowserGatewayHttpRouter,
  matchesBrowserGatewayRoute,
  type BrowserGatewayHttpRoute,
} from "./browserGatewayHttpRouter.js";

function route(
  match: BrowserGatewayHttpRoute["match"],
  method: BrowserGatewayHttpRoute["method"] = "GET",
): BrowserGatewayHttpRoute {
  return {
    method,
    match,
    error: { kind: "none" },
    invoke: vi.fn(),
  };
}

describe("matchesBrowserGatewayRoute", () => {
  it.each([
    [{ kind: "raw-exact", value: "/health" }, "/health", "/health", true],
    [
      { kind: "raw-exact", value: "/health" },
      "/health?probe=1",
      "/health",
      false,
    ],
    [
      { kind: "path-exact", value: "/api/ui-state" },
      "/api/ui-state?x=1",
      "/api/ui-state",
      true,
    ],
    [
      { kind: "raw-prefix", value: "/api/search-files" },
      "/api/search-files-extra?query=src",
      "/api/search-files-extra",
      true,
    ],
    [
      { kind: "path-prefix", value: "/api/diff/" },
      "/api/diff/request?x=1",
      "/api/diff/request",
      true,
    ],
    [
      { kind: "path-prefix", value: "/api/diff/" },
      "/api/diff",
      "/api/diff",
      false,
    ],
  ] as const)(
    "matches $match.kind routes",
    (match, rawUrl, pathOnly, expected) => {
      expect(
        matchesBrowserGatewayRoute(route(match), "GET", rawUrl, pathOnly),
      ).toBe(expected);
    },
  );

  it("matches wildcard methods without weakening specific method routes", () => {
    const wildcard = route(
      { kind: "path-prefix", value: "/api/plugins/" },
      "*",
    );
    const get = route(
      { kind: "path-exact", value: "/api/plugins/snapshot" },
      "GET",
    );

    expect(
      matchesBrowserGatewayRoute(
        wildcard,
        "PATCH",
        "/api/plugins/snapshot",
        "/api/plugins/snapshot",
      ),
    ).toBe(true);
    expect(
      matchesBrowserGatewayRoute(
        get,
        "POST",
        "/api/plugins/snapshot",
        "/api/plugins/snapshot",
      ),
    ).toBe(false);
  });
});

describe("BrowserGatewayHttpRouter", () => {
  function response(): http.ServerResponse {
    return { headersSent: false } as http.ServerResponse;
  }

  it("keeps an exact GET route ahead of a later wildcard mutation guard", () => {
    const get = route(
      { kind: "path-exact", value: "/api/plugins/snapshot" },
      "GET",
    );
    const wildcard = route(
      { kind: "path-prefix", value: "/api/plugins/" },
      "*",
    );
    const router = new BrowserGatewayHttpRouter([get, wildcard], {
      writeJson: vi.fn(),
      log: vi.fn(),
    });

    router.dispatch(
      { method: "GET", url: "/api/plugins/snapshot" } as http.IncomingMessage,
      response(),
    );
    expect(get.invoke).toHaveBeenCalledOnce();
    expect(wildcard.invoke).not.toHaveBeenCalled();

    router.dispatch(
      {
        method: "DELETE",
        url: "/api/plugins/snapshot",
      } as http.IncomingMessage,
      response(),
    );
    expect(wildcard.invoke).toHaveBeenCalledOnce();
  });

  it("uses the first matching route and writes the existing 404 fallback", () => {
    const first = route({ kind: "raw-prefix", value: "/api/" });
    const second = route({ kind: "raw-exact", value: "/api/specific" });
    const writeJson = vi.fn();
    const router = new BrowserGatewayHttpRouter([first, second], {
      writeJson,
      log: vi.fn(),
    });

    router.dispatch(
      { method: "GET", url: "/api/specific" } as http.IncomingMessage,
      response(),
    );
    expect(first.invoke).toHaveBeenCalled();
    expect(second.invoke).not.toHaveBeenCalled();

    router.dispatch(
      { method: "GET", url: "/missing" } as http.IncomingMessage,
      response(),
    );
    expect(writeJson).toHaveBeenCalledWith(expect.anything(), 404, {
      error: "not_found",
    });
  });

  it("enforces route authorization before invocation", () => {
    const protectedRoute = {
      ...route({ kind: "path-exact", value: "/api/status" }),
      authorize: vi.fn(() => false),
    };
    const writeJson = vi.fn();
    const router = new BrowserGatewayHttpRouter([protectedRoute], {
      writeJson,
      log: vi.fn(),
    });
    const res = response();

    router.dispatch(
      { method: "GET", url: "/api/status?x=1" } as http.IncomingMessage,
      res,
    );

    expect(protectedRoute.invoke).not.toHaveBeenCalled();
    expect(writeJson).toHaveBeenCalledWith(res, 401, { error: "unauthorized" });
  });

  it.each([
    [
      "invalid-json-or-internal",
      new Error("invalid_json"),
      400,
      "invalid_json",
    ],
    ["invalid-json-or-internal", new Error("boom"), 500, "internal_error"],
    ["internal", new Error("invalid_json"), 500, "internal_error"],
  ] as const)(
    "preserves the %s rejection policy",
    async (kind, error, status, errorCode) => {
      const writeJson = vi.fn();
      const log = vi.fn();
      const asyncRoute: BrowserGatewayHttpRoute = {
        method: "POST",
        match: { kind: "raw-exact", value: "/api/action" },
        error: { kind, logLabel: "action failed" },
        invoke: async () => Promise.reject(error),
      };
      const router = new BrowserGatewayHttpRouter([asyncRoute], {
        writeJson,
        log,
      });
      const res = response();

      router.dispatch(
        { method: "POST", url: "/api/action" } as http.IncomingMessage,
        res,
      );
      await vi.waitFor(() => {
        expect(writeJson).toHaveBeenCalledWith(res, status, {
          error: errorCode,
        });
      });
      expect(log).toHaveBeenCalledWith(
        `[browser-gateway] action failed: ${error}`,
      );
    },
  );
});
