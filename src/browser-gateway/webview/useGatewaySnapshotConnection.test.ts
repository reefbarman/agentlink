/** @vitest-environment jsdom */

import { act, cleanup, render } from "@testing-library/preact";
import { h } from "preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ControllableEventSource,
  ControllableFetch,
} from "./testing/ControllableGatewayTransport";
import {
  type GatewaySnapshotConnectionOptions,
  useGatewaySnapshotConnection,
} from "./useGatewaySnapshotConnection";

type Snapshot = { id: string };
type Capability = { id: string };

function createOptions(
  overrides: Partial<
    GatewaySnapshotConnectionOptions<Snapshot, Capability>
  > = {},
): GatewaySnapshotConnectionOptions<Snapshot, Capability> {
  return {
    authToken: "token",
    tabId: "instance-1",
    generation: 3,
    instanceId: "instance-1",
    askAgentSelected: false,
    routeByInstance: true,
    streamCoalesceMs: 150,
    buildSnapshotApiPath: vi.fn(() => "/api/ui-state?instanceId=instance-1"),
    buildEventsApiPath: vi.fn(() => "/events?instanceId=instance-1"),
    readSnapshotResponse: vi.fn(async () => ({ snapshot: { id: "fallback" } })),
    commitSnapshot: vi.fn(() => true),
    setAskAgentCapabilities: vi.fn(),
    setStatus: vi.fn(),
    fetchModes: vi.fn(async () => undefined),
    fetchModels: vi.fn(async () => undefined),
    fetchSlashCommands: vi.fn(async () => undefined),
    fetchSessions: vi.fn(async () => undefined),
    fetchDebugInfo: vi.fn(async () => undefined),
    fetchInstances: vi.fn(async () => undefined),
    ...overrides,
  };
}

function Harness({
  options,
}: {
  options: GatewaySnapshotConnectionOptions<Snapshot, Capability>;
}) {
  useGatewaySnapshotConnection(options);
  return null;
}

