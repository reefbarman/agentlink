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
      "session.send",
      "session.stop",
    ]);
  });

  it("maps select, text-only send, and stop commands to ChatViewProvider", async () => {
    const commandTarget = target();
    const executor = new ProductionBrowserGatewayOwnerCommandExecutor(
      commandTarget,
    );
    const signal = new AbortController().signal;

    await executor.execute(
      { kind: "session.select", sessionId: "session-1" },
      signal,
    );
    await executor.execute(
      {
        kind: "session.send",
        sessionId: "session-1",
        text: "Continue",
        detailHandles: [],
      },
      signal,
    );
    await executor.execute(
      { kind: "session.stop", sessionId: "session-1" },
      signal,
    );

    expect(commandTarget.submitBrowserLoadSession).toHaveBeenCalledWith(
      "session-1",
    );
    expect(commandTarget.submitBrowserSend).toHaveBeenCalledWith({
      sessionId: "session-1",
      text: "Continue",
    });
    expect(commandTarget.submitBrowserStop).toHaveBeenCalledWith("session-1");
  });

  it("rejects send detail handles before invoking ChatViewProvider", async () => {
    const commandTarget = target();
    const executor = new ProductionBrowserGatewayOwnerCommandExecutor(
      commandTarget,
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
    );

    await expect(
      executor.execute(
        { kind: "session.select", sessionId: "missing" },
        new AbortController().signal,
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
      ),
    ).rejects.toThrow(
      "browser_gateway_session_send_failed:project_unavailable",
    );
    await expect(
      executor.execute(
        { kind: "session.stop", sessionId: "missing" },
        new AbortController().signal,
      ),
    ).rejects.toThrow("browser_gateway_session_stop_failed");

    const controller = new AbortController();
    controller.abort();
    await expect(
      executor.execute(
        { kind: "session.stop", sessionId: "session-1" },
        controller.signal,
      ),
    ).rejects.toThrow("browser_gateway_owner_command_cancelled");
  });
});
