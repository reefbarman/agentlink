import { useEffect } from "preact/hooks";

export interface GatewaySnapshotReadResult<TSnapshot, TCapability> {
  snapshot: TSnapshot;
  askAgentCapabilities?: TCapability[];
}

export interface GatewaySnapshotConnectionObservation {
  phase: "created" | "open" | "first_commit" | "error";
  elapsedMs: number;
}

export interface GatewaySnapshotConnectionOptions<TSnapshot, TCapability> {
  enabled?: boolean;
  authToken: string;
  tabId: string;
  generation: number;
  instanceId: string;
  askAgentSelected: boolean;
  routeByInstance: boolean;
  streamCoalesceMs: number;
  buildSnapshotApiPath: () => string;
  buildEventsApiPath: (instanceId: string, askAgentSelected: boolean) => string;
  readSnapshotResponse: (
    response: Response,
  ) => Promise<GatewaySnapshotReadResult<TSnapshot, TCapability>>;
  commitSnapshot: (
    snapshot: TSnapshot,
    tabId: string,
    generation: number,
  ) => boolean;
  setAskAgentCapabilities: (capabilities: TCapability[]) => void;
  setStatus: (status: string) => void;
  fetchModes: (instanceId: string) => Promise<unknown>;
  fetchModels: (
    instanceId: string,
    askAgentSelected: boolean,
  ) => Promise<unknown>;
  fetchSlashCommands: (
    instanceId: string,
    askAgentSelected: boolean,
  ) => Promise<unknown>;
  fetchSessions: (
    instanceId: string,
    askAgentSelected: boolean,
  ) => Promise<unknown>;
  fetchDebugInfo: (instanceId: string) => Promise<unknown>;
  fetchInstances: (options?: { commitSelection?: boolean }) => Promise<unknown>;
  observeConnection?: (
    observation: GatewaySnapshotConnectionObservation,
  ) => void;
  now?: () => number;
}