describe("useGatewaySnapshotConnection", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    ControllableEventSource.reset();
    globalThis.EventSource =
      ControllableEventSource as unknown as typeof EventSource;
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("starts the realtime lifecycle and cleans up listeners and timers", () => {
    const options = createOptions();
    const view = render(h(Harness, { options }));

    expect(ControllableEventSource.instances).toHaveLength(1);
    expect(ControllableEventSource.instances[0].url).toBe(
      "/events?instanceId=instance-1",
    );
    expect(options.fetchModes).toHaveBeenCalledWith("instance-1");
    expect(options.fetchModels).toHaveBeenCalledWith("instance-1", false);
    expect(options.fetchSlashCommands).toHaveBeenCalledWith(
      "instance-1",
      false,
    );
    expect(options.fetchSessions).toHaveBeenCalledWith("instance-1", false);
    expect(options.fetchDebugInfo).toHaveBeenCalledWith("instance-1");
    expect(options.fetchInstances).toHaveBeenCalledWith({
      commitSelection: false,
    });

    view.unmount();

    expect(ControllableEventSource.instances[0].closeCount).toBe(1);
    expect(
      ControllableEventSource.instances[0].listeners.get("snapshot")?.size,
    ).toBe(0);
    expect(
      ControllableEventSource.instances[0].listeners.get("update")?.size,
    ).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores queued EventSource callbacks after cleanup", () => {
    const options = createOptions();
    const view = render(h(Harness, { options }));
    const source = ControllableEventSource.instances[0];
    const queuedOpen = source.onopen;
    const queuedError = source.onerror;

    view.unmount();
    vi.mocked(globalThis.fetch).mockClear();
    vi.mocked(options.setStatus).mockClear();

    act(() => {
      queuedOpen?.();
      queuedError?.();
    });

    expect(source.onopen).toBeNull();
    expect(source.onerror).toBeNull();
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(options.setStatus).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("recovers a delayed stream after the initial fallback starts", async () => {
    const transport = new ControllableFetch();
    globalThis.fetch = transport.fetch as typeof fetch;
    const observeConnection = vi.fn();
    const options = createOptions({ observeConnection, now: Date.now });
    render(h(Harness, { options }));
    const source = ControllableEventSource.instances[0];

    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(transport.pendingRequests).toHaveLength(1);

    act(() => {
      vi.advanceTimersByTime(250);
      source.open();
      vi.advanceTimersByTime(50);
      source.emit("snapshot", JSON.stringify({ id: "stream-won" }));
    });
    await act(async () => Promise.resolve());

    expect(transport.requests).toHaveLength(1);
    expect(transport.requests[0].signal?.aborted).toBe(true);
    expect(options.commitSnapshot).toHaveBeenCalledOnce();
    expect(options.commitSnapshot).toHaveBeenCalledWith(
      { id: "stream-won" },
      "instance-1",
      3,
    );
    expect(observeConnection.mock.calls).toEqual([
      [{ phase: "created", elapsedMs: 0 }],
      [{ phase: "open", elapsedMs: 750 }],
      [{ phase: "first_commit", elapsedMs: 800 }],
    ]);
  });

  it("reproduces an open-but-stalled stream recovered only by initial fallback", async () => {
    const transport = new ControllableFetch();
    globalThis.fetch = transport.fetch as typeof fetch;
    const observeConnection = vi.fn();
    const options = createOptions({ observeConnection, now: Date.now });
    render(h(Harness, { options }));
    const source = ControllableEventSource.instances[0];

    act(() => {
      vi.advanceTimersByTime(100);
      source.open();
      vi.advanceTimersByTime(400);
    });
    expect(options.setStatus).toHaveBeenLastCalledWith("Connected");
    expect(transport.pendingRequests).toHaveLength(1);
    expect(observeConnection.mock.calls).toEqual([
      [{ phase: "created", elapsedMs: 0 }],
      [{ phase: "open", elapsedMs: 100 }],
    ]);

    transport.requests[0].respond("{}", { status: 200 });
    await act(async () => {
      await transport.requests[0].promise;
      await Promise.resolve();
    });

    expect(options.commitSnapshot).toHaveBeenCalledWith(
      { id: "fallback" },
      "instance-1",
      3,
    );
    expect(options.setStatus).toHaveBeenLastCalledWith(
      "Connected (fallback polling)",
    );
    expect(observeConnection).not.toHaveBeenCalledWith(
      expect.objectContaining({ phase: "first_commit" }),
    );
  });

  it("records stream open separately from the first committed event", () => {
    let clock = 10_000;
    const observeConnection = vi.fn();
    const options = createOptions({
      observeConnection,
      now: () => clock,
    });
    render(h(Harness, { options }));
    const source = ControllableEventSource.instances[0];

    expect(observeConnection).toHaveBeenCalledWith({
      phase: "created",
      elapsedMs: 0,
    });

    act(() => {
      clock += 25;
      source.open();
      clock += 75;
      // The first event intentionally bypasses the coalescing window.
      source.emit("snapshot", JSON.stringify({ id: "first" }));
      clock += 50;
      source.emit("update", JSON.stringify({ id: "second" }));
    });

    expect(observeConnection.mock.calls).toEqual([
      [{ phase: "created", elapsedMs: 0 }],
      [{ phase: "open", elapsedMs: 25 }],
      [{ phase: "first_commit", elapsedMs: 100 }],
    ]);
  });

  it("stops fallback polling when a failed stream reopens and commits", async () => {
    const transport = new ControllableFetch();
    globalThis.fetch = transport.fetch as typeof fetch;
    const options = createOptions();
    render(h(Harness, { options }));
    const source = ControllableEventSource.instances[0];

    act(() => {
      source.fail();
    });
    expect(transport.pendingRequests).toHaveLength(1);

    act(() => {
      vi.advanceTimersByTime(250);
      source.open();
      vi.advanceTimersByTime(25);
      source.emit("snapshot", JSON.stringify({ id: "reconnected" }));
      vi.advanceTimersByTime(4_000);
    });
    await act(async () => Promise.resolve());

    expect(transport.requests).toHaveLength(1);
    expect(transport.requests[0].signal?.aborted).toBe(true);
    expect(options.commitSnapshot).toHaveBeenCalledWith(
      { id: "reconnected" },
      "instance-1",
      3,
    );
    expect(options.setStatus).toHaveBeenLastCalledWith("Connected");
  });

  it("records reconnect cycles from the preceding stream error", () => {
    const observeConnection = vi.fn();
    const options = createOptions({ observeConnection, now: Date.now });
    render(h(Harness, { options }));
    const source = ControllableEventSource.instances[0];

    act(() => {
      vi.advanceTimersByTime(40);
      source.fail();
      vi.advanceTimersByTime(15);
      source.open();
      vi.advanceTimersByTime(20);
      source.emit("snapshot", JSON.stringify({ id: "reconnected" }));
    });

    expect(observeConnection.mock.calls).toEqual([
      [{ phase: "created", elapsedMs: 0 }],
      [{ phase: "error", elapsedMs: 40 }],
      [{ phase: "open", elapsedMs: 15 }],
      [{ phase: "first_commit", elapsedMs: 35 }],
    ]);
  });

  it("coalesces rapid stream events to the latest snapshot", () => {
    const options = createOptions();
    render(h(Harness, { options }));
    const source = ControllableEventSource.instances[0];

    act(() => {
      source.emit("snapshot", JSON.stringify({ id: "first" }));
      vi.advanceTimersByTime(10);
      source.emit("update", JSON.stringify({ id: "second" }));
      source.emit("update", JSON.stringify({ id: "latest" }));
    });

    expect(options.commitSnapshot).toHaveBeenCalledTimes(1);
    expect(options.commitSnapshot).toHaveBeenLastCalledWith(
      { id: "first" },
      "instance-1",
      3,
    );

    act(() => {
      vi.advanceTimersByTime(140);
    });

    expect(options.commitSnapshot).toHaveBeenCalledTimes(2);
    expect(options.commitSnapshot).toHaveBeenLastCalledWith(
      { id: "latest" },
      "instance-1",
      3,
    );
    expect(options.setStatus).toHaveBeenLastCalledWith("Connected");
  });

  it("falls back to authenticated polling after a stream error", async () => {
    const fetchMock = vi.mocked(globalThis.fetch);
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
    const options = createOptions({
      readSnapshotResponse: vi.fn(async () => ({
        snapshot: { id: "fallback" },
        askAgentCapabilities: [{ id: "model-auth" }],
      })),
    });
    render(h(Harness, { options }));

    await act(async () => {
      ControllableEventSource.instances[0].fail();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/ui-state?instanceId=instance-1",
      expect.objectContaining({
        credentials: "same-origin",
        headers: { Authorization: "Bearer token" },
        signal: expect.any(AbortSignal),
      }),
    );
    expect(options.commitSnapshot).toHaveBeenCalledWith(
      { id: "fallback" },
      "instance-1",
      3,
    );
    expect(options.setAskAgentCapabilities).toHaveBeenCalledWith([
      { id: "model-auth" },
    ]);
    expect(options.setStatus).toHaveBeenLastCalledWith(
      "Connected (fallback polling)",
    );
  });
});
