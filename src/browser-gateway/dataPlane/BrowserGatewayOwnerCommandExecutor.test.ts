import { describe, expect, it, vi } from "vitest";

import {
  BROWSER_GATEWAY_PRODUCTION_OWNER_COMMAND_CAPABILITIES,
  ProductionBrowserGatewayOwnerCommandExecutor,
  type BrowserGatewayOwnerCommandTarget,
} from "./BrowserGatewayOwnerCommandExecutor.js";

function target(
  overrides: Partial<BrowserGatewayOwnerCommandTarget> = {},
): BrowserGatewayOwnerCommandTarget {
  return {
    submitBrowserLoadSession: vi.fn(async () => ({ ok: true })),
    submitBrowserSend: vi.fn(async () => ({ ok: true })),
    submitBrowserStop: vi.fn(() => ({ ok: true })),
    ...overrides,
  };
}

describe("ProductionBrowserGatewayOwnerCommandExecutor", () => {
  it("advertises only commands with complete production mappings", () => {
    expect(BROWSER_GATEWAY_PRODUCTION_OWNER_COMMAND_CAPABILITIES).toEqual([
      "session.select",
      "session.detail",
      "session.send",
      "session.stop",
    ]);
  });

  it("maps select, text-only send, and stop commands to ChatViewProvider", async () => {
    const commandTarget = target();
    const executor = new ProductionBrowserGatewayOwnerCommandExecutor(
      commandTarget,
      "instance-1",
      vi.fn(() => null),
    );
    const signal = new AbortController().signal;

    await executor.execute(
      { kind: "session.select", sessionId: "session-1" },
      signal,
      "select-operation-1",
    );
    await executor.execute(
      {
        kind: "session.send",
        sessionId: "session-1",
        text: "Continue",
        detailHandles: [],
      },
      signal,
      "browser-message-1",
    );
    await executor.execute(
      { kind: "session.stop", sessionId: "session-1" },
      signal,
      "stop-operation-1",
    );

    expect(commandTarget.submitBrowserLoadSession).toHaveBeenCalledWith(
      "session-1",
    );
    expect(commandTarget.submitBrowserSend).toHaveBeenCalledWith({
      sessionId: "session-1",
      id: "browser-message-1",
      text: "Continue",
    });
    expect(commandTarget.submitBrowserStop).toHaveBeenCalledWith("session-1");
  });

  it("returns detached session detail without selecting the VS Code session", async () => {
    const commandTarget = target();
    const getSessionDetail = vi.fn(() => ({
      selection: {
        controllerEpoch: "controller-1",
        tabId: "tab-2",
        sessionId: "session-2",
      },
      session: { sessionId: "session-2", title: "Detached" },
    }));
    const executor = new ProductionBrowserGatewayOwnerCommandExecutor(
      commandTarget,
      "instance-1",
      getSessionDetail as never,
    );

    const result = await executor.execute(
      {
        kind: "session.detail",
        instanceId: "instance-1",
        controllerEpoch: "controller-1",
        tabId: "tab-2",
        sessionId: "session-2",
      },
      new AbortController().signal,
      "detail-operation-1",
    );

    expect(getSessionDetail).toHaveBeenCalledWith({
      controllerEpoch: "controller-1",
      tabId: "tab-2",
      sessionId: "session-2",
    });
    expect(result?.detail).toMatchObject({
      kind: "session",
      mediaType: "application/json; charset=utf-8",
    });
    expect(
      JSON.parse(new TextDecoder().decode(result?.detail?.content)),
    ).toMatchObject({
      selection: { tabId: "tab-2", sessionId: "session-2" },
      session: { sessionId: "session-2", title: "Detached" },
    });
    expect(commandTarget.submitBrowserLoadSession).not.toHaveBeenCalled();

    await expect(
      executor.execute(
        {
          kind: "session.detail",
          instanceId: "another-instance",
          controllerEpoch: "controller-1",
          tabId: "tab-2",
          sessionId: "session-2",
        },
        new AbortController().signal,
        "detail-operation-mismatch",
      ),
    ).rejects.toThrow("browser_gateway_session_detail_instance_mismatch");

    getSessionDetail.mockReturnValue(null as never);
    await expect(
      executor.execute(
        {
          kind: "session.detail",
          instanceId: "instance-1",
          controllerEpoch: "stale-controller",
          tabId: "tab-2",
          sessionId: "session-2",
        },
        new AbortController().signal,
        "detail-operation-stale",
      ),
    ).rejects.toThrow("browser_gateway_session_detail_unavailable");
  });

  it("rejects send detail handles before invoking ChatViewProvider", async () => {
    const commandTarget = target();
    const executor = new ProductionBrowserGatewayOwnerCommandExecutor(
      commandTarget,
      "instance-1",
      vi.fn(() => null),
    );

    await expect(
      executor.execute(
        {
          kind: "session.send",
          sessionId: "session-1",
          text: "See attachment",
          detailHandles: [
            {
              helperGenerationId: "helper-1",
              ownerId: "owner-1",
              ownerGenerationId: "owner-generation-1",
              handleId: "detail-1",
              kind: "media",
              byteLength: 1,
              expiresAt: 10_000,
              mediaType: "application/octet-stream",
            },
          ],
        },
        new AbortController().signal,
        "send-operation-with-details",
      ),
    ).rejects.toThrow("browser_gateway_session_send_details_unsupported");
    expect(commandTarget.submitBrowserSend).not.toHaveBeenCalled();
  });

  it("surfaces rejected target operations and honors cancellation", async () => {
    const commandTarget = target({
      submitBrowserLoadSession: vi.fn(async () => ({ ok: false })),
      submitBrowserSend: vi.fn(async () => ({
        ok: false,
        error: "project_unavailable",
      })),
      submitBrowserStop: vi.fn(() => ({ ok: false })),
    });
    const executor = new ProductionBrowserGatewayOwnerCommandExecutor(
      commandTarget,
      "instance-1",
      vi.fn(() => null),
    );

    await expect(
      executor.execute(
        { kind: "session.select", sessionId: "missing" },
        new AbortController().signal,
        "select-operation-missing",
      ),
    ).rejects.toThrow("browser_gateway_session_select_failed");
    await expect(
      executor.execute(
        {
          kind: "session.send",
          sessionId: "session-1",
          text: "Continue",
          detailHandles: [],
        },
        new AbortController().signal,
        "send-operation-rejected",
      ),
    ).rejects.toThrow(
      "browser_gateway_session_send_failed:project_unavailable",
    );
    await expect(
      executor.execute(
        { kind: "session.stop", sessionId: "missing" },
        new AbortController().signal,
        "stop-operation-missing",
      ),
    ).rejects.toThrow("browser_gateway_session_stop_failed");

    const controller = new AbortController();
    controller.abort();
    await expect(
      executor.execute(
        { kind: "session.stop", sessionId: "session-1" },
        controller.signal,
        "stop-operation-cancelled",
      ),
    ).rejects.toThrow("browser_gateway_owner_command_cancelled");
  });
});
