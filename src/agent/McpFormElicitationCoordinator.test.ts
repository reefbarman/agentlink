import { describe, expect, it, vi } from "vitest";

import { McpFormElicitationCoordinator } from "./McpFormElicitationCoordinator.js";

const input = {
  serverName: "fixture",
  message: "Choose",
  fields: [
    {
      kind: "integer" as const,
      name: "count",
      required: true,
      minimum: 1,
      maximum: 3,
    },
  ],
};

function createCoordinator() {
  const publishRequest = vi.fn();
  const publishCleared = vi.fn();
  let id = 0;
  return {
    publishRequest,
    publishCleared,
    coordinator: new McpFormElicitationCoordinator({
      publishRequest,
      publishCleared,
      createId: () => `request-${++id}`,
    }),
  };
}

describe("McpFormElicitationCoordinator", () => {
  it("publishes and resolves queued prompts in FIFO order", () => {
    const { coordinator, publishRequest, publishCleared } = createCoordinator();
    const firstResolve = vi.fn();
    const secondResolve = vi.fn();
    const firstCancel = vi.fn();
    const secondCancel = vi.fn();

    coordinator.enqueue(input, {
      sessionId: "session-1",
      resolve: firstResolve,
      cancel: firstCancel,
    });
    coordinator.enqueue(
      { ...input, message: "Second" },
      {
        sessionId: "session-2",
        resolve: secondResolve,
        cancel: secondCancel,
      },
    );

    expect(publishRequest).toHaveBeenCalledTimes(1);
    expect(coordinator.getActiveRequest()?.id).toBe("request-1");
    expect(
      coordinator.submit({
        id: "request-1",
        action: "accept",
        values: { count: "2" },
      }),
    ).toEqual({ ok: true });
    expect(firstResolve).toHaveBeenCalledWith(
      expect.objectContaining({ count: 2 }),
    );
    expect(firstCancel).not.toHaveBeenCalled();
    expect(publishCleared).toHaveBeenCalledWith("request-1");
    expect(publishRequest).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "request-2", message: "Second" }),
    );

    expect(coordinator.submit({ id: "request-2", action: "cancel" })).toEqual({
      ok: true,
    });
    expect(secondCancel).toHaveBeenCalledOnce();
    expect(secondResolve).not.toHaveBeenCalled();
  });

  it("rejects stale and invalid responses without clearing the active prompt", () => {
    const { coordinator, publishCleared } = createCoordinator();
    const resolve = vi.fn();
    coordinator.enqueue(input, { resolve, cancel: vi.fn() });

    expect(coordinator.submit({ id: "unknown", action: "cancel" })).toEqual({
      ok: false,
      reason: "stale_request",
    });
    expect(
      coordinator.submit({
        id: "request-1",
        action: "accept",
        values: { count: "5" },
      }),
    ).toEqual({
      ok: false,
      reason: "invalid_values",
      errors: { count: expect.stringContaining("at most 3") },
    });
    expect(coordinator.getActiveRequest()?.id).toBe("request-1");
    expect(publishCleared).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
  });

  it("cancels only matching active and queued session prompts", () => {
    const { coordinator, publishRequest, publishCleared } = createCoordinator();
    const firstCancel = vi.fn();
    const secondCancel = vi.fn();
    const thirdCancel = vi.fn();
    coordinator.enqueue(input, {
      sessionId: "session-1",
      resolve: vi.fn(),
      cancel: firstCancel,
    });
    coordinator.enqueue(input, {
      sessionId: "session-1",
      resolve: vi.fn(),
      cancel: secondCancel,
    });
    coordinator.enqueue(input, {
      sessionId: "session-2",
      resolve: vi.fn(),
      cancel: thirdCancel,
    });

    coordinator.cancelSession("session-1");

    expect(firstCancel).toHaveBeenCalledOnce();
    expect(secondCancel).toHaveBeenCalledOnce();
    expect(thirdCancel).not.toHaveBeenCalled();
    expect(publishCleared).toHaveBeenCalledWith("request-1");
    expect(publishRequest).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "request-3" }),
    );
  });

  it("cancels active and queued prompts on dispose", () => {
    const { coordinator, publishCleared } = createCoordinator();
    const activeCancel = vi.fn();
    const queuedCancel = vi.fn();
    coordinator.enqueue(input, { resolve: vi.fn(), cancel: activeCancel });
    coordinator.enqueue(input, { resolve: vi.fn(), cancel: queuedCancel });

    coordinator.dispose();

    expect(activeCancel).toHaveBeenCalledOnce();
    expect(queuedCancel).toHaveBeenCalledOnce();
    expect(publishCleared).toHaveBeenCalledWith("request-1");
    expect(coordinator.getActiveRequest()).toBeUndefined();
  });
});
