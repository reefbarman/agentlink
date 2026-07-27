import type {
  BrowserGatewayDetachedSessionDetail,
  BrowserGatewayDetachedSessionSelection,
} from "../BrowserGatewayService";

import { BROWSER_GATEWAY_DATA_PLANE_LIMITS } from "../dataPlane/limits";

export interface BrowserGatewaySessionDetailRequest extends BrowserGatewayDetachedSessionSelection {
  instanceId: string;
}

export interface DirectSessionDetailOptions {
  authToken: string;
  request: BrowserGatewaySessionDetailRequest;
  buildApiPathForInstance: (pathname: string, instanceId: string) => string;
  signal?: AbortSignal;
  fetch?: typeof globalThis.fetch;
}

export async function requestDirectSessionDetail(
  options: DirectSessionDetailOptions,
): Promise<BrowserGatewayDetachedSessionDetail | null> {
  const query = new URLSearchParams({
    controllerEpoch: options.request.controllerEpoch,
    tabId: options.request.tabId,
    sessionId: options.request.sessionId,
  });
  const pathname = `/api/session-detail?${query}`;
  const response = await (options.fetch ?? globalThis.fetch)(
    options.buildApiPathForInstance(pathname, options.request.instanceId),
    {
      credentials: "same-origin",
      headers: { Authorization: `Bearer ${options.authToken}` },
      signal: options.signal,
    },
  );
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`direct_session_detail_failed_${response.status}`);
  }
  if (
    response.headers.get("Content-Type")?.toLowerCase() !==
    "application/json; charset=utf-8"
  ) {
    throw new Error("direct_session_detail_media_type_invalid");
  }
  const content = new Uint8Array(await response.arrayBuffer());
  if (
    content.byteLength >
    BROWSER_GATEWAY_DATA_PLANE_LIMITS.authenticatedSessionDetailResponseBytes
  ) {
    throw new Error("direct_session_detail_too_large");
  }
  return parseSessionDetail(content, options.request, "direct");
}

export function parseSessionDetail(
  content: Uint8Array,
  request: BrowserGatewayDetachedSessionSelection,
  transport: "direct" | "relay",
): BrowserGatewayDetachedSessionDetail {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(content));
  } catch {
    throw new Error(`${transport}_session_detail_json_invalid`);
  }
  if (
    !isRecord(value) ||
    !isRecord(value.selection) ||
    !isRecord(value.session)
  ) {
    throw new Error(`${transport}_session_detail_payload_invalid`);
  }
  if (
    value.selection.controllerEpoch !== request.controllerEpoch ||
    value.selection.tabId !== request.tabId ||
    value.selection.sessionId !== request.sessionId ||
    value.session.sessionId !== request.sessionId ||
    !isRecord(value.ui) ||
    !("revertRecoveryState" in value)
  ) {
    throw new Error(`${transport}_session_detail_identity_mismatch`);
  }
  return value as unknown as BrowserGatewayDetachedSessionDetail;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
