import type * as http from "http";

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  HelperHttpRouter,
  type HelperHttpRouterHost,
} from "./HelperHttpRouter.js";

function request(method: string, url: string): http.IncomingMessage {
  return { method, url } as http.IncomingMessage;
}

function response(): http.ServerResponse {
  return {} as http.ServerResponse;
}

describe("HelperHttpRouter", () => {
  let host: HelperHttpRouterHost<{ deviceId: string }>;
  let router: HelperHttpRouter<{ deviceId: string }>;

  beforeEach(() => {
    host = {
      isInternalAuthorized: vi.fn(() => true),
      isOwnerPlaneLoopback: vi.fn(() => true),
      authenticate: vi.fn(async () => ({ deviceId: "device-1" })),
      recordAuthenticatedActivity: vi.fn(),
      handleAskAgent: vi.fn(async () => undefined),
      handleInternalCore: vi.fn(async () => undefined),
      handleInternalDataPlane: vi.fn(async () => undefined),
      handleInternalDevice: vi.fn(async () => undefined),
      handlePairedBrowser: vi.fn(async () => undefined),
      handleBrowserRelay: vi.fn(async () => undefined),
      handlePublic: vi.fn(async () => undefined),
      handleInstances: vi.fn(async () => undefined),
      handleProxy: vi.fn(async () => undefined),
      handleShutdown: vi.fn(),
      writeJson: vi.fn(),
    };
    router = new HelperHttpRouter(47200, host);
  });

  it("keeps internal routes behind shared-secret authorization", async () => {
    vi.mocked(host.isInternalAuthorized).mockReturnValue(false);
    const req = request("POST", "/internal/model-catalog");
    const res = response();

    router.handle(req, res);
    await Promise.resolve();

    expect(host.writeJson).toHaveBeenCalledWith(res, 401, {
      error: "unauthorized",
    });
    expect(host.authenticate).not.toHaveBeenCalled();
    expect(host.handleInternalCore).not.toHaveBeenCalled();
  });

  it("routes internal core, device, shutdown, and not-found separately", async () => {
    const res = response();
    router.handle(request("POST", "/internal/client/lease"), res);
    router.handle(request("GET", "/internal/devices"), res);
    router.handle(request("POST", "/internal/shutdown"), res);
    router.handle(request("GET", "/internal/unknown"), res);
    await Promise.resolve();

    expect(host.handleInternalCore).toHaveBeenCalledWith(
      "clientLease",
      expect.anything(),
      res,
    );
    expect(host.handleInternalDevice).toHaveBeenCalledWith(
      "devices",
      expect.anything(),
      res,
      expect.objectContaining({ pathname: "/internal/devices" }),
    );
    expect(host.handleShutdown).toHaveBeenCalledWith(res);
    expect(host.writeJson).toHaveBeenCalledWith(res, 404, {
      error: "not_found",
    });
  });

  it("routes exact data-plane paths before fallback and requires loopback", async () => {
    const res = response();
    router.handle(request("POST", "/internal/data-plane/publications"), res);
    await Promise.resolve();

    expect(host.handleInternalDataPlane).toHaveBeenCalledWith(
      "publications",
      expect.anything(),
      res,
      expect.objectContaining({
        pathname: "/internal/data-plane/publications",
      }),
    );
    expect(host.handleInternalCore).not.toHaveBeenCalled();
    expect(host.handleProxy).not.toHaveBeenCalled();

    vi.mocked(host.isOwnerPlaneLoopback).mockReturnValue(false);
    router.handle(request("GET", "/internal/data-plane/commands"), res);
    router.handle(request("POST", "/internal/core-owners/register"), res);
    await Promise.resolve();

    expect(host.writeJson).toHaveBeenCalledWith(res, 403, {
      error: "loopback_required",
    });
    expect(host.handleInternalDataPlane).toHaveBeenCalledTimes(1);
    expect(host.handleInternalCore).not.toHaveBeenCalled();

    vi.mocked(host.isOwnerPlaneLoopback).mockReturnValue(true);
    router.handle(
      request("POST", "/internal/ignored/../data-plane/publications"),
      res,
    );
    await Promise.resolve();
    expect(host.writeJson).toHaveBeenCalledWith(res, 404, {
      error: "not_found",
    });
    expect(host.handleInternalDataPlane).toHaveBeenCalledTimes(1);
  });

  it("routes pairing and public assets without browser authentication", async () => {
    const res = response();
    router.handle(request("GET", "/pair"), res);
    router.handle(request("GET", "/browser-gateway.js"), res);
    await Promise.resolve();

    expect(host.handlePairedBrowser).toHaveBeenCalledWith(
      "pairGet",
      expect.anything(),
      res,
    );
    expect(host.handlePublic).toHaveBeenCalledWith(
      "browserGatewayJs",
      "/browser-gateway.js",
      expect.anything(),
      res,
      expect.objectContaining({ pathname: "/browser-gateway.js" }),
    );
    expect(host.authenticate).not.toHaveBeenCalled();
  });

  it("routes exact authenticated relay paths before the legacy proxy", async () => {
    const res = response();
    router.handle(request("GET", "/api/relay/events"), res);
    router.handle(request("POST", "/api/relay/subscription"), res);
    router.handle(request("POST", "/api/relay/commands"), res);
    router.handle(request("POST", "/api/relay/operations/status"), res);
    router.handle(request("GET", "/api/relay/details?handleId=a"), res);
    await vi.waitFor(() => {
      expect(host.handleBrowserRelay).toHaveBeenCalledTimes(5);
    });

    expect(host.handleBrowserRelay).toHaveBeenCalledWith(
      "events",
      { deviceId: "device-1" },
      expect.anything(),
      res,
      expect.objectContaining({ pathname: "/api/relay/events" }),
    );
    expect(host.handleProxy).not.toHaveBeenCalled();

    router.handle(request("GET", "/api/ignored/../relay/events"), res);
    router.handle(request("GET", "/api/relay/commands"), res);
    router.handle(request("GET", "/api/relay/unknown"), res);
    await Promise.resolve();
    expect(host.writeJson).toHaveBeenCalledWith(res, 404, {
      error: "not_found",
    });
    expect(host.handleBrowserRelay).toHaveBeenCalledTimes(5);
    expect(host.handleProxy).not.toHaveBeenCalled();
  });

  it("authenticates Ask Agent, instances, events, and proxy APIs", async () => {
    const res = response();
    router.handle(request("POST", "/api/ask-agent/send"), res);
    router.handle(request("GET", "/api/instances?instanceId=a"), res);
    router.handle(request("GET", "/events?instanceId=a"), res);
    router.handle(request("POST", "/api/send?instanceId=a"), res);
    await vi.waitFor(() => {
      expect(host.recordAuthenticatedActivity).toHaveBeenCalledTimes(4);
    });

    expect(host.handleAskAgent).toHaveBeenCalledWith(
      "send",
      expect.anything(),
      res,
    );
    expect(host.handleInstances).toHaveBeenCalledWith(
      expect.objectContaining({ pathname: "/api/instances" }),
      res,
    );
    expect(host.handleProxy).toHaveBeenCalledTimes(2);
  });

  it("does not invoke authenticated handlers when browser auth fails", async () => {
    vi.mocked(host.authenticate).mockResolvedValue(null);
    const res = response();

    router.handle(request("POST", "/api/ask-agent/send"), res);
    await vi.waitFor(() => {
      expect(host.writeJson).toHaveBeenCalledWith(res, 401, {
        error: "unauthorized",
      });
    });

    expect(host.handleAskAgent).not.toHaveBeenCalled();
    expect(host.recordAuthenticatedActivity).not.toHaveBeenCalled();
  });

  it("returns not found for unmatched non-API routes", () => {
    const res = response();
    router.handle(request("GET", "/missing"), res);
    expect(host.writeJson).toHaveBeenCalledWith(res, 404, {
      error: "not_found",
    });
  });
});
