import { describe, expect, it, vi } from "vitest";

import { BROWSER_GATEWAY_DATA_PLANE_LIMITS } from "../dataPlane/limits";
import {
  parseSessionDetail,
  requestDirectSessionDetail,
  type BrowserGatewaySessionDetailRequest,
} from "./sessionDetailTransport";

const request: BrowserGatewaySessionDetailRequest = {
  instanceId: "instance-1",
  controllerEpoch: "controller-1",
  tabId: "tab / 2",
  sessionId: "session-2",
};

const detail = {
  selection: {
    controllerEpoch: request.controllerEpoch,
    tabId: request.tabId,
    sessionId: request.sessionId,
  },
  session: { sessionId: request.sessionId },
  ui: {
    approval: null,
    question: null,
    questionProgress: null,
    formElicitation: null,
    urlElicitation: null,
  },
  revertRecoveryState: null,
};

function detailResponse(
  body: unknown = detail,
  headers: HeadersInit = {
    "Content-Type": "application/json; charset=utf-8",
  },
): Response {
  return new Response(JSON.stringify(body), { status: 200, headers });
}

describe("requestDirectSessionDetail", () => {
  it("performs an authenticated instance-routed read and validates the payload", async () => {
    const fetch = vi.fn(async () => detailResponse());
    const buildApiPathForInstance = vi.fn(
      (pathname: string, instanceId: string) =>
        `${pathname}&instanceId=${encodeURIComponent(instanceId)}`,
    );
    const signal = new AbortController().signal;

    await expect(
      requestDirectSessionDetail({
        authToken: "token-1",
        request,
        buildApiPathForInstance,
        signal,
        fetch: fetch as unknown as typeof globalThis.fetch,
      }),
    ).resolves.toEqual(detail);

    expect(buildApiPathForInstance).toHaveBeenCalledOnce();
    expect(buildApiPathForInstance.mock.calls[0]?.[1]).toBe("instance-1");
    expect(buildApiPathForInstance.mock.calls[0]?.[0]).toContain(
      "controllerEpoch=controller-1",
    );
    expect(buildApiPathForInstance.mock.calls[0]?.[0]).toContain(
      "tabId=tab+%2F+2",
    );
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("instanceId=instance-1"),
      {
        credentials: "same-origin",
        headers: { Authorization: "Bearer token-1" },
        signal,
      },
    );
  });

  it("returns null for stale selections", async () => {
    const fetch = vi.fn(async () => new Response("{}", { status: 404 }));
    await expect(
      requestDirectSessionDetail({
        authToken: "token-1",
        request,
        buildApiPathForInstance: (pathname) => pathname,
        fetch: fetch as unknown as typeof globalThis.fetch,
      }),
    ).resolves.toBeNull();
  });

  it("rejects unsuccessful responses and unexpected media types", async () => {
    await expect(
      requestDirectSessionDetail({
        authToken: "token-1",
        request,
        buildApiPathForInstance: (pathname) => pathname,
        fetch: vi.fn(async () => new Response("{}", { status: 500 })) as never,
      }),
    ).rejects.toThrow("direct_session_detail_failed_500");

    await expect(
      requestDirectSessionDetail({
        authToken: "token-1",
        request,
        buildApiPathForInstance: (pathname) => pathname,
        fetch: vi.fn(async () =>
          detailResponse(detail, {
            "Content-Type": "application/json",
          }),
        ) as never,
      }),
    ).rejects.toThrow("direct_session_detail_media_type_invalid");
  });

  it("rejects responses above the authenticated detail byte limit", async () => {
    const content = new Uint8Array(
      BROWSER_GATEWAY_DATA_PLANE_LIMITS.authenticatedDetailResponseBytes + 1,
    );
    await expect(
      requestDirectSessionDetail({
        authToken: "token-1",
        request,
        buildApiPathForInstance: (pathname) => pathname,
        fetch: vi.fn(
          async () =>
            new Response(content, {
              status: 200,
              headers: {
                "Content-Type": "application/json; charset=utf-8",
              },
            }),
        ) as never,
      }),
    ).rejects.toThrow("direct_session_detail_too_large");
  });
});

describe("parseSessionDetail", () => {
  it("rejects malformed and mismatched direct payloads", () => {
    expect(() =>
      parseSessionDetail(new TextEncoder().encode("{"), request, "direct"),
    ).toThrow("direct_session_detail_json_invalid");
    expect(() =>
      parseSessionDetail(
        new TextEncoder().encode(
          JSON.stringify({ selection: detail.selection }),
        ),
        request,
        "direct",
      ),
    ).toThrow("direct_session_detail_payload_invalid");
    expect(() =>
      parseSessionDetail(
        new TextEncoder().encode(
          JSON.stringify({
            ...detail,
            selection: { ...detail.selection, tabId: "tab-stale" },
          }),
        ),
        request,
        "direct",
      ),
    ).toThrow("direct_session_detail_identity_mismatch");
  });
});
