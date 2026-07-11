/** @vitest-environment jsdom */

import { act, cleanup, render } from "@testing-library/preact";
import { h } from "preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type GatewaySnapshotConnectionOptions,
  useGatewaySnapshotConnection,
} from "./useGatewaySnapshotConnection";

type Snapshot = { id: string };
type Capability = { id: string };

class MockEventSource {
  static instances: MockEventSource[] = [];

  readonly listeners = new Map<
    string,
    Set<(event: MessageEvent<string>) => void>
  >();
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  close = vi.fn();

  constructor(readonly url: string) {
    MockEventSource.instances.push(this);
  }

  addEventListener(
    type: string,
    listener: (event: MessageEvent<string>) => void,
  ): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(
    type: string,
    listener: (event: MessageEvent<string>) => void,
  ): void {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: string, data: string): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(new MessageEvent(type, { data }));
    }
  }
}

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
    MockEventSource.instances = [];
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
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

    expect(MockEventSource.instances).toHaveLength(1);
    expect(MockEventSource.instances[0].url).toBe(
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

    expect(MockEventSource.instances[0].close).toHaveBeenCalledOnce();
    expect(MockEventSource.instances[0].listeners.get("snapshot")?.size).toBe(
      0,
    );
    expect(MockEventSource.instances[0].listeners.get("update")?.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores queued EventSource callbacks after cleanup", () => {
    const options = createOptions();
    const view = render(h(Harness, { options }));
    const source = MockEventSource.instances[0];
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

  it("coalesces rapid stream events to the latest snapshot", () => {
    const options = createOptions();
    render(h(Harness, { options }));
    const source = MockEventSource.instances[0];

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
      MockEventSource.instances[0].onerror?.();
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
