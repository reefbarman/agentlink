import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { McpClientHub } from "@agentlink/node-host";
import type { McpSessionContext } from "../core/capabilities/mcp.js";
import type { OnApprovalRequest } from "@agentlink/protocol/inline-approval";
import { createSessionMcpResourceWatches } from "./mcpResourceWatchRuntime.js";

type SubscriptionOptions = Parameters<McpClientHub["subscribeResources"]>[3];

function fixture(decision = "deliver") {
  let subscription: SubscriptionOptions | undefined;
  const sessionContext: McpSessionContext = {
    sessionId: "session-distinct",
    label: "Distinct resource session",
    kind: "background",
    parentSessionId: "parent-distinct",
  };
  const readResource = vi.fn<McpClientHub["readResource"]>().mockResolvedValue({
    content: [{ type: "text", text: "snapshot" }],
  });
  const dispose = vi.fn().mockResolvedValue(undefined);
  const subscribeResources = vi
    .fn<McpClientHub["subscribeResources"]>()
    .mockImplementation(async (_server, _sessionId, _uris, options) => {
      subscription = options;
      return { dispose };
    });
  const getServerConfig = vi.fn().mockReturnValue({
    command: "test-mcp",
    env: { API_KEY: "not-for-ui" },
  });
  const hub = {
    getServerConfig,
    subscribeResources,
    readResource,
  } as unknown as McpClientHub;
  const requestApproval = vi
    .fn<OnApprovalRequest>()
    .mockResolvedValue(decision);
  const onPending = vi.fn();
  const isActive = vi.fn().mockReturnValue(true);
  const controller = createSessionMcpResourceWatches({
    sessionId: "session-distinct",
    getHub: () => hub,
    getSessionContext: () => sessionContext,
    requestApproval,
    isActive,
    onChange: vi.fn(),
    onPending,
  });
  return {
    controller,
    readResource,
    subscribeResources,
    requestApproval,
    onPending,
    getServerConfig,
    isActive,
    sessionContext,
    dispose,
    get subscription() {
      return subscription!;
    },
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("session MCP resource-watch composition", () => {
  it("uses exact human-only resource consent and forwards session context through subscription and non-interactive reads", async () => {
    const f = fixture();
    const uri = "testbed://note/a?variant=exact";
    await expect(
      f.controller.watch("notes", uri, "deliver"),
    ).resolves.toMatchObject({ ok: true });
    await vi.advanceTimersByTimeAsync(0);

    expect(f.requestApproval).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        id: expect.stringContaining("mcp-resource:session-distinct:"),
        kind: "mcp",
        toolOrigin: "mcp-resource",
        mcpServerName: "notes",
        mcpToolName: uri,
        humanOnlyReason: expect.stringContaining("explicit session consent"),
        choices: [
          { label: "Notify only", value: "notify" },
          { label: "Deliver automatically", value: "deliver" },
          { label: "Deliver and wake", value: "wake" },
          { label: "Deny", value: "deny", isDanger: true },
        ],
      }),
      "session-distinct",
    );
    expect(JSON.stringify(f.requestApproval.mock.calls)).not.toContain(
      "not-for-ui",
    );
    expect(f.subscribeResources).toHaveBeenCalledExactlyOnceWith(
      "notes",
      "session-distinct",
      [uri],
      expect.objectContaining({ sessionContext: f.sessionContext }),
    );
    expect(f.readResource).toHaveBeenCalledExactlyOnceWith("notes", uri, {
      sessionContext: f.sessionContext,
      interactive: false,
      signal: expect.any(AbortSignal),
    });

    const initial = f.controller.reservePending({ idle: false })!;
    expect(f.controller.commitPending(initial)).toBe(true);
    f.readResource.mockResolvedValueOnce({
      content: [{ type: "text", text: "updated" }],
    });
    f.subscription.onUpdated(uri);
    await vi.advanceTimersByTimeAsync(5_000);
    const batch = f.controller.reservePending({ idle: false })!;
    expect(batch.updates).toEqual([
      expect.objectContaining({ server: "notes", uri, text: "updated" }),
    ]);
    expect(f.readResource.mock.calls[1]?.[2]).toEqual({
      sessionContext: f.sessionContext,
      interactive: false,
      signal: expect.any(AbortSignal),
    });
    expect(f.controller.reservePending({ idle: true })).toBeUndefined();
    await f.controller.dispose();
  });

  it.each(["allow", "allow-always", "approve", "deny"])(
    "does not turn ordinary tool approval %s into a resource grant",
    async (decision) => {
      const f = fixture(decision);
      await expect(
        f.controller.watch("notes", "testbed://note/a", "wake"),
      ).resolves.toMatchObject({ ok: false });
      await vi.advanceTimersByTimeAsync(0);
      expect(f.subscribeResources).not.toHaveBeenCalled();
      expect(f.readResource).not.toHaveBeenCalled();
      expect(f.controller.snapshot()).toEqual([]);
      await f.controller.dispose();
    },
  );

  it.each(["stop", "unwatch", "close"])(
    "aborts in-flight reads and rejects late callbacks after %s",
    async (action) => {
      const f = fixture("wake");
      let resolveRead!: (
        result: Awaited<ReturnType<McpClientHub["readResource"]>>,
      ) => void;
      f.readResource.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveRead = resolve;
          }),
      );
      await f.controller.watch("notes", "testbed://note/a", "wake");
      await vi.advanceTimersByTimeAsync(0);
      const callback = f.subscription;
      const signal = f.readResource.mock.calls[0]![2]!.signal!;
      if (action === "stop") f.controller.pauseAll();
      else if (action === "unwatch")
        f.controller.unwatch("notes", "testbed://note/a");
      else await f.controller.dispose();
      expect(signal.aborted).toBe(true);
      resolveRead({ content: [{ type: "text", text: "late untrusted data" }] });
      callback.onUpdated("testbed://note/a");
      callback.onReconnected?.();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(f.onPending).not.toHaveBeenCalled();
      expect(f.controller.reservePending({ idle: true })).toBeUndefined();
      expect(f.readResource).toHaveBeenCalledTimes(1);
      await f.controller.dispose();
    },
  );

  it.each([
    {
      content: [{ type: "text" as const, text: "authentication needed" }],
      isError: true,
    },
    {
      content: [
        { type: "image" as const, data: "AA==", mimeType: "image/png" },
      ],
    },
  ])(
    "pauses rather than delivering errors or non-text content",
    async (result) => {
      const f = fixture();
      f.readResource.mockResolvedValue(result);
      await f.controller.watch("notes", "testbed://note/a", "deliver");
      await vi.advanceTimersByTimeAsync(0);
      expect(f.controller.snapshot()).toEqual([
        expect.objectContaining({
          paused: true,
          reason: expect.stringContaining("Action required"),
        }),
      ]);
      expect(f.onPending).not.toHaveBeenCalled();
      expect(f.controller.reservePending({ idle: false })).toBeUndefined();
      await f.controller.dispose();
    },
  );
});