export function useGatewaySnapshotConnection<TSnapshot, TCapability>(
  options: GatewaySnapshotConnectionOptions<TSnapshot, TCapability>,
): void {
  const {
    enabled = true,
    authToken,
    tabId,
    generation,
    instanceId,
    askAgentSelected,
    routeByInstance,
    streamCoalesceMs,
    buildSnapshotApiPath,
    buildEventsApiPath,
    readSnapshotResponse,
    commitSnapshot,
    setAskAgentCapabilities,
    setStatus,
    fetchModes,
    fetchModels,
    fetchSlashCommands,
    fetchSessions,
    fetchDebugInfo,
    fetchInstances,
    observeConnection,
    now = Date.now,
  } = options;

  useEffect(() => {
    if (!enabled) return;
    let closed = false;
    let eventSource: EventSource | undefined;
    let snapshotFetchController: AbortController | undefined;
    let instanceRefreshTimer: ReturnType<typeof setInterval> | undefined;
    let initialSnapshotTimer: ReturnType<typeof setTimeout> | undefined;
    let fallbackSnapshotTimer: ReturnType<typeof setInterval> | undefined;
    let connectionCycleStartedAt = now();
    let recordedFirstCommit = false;

    const observe = (
      phase: GatewaySnapshotConnectionObservation["phase"],
      observedAt = now(),
    ) => {
      try {
        observeConnection?.({
          phase,
          elapsedMs: Math.max(0, observedAt - connectionCycleStartedAt),
        });
      } catch {
        // Baseline observers must not affect connection lifecycle.
      }
    };
    observe("created", connectionCycleStartedAt);

    const stopInitialSnapshotFallback = () => {
      if (!initialSnapshotTimer) return;
      clearTimeout(initialSnapshotTimer);
      initialSnapshotTimer = undefined;
    };

    const stopFallbackSnapshotPolling = () => {
      if (!fallbackSnapshotTimer) return;
      clearInterval(fallbackSnapshotTimer);
      fallbackSnapshotTimer = undefined;
    };

    const fetchFallbackSnapshot = async () => {
      snapshotFetchController?.abort();
      const controller = new AbortController();
      snapshotFetchController = controller;
      try {
        const response = await fetch(buildSnapshotApiPath(), {
          credentials: "same-origin",
          headers: {
            Authorization: `Bearer ${authToken}`,
          },
          signal: controller.signal,
        });
        if (!response.ok) {
          if (!closed) {
            setStatus(
              `Realtime stream disconnected — snapshot failed: ${response.status}`,
            );
          }
          return;
        }
        const data = await readSnapshotResponse(response);
        if (!closed && commitSnapshot(data.snapshot, tabId, generation)) {
          if (data.askAgentCapabilities) {
            setAskAgentCapabilities(data.askAgentCapabilities);
          }
          setStatus("Connected (fallback polling)");
        }
      } catch (err) {
        if (!closed && !controller.signal.aborted) {
          setStatus(
            `Realtime stream disconnected — retrying… (${String(err)})`,
          );
        }
      } finally {
        if (snapshotFetchController === controller) {
          snapshotFetchController = undefined;
        }
      }
    };

    const startFallbackSnapshotPolling = () => {
      if (fallbackSnapshotTimer) return;
      void fetchFallbackSnapshot();
      fallbackSnapshotTimer = setInterval(() => {
        void fetchFallbackSnapshot();
      }, 2_000);
    };

    let pendingStreamData: string | null = null;
    let streamCoalesceTimer: ReturnType<typeof setTimeout> | undefined;
    // The first event should commit immediately, regardless of the clock's epoch.
    let lastStreamApplyAt = now() - streamCoalesceMs;

    // Origin-liveness tracking: the bridge server runs inside the VS Code
    // extension host, so its named `heartbeat` SSE events (and any data event)
    // prove the host event loop is alive. A TCP connection can stay "open"
    // long after the host wedges — EventSource.onerror never fires — so
    // staleness here is the only browser-side signal of a locked-up host.
    let lastOriginActivityAt = now();
    let flaggedHostStale = false;
    const noteOriginActivity = () => {
      lastOriginActivityAt = now();
      if (flaggedHostStale) {
        flaggedHostStale = false;
        setStatus("Connected");
      }
    };

    const applyPendingStreamData = () => {
      streamCoalesceTimer = undefined;
      if (closed || pendingStreamData === null) return;
      const data = pendingStreamData;
      pendingStreamData = null;
      lastStreamApplyAt = now();
      try {
        const next = JSON.parse(data) as TSnapshot;
        if (!commitSnapshot(next, tabId, generation)) return;
        if (!recordedFirstCommit) {
          recordedFirstCommit = true;
          // Measures usable state: event arrival, coalescing, parse, and commit.
          // This is intentionally not a network first-byte metric.
          observe("first_commit");
        }
        snapshotFetchController?.abort();
        snapshotFetchController = undefined;
        stopInitialSnapshotFallback();
        stopFallbackSnapshotPolling();
        setStatus("Connected");
      } catch (err) {
        setStatus(`Stream parse error: ${String(err)}`);
      }
    };

    const applySnapshotEvent = (event: MessageEvent<string>) => {
      noteOriginActivity();
      pendingStreamData = event.data;
      if (streamCoalesceTimer !== undefined) return;
      const elapsed = now() - lastStreamApplyAt;
      if (elapsed >= streamCoalesceMs) {
        applyPendingStreamData();
        return;
      }
      streamCoalesceTimer = setTimeout(
        applyPendingStreamData,
        streamCoalesceMs - elapsed,
      );
    };

    eventSource = new EventSource(
      buildEventsApiPath(instanceId, askAgentSelected),
    );
    eventSource.onopen = () => {
      if (closed) return;
      noteOriginActivity();
      observe("open");
      stopFallbackSnapshotPolling();
      setStatus("Connected");
    };
    eventSource.onerror = () => {
      if (closed) return;
      const errorAt = now();
      observe("error", errorAt);
      connectionCycleStartedAt = errorAt;
      recordedFirstCommit = false;
      stopInitialSnapshotFallback();
      setStatus("Realtime stream disconnected — retrying…");
      startFallbackSnapshotPolling();
    };
    eventSource.addEventListener("snapshot", applySnapshotEvent);
    eventSource.addEventListener("update", applySnapshotEvent);
    const heartbeatListener = () => {
      if (!closed) noteOriginActivity();
    };
    eventSource.addEventListener("heartbeat", heartbeatListener);
    // Bridge keepalives arrive every 15s; tolerate two missed beats before
    // declaring the extension host unresponsive.
    const hostStaleCheckTimer = setInterval(() => {
      if (closed || flaggedHostStale) return;
      if (now() - lastOriginActivityAt > 40_000) {
        flaggedHostStale = true;
        setStatus(
          "Extension host not responding — stream open but no heartbeat",
        );
      }
    }, 5_000);

    initialSnapshotTimer = setTimeout(() => {
      initialSnapshotTimer = undefined;
      void fetchFallbackSnapshot();
    }, 500);
    // Workspace modes and slash commands defer until the first snapshot supplies
    // an explicit project ID; Ask Agent remains projectless and loads immediately.
    void fetchModes(instanceId);
    void fetchModels(instanceId, askAgentSelected);
    void fetchSlashCommands(instanceId, askAgentSelected);
    if (!askAgentSelected) {
      void fetchSessions(instanceId, false);
      void fetchDebugInfo(instanceId);
    }
    void fetchInstances();
    instanceRefreshTimer = setInterval(() => {
      void fetchInstances();
    }, 5_000);

    return () => {
      closed = true;
      if (instanceRefreshTimer) {
        clearInterval(instanceRefreshTimer);
      }
      if (streamCoalesceTimer !== undefined) {
        clearTimeout(streamCoalesceTimer);
        streamCoalesceTimer = undefined;
      }
      pendingStreamData = null;
      snapshotFetchController?.abort();
      snapshotFetchController = undefined;
      stopInitialSnapshotFallback();
      stopFallbackSnapshotPolling();
      clearInterval(hostStaleCheckTimer);
      if (eventSource) {
        eventSource.onopen = null;
        eventSource.onerror = null;
        eventSource.removeEventListener("snapshot", applySnapshotEvent);
        eventSource.removeEventListener("update", applySnapshotEvent);
        eventSource.removeEventListener("heartbeat", heartbeatListener);
        eventSource.close();
      }
    };
  }, [
    enabled,
    buildEventsApiPath,
    buildSnapshotApiPath,
    commitSnapshot,
    askAgentSelected,
    tabId,
    routeByInstance,
    observeConnection,
    now,
  ]);
}
