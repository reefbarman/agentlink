import * as http from "http";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BROWSER_GATEWAY_DATA_PLANE_LIMITS } from "./dataPlane/limits.js";
import type { BrowserGatewayInstanceRecord } from "./browserGatewayRegistry.js";
import { BrowserGatewayServer } from "./BrowserGatewayServer.js";
import { BrowserGatewayService } from "./BrowserGatewayService.js";
import type { BrowserGatewayThemeSnapshot } from "../shared/types.js";
import { InMemoryAgentUiEventHub } from "../agent/AgentUiPublisher.js";
import type { SessionApprovalMode } from "../agent/AgentSessionManager.js";
import { StreamingBaselineRecorder } from "../shared/streamingBaselineMetrics.js";
import { buildBrowserGatewayHelperTrustHeaders } from "./browserGatewayRequestTrust.js";
import { diffSnapshotHub } from "./DiffSnapshotHub.js";

const browserGatewayRegistryRecords = vi.hoisted(
  () => new Map<string, BrowserGatewayInstanceRecord>(),
);

vi.mock("./browserGatewayDiscovery.js", () => ({
  writeBrowserGatewayDiscovery: vi.fn(async () => {}),
  clearBrowserGatewayDiscovery: vi.fn(async () => {}),
}));

vi.mock("./browserGatewayRegistry.js", () => {
  const listRecords = (): BrowserGatewayInstanceRecord[] =>
    [...browserGatewayRegistryRecords.values()].sort(
      (a, b) =>
        a.workspaceName.localeCompare(b.workspaceName) ||
        a.instanceId.localeCompare(b.instanceId),
    );

  return {
    getBrowserGatewayRegistryPath: vi.fn(() => "/tmp/browser-gateways.json"),
    upsertBrowserGatewayInstance: vi.fn(
      async (record: BrowserGatewayInstanceRecord) => {
        browserGatewayRegistryRecords.set(record.instanceId, record);
      },
    ),
    removeBrowserGatewayInstance: vi.fn(async (instanceId: string) => {
      browserGatewayRegistryRecords.delete(instanceId);
    }),
    listCheckedBrowserGatewayInstances: vi.fn(async () => {
      const records = listRecords();
      return { registered: records, healthy: records };
    }),
    listRegisteredBrowserGatewayInstances: vi.fn(async () => listRecords()),
  };
});

vi.mock("vscode", () => {
  type Listener<T> = (event: T) => void;

  class MockEventEmitter<T> {
    private listeners = new Set<Listener<T>>();

    event = (listener: Listener<T>) => {
      this.listeners.add(listener);
      return { dispose: () => this.listeners.delete(listener) };
    };

    fire(value: T): void {
      for (const listener of this.listeners) {
        listener(value);
      }
    }

    dispose(): void {
      this.listeners.clear();
    }
  }

  return {
    EventEmitter: MockEventEmitter,
    workspace: {
      getConfiguration: () => ({
        get: () => undefined,
      }),
    },
  };
});

function makeSessionManagerStub() {
  const projectScope = {
    projectId: "project-a",
    displayName: "Project A",
  };
  return {
    getWorkspaceProjects: vi.fn(() => [
      {
        id: "project-a",
        name: "Project A",
        uri: "file:///workspace/a",
        rootPath: "/workspace/a",
        availability: { status: "available" },
      },
    ]),
    getDefaultProjectScope: vi.fn(() => projectScope),
    setBrowserPreferredProject: vi.fn(() => true),
    getSessionInfos: vi.fn(() => [{ id: "session-1" }]),
    getSession: vi.fn((id: string) =>
      id === "session-1" ? { projectScope } : undefined,
    ),
    listPersistedSessions: vi.fn(() => [
      {
        schemaVersion: 1,
        id: "session-1",
        mode: "code",
        model: "claude-sonnet-4-6",
        title: "Test Session",
        messageCount: 2,
        totalInputTokens: 10,
        totalOutputTokens: 20,
        createdAt: 1,
        lastActiveAt: 2,
        projectScope,
      },
    ]),
    getForegroundSession: vi.fn(() => ({
      id: "session-1",
      title: "Test Session",
      mode: "code",
      model: "claude-sonnet-4-6",
      status: "idle",
      lastInputTokens: 10,
      lastOutputTokens: 20,
      lastCacheReadTokens: 3,
      estimatedTotalUsed: 33,
      projectScope,
      projectAvailability: "available",
      getAllMessages: vi.fn(() => [
        { role: "user", content: "hello" },
        { role: "assistant", content: [{ type: "text", text: "world" }] },
      ]),
    })),
    getPersistedSessionMessages: vi.fn(() => [
      { role: "user", content: "hello" },
      { role: "assistant", content: [{ type: "text", text: "world" }] },
    ]),
    getBgSessionInfos: vi.fn(() => [
      {
        id: "bg-1",
        task: "Review implementation",
        status: "streaming",
        displayStatus: "streaming",
        resolvedMode: "review",
        resolvedModel: "claude-opus-4-8",
      },
    ]),
    getSessionApprovalMode: vi.fn<() => SessionApprovalMode>(() => ({
      commandApprovalPolicy: "safe",
      approvalPolicy: "on-request",
      approvalReviewer: "user",
      executionPreset: "native-manual",
    })),
  };
}

function makeMcpConfigSnapshot() {
  return {
    profile: "ask-agent" as const,
    version: 1,
    sources: [
      {
        id: "ask-agent:3",
        profile: "ask-agent" as const,
        scope: "ask-agent-global" as const,
        label: "Ask Agent AgentLink",
        path: "/home/.agentlink/ask-agent/mcp.json",
        exists: true,
        editable: true,
        priority: 3,
        readStatus: "available" as const,
      },
    ],
    entries: [],
    statusInfos: [
      {
        name: "ask-linear",
        status: "connected",
        toolCount: 1,
        resourceCount: 0,
        promptCount: 0,
        tools: [{ name: "list_issues", description: "List issues" }],
      },
    ],
    capabilities: {
      canEditConfig: true,
      canOpenRawConfig: true,
      canReconnect: true,
      canReauthenticate: true,
      canDisable: true,
      canUseProjectConfig: false,
    },
  };
}

function makeChatViewProviderStub() {
  return {
    submitBrowserApprovalDecision: vi.fn(() => true),
    submitBrowserQuestionResponse: vi.fn(() => true),
    publishBrowserQuestionProgress: vi.fn(() => true),
    submitBrowserFormElicitation: vi.fn<
      () =>
        | { ok: true }
        | { ok: false; reason: "stale_request" }
        | {
            ok: false;
            reason: "invalid_values";
            errors: Record<string, string>;
          }
    >(() => ({ ok: true })),
    submitBrowserUrlElicitation: vi.fn(() => true),
    submitBrowserSend: vi.fn<() => Promise<{ ok: boolean; queued?: boolean }>>(
      async () => ({ ok: true }),
    ),
    submitBrowserModeSwitch: vi.fn(async (mode: string) => ({
      approved: true,
      mode,
    })),
    getBrowserSlashCommands: vi.fn(async () => [
      {
        name: "new",
        description: "Create new session",
        source: "builtin",
        builtin: true,
      },
      {
        name: "mcp",
        description: "Open MCP panel",
        source: "builtin",
        builtin: true,
      },
    ]),
    searchBrowserFiles: vi.fn(async (query: string) =>
      query === "src" ? [{ path: "src/index.ts", kind: "file" as const }] : [],
    ),
    getBrowserModes: vi.fn(async () => [
      { slug: "code", name: "Code", icon: "code" },
      { slug: "architect", name: "Architect", icon: "symbol-structure" },
    ]),
    getBrowserModels: vi.fn(async () => [
      {
        id: "claude-sonnet-4-6",
        displayName: "Claude Sonnet 4.6",
        provider: "anthropic",
        contextWindow: 200000,
        authenticated: true,
        condenseThreshold: 0.8,
      },
    ]),
    submitBrowserSetModel: vi.fn(async (_model: string) => ({ ok: true })),
    submitBrowserSetWriteApproval: vi.fn(() => ({ ok: true })),
    submitBrowserSetCommandApprovalPolicy: vi.fn(() => ({ ok: true })),
    submitBrowserSetThinkingEnabled: vi.fn(() => ({ ok: true })),
    submitBrowserNewSession: vi.fn(async () => ({ ok: true })),
    submitBrowserLoadSession: vi.fn(async () => ({ ok: true })),
    submitBrowserAttachFile: vi.fn(async () => ({
      files: ["/tmp/from-picker.txt"],
    })),
    submitBrowserOpenFile: vi.fn(async () => ({ ok: true })),
    submitBrowserSteerQueuedMessage: vi.fn(async () => ({ ok: true })),
    submitBrowserInterjectQueuedMessage: vi.fn(() => ({ ok: true })),
    submitBrowserStop: vi.fn(() => ({ ok: true })),
    submitBrowserResume: vi.fn<
      () => Promise<{ ok: true } | { ok: false; error: string }>
    >(async () => ({ ok: true })),
    submitBrowserStopBackground: vi.fn(() => ({ ok: true })),
    submitBrowserAskAgentWebPolicy: vi.fn(() => ({
      ok: true,
      settings: {
        searchBackend: "native",
        fetchBackend: "native",
        allowedDomains: [],
        blockedDomains: [],
        maxSearchUsesPerTurn: 5,
        maxFetchUsesPerTurn: 3,
        maxFetchContentTokens: 25000,
        maxReplayBytesPerTurn: 5242880,
      },
      revision: "web-policy-revision-1",
    })),
    submitBrowserAskAgentMcpStatus: vi.fn(() => ({
      ok: true,
      infos: makeMcpConfigSnapshot().statusInfos,
      configSnapshot: makeMcpConfigSnapshot(),
    })),
    submitBrowserAskAgentMcpRefresh: vi.fn(async () => ({
      ok: true,
      infos: makeMcpConfigSnapshot().statusInfos,
      configSnapshot: makeMcpConfigSnapshot(),
    })),
    submitBrowserMcpConfigSnapshot: vi.fn(async () => ({
      ok: true,
      configSnapshot: makeMcpConfigSnapshot(),
    })),
    submitMcpConfigMutation: vi.fn(async (mutation) => ({
      operationId: mutation.operationId,
      ok: true,
      configSaved: true,
      errors: [],
      configSnapshot: makeMcpConfigSnapshot(),
    })),
    submitBrowserMcpConfigServer: vi.fn(async () => ({
      ok: true,
      configSnapshot: makeMcpConfigSnapshot(),
    })),
    submitBrowserMcpConfigRemove: vi.fn(async () => ({
      ok: true,
      configSnapshot: makeMcpConfigSnapshot(),
    })),
    submitBrowserMcpConfigOpenRaw: vi.fn(async () => ({ ok: true })),
    submitBrowserMcpAction: vi.fn(async () => ({ ok: true, infos: [] })),
    getBrowserBgTranscript: vi.fn((sessionId: string) => ({
      ok: true,
      transcript: {
        sessionId,
        task: "Background Agent",
        messages: [
          { role: "assistant", content: [{ type: "text", text: "Done" }] },
        ],
      },
    })),
  };
}

beforeEach(() => {
  browserGatewayRegistryRecords.clear();
  vi.clearAllMocks();
});

afterEach(() => {
  diffSnapshotHub.remove("approval-1");
  diffSnapshotHub.remove("approval-large");
});

describe("BrowserGatewayServer", () => {
  it("persists explicit theme publications without connected SSE clients", async () => {
    const hub = new InMemoryAgentUiEventHub();
    let theme: BrowserGatewayThemeSnapshot = {
      cssVariables: { "--vscode-editor-background": "#111111" },
      colorScheme: "dark",
      themeLabel: "Dark",
      source: "vscode-theme-api",
    };
    const service = new BrowserGatewayService(
      hub,
      makeSessionManagerStub() as never,
      () => theme,
      () => "prompt",
      () => true,
      () => "high",
      () => null,
      () => [],
    );
    const server = new BrowserGatewayServer(
      service,
      makeChatViewProviderStub() as never,
      "test-token",
      "theme-no-client-instance",
      "Theme Workspace",
      "/workspace/theme",
      vi.fn(),
    );

    try {
      await server.start(0);
      const persistCurrentThemeSnapshot = vi
        .spyOn(
          server as unknown as {
            persistCurrentThemeSnapshot(
              theme?: BrowserGatewayThemeSnapshot,
            ): Promise<void>;
          },
          "persistCurrentThemeSnapshot",
        )
        .mockResolvedValue();

      theme = {
        ...theme,
        cssVariables: { "--vscode-editor-background": "#eeeeee" },
        colorScheme: "light",
        themeLabel: "Light",
      };
      service.invalidateBrowserSnapshot({
        immediate: true,
        publishWithoutClients: true,
      });

      expect(persistCurrentThemeSnapshot).toHaveBeenCalledWith(theme);
    } finally {
      await server.stop();
      service.dispose();
      hub.dispose();
    }
  });

  it("records one wire serialization per broadcast across multiple SSE clients", async () => {
    const hub = new InMemoryAgentUiEventHub();
    const sessionManager = makeSessionManagerStub();
    const recorder = new StreamingBaselineRecorder();
    const service = new BrowserGatewayService(
      hub,
      sessionManager as never,
      () => ({
        cssVariables: {},
        colorScheme: "dark",
        themeLabel: "Dark",
        source: "vscode-theme-api",
      }),
      () => "prompt",
      () => true,
      () => "high",
      () => null,
      () => [],
      20,
      recorder,
    );
    const server = new BrowserGatewayServer(
      service,
      makeChatViewProviderStub() as never,
      "test-token",
      "metrics-instance",
      "Metrics Workspace",
      "/workspace/metrics",
      vi.fn(),
      recorder,
    );
    const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];

    try {
      const port = await server.start(0);
      for (let index = 0; index < 2; index += 1) {
        const response = await fetch(`http://127.0.0.1:${port}/events`);
        const reader = response.body!.getReader();
        readers.push(reader);
        await reader.read();
      }
      expect(recorder.summarize("vscode-gateway")).toMatchObject({
        connectedClientsMax: 2,
        firstDeliveries: 2,
        firstDeliveryBytes: expect.any(Number),
      });
      recorder.reset();

      hub.publishApproval("session-1", {
        kind: "write",
        id: "metrics-approval",
        filePath: "src/file.ts",
        writeOperation: "modify",
      });
      await Promise.all(readers.map((reader) => reader.read()));

      expect(recorder.summarize("vscode-gateway")).toMatchObject({
        snapshotBuilds: 1,
        serializations: 1,
        broadcasts: 1,
        broadcastAttempts: 2,
        broadcastDeliveries: 2,
        connectedClientsMax: 2,
      });
    } finally {
      await Promise.all(readers.map((reader) => reader.cancel()));
      await server.stop();
      service.dispose();
      hub.dispose();
    }
  });

  it("preserves SSE headers and supersedes stale connect-time snapshots", async () => {
    const hub = new InMemoryAgentUiEventHub();
    const sessionManager = makeSessionManagerStub();
    const service = new BrowserGatewayService(
      hub,
      sessionManager as never,
      () => ({
        cssVariables: {},
        colorScheme: "dark",
        themeLabel: "Dark",
        source: "vscode-theme-api",
      }),
      () => "prompt",
      () => true,
      () => "high",
      () => null,
      () => [],
    );
    const server = new BrowserGatewayServer(
      service,
      makeChatViewProviderStub() as never,
      "test-token",
      "connect-race-instance",
      "Connect Race Workspace",
      "/workspace/connect-race",
      vi.fn(),
    );
    const createInitial = service.createSnapshotPublication.bind(service);
    vi.spyOn(service, "createSnapshotPublication").mockImplementationOnce(
      () => {
        const stale = createInitial();
        hub.publishApproval("session-1", {
          kind: "write",
          id: "connect-time-approval",
          filePath: "src/connect.ts",
          writeOperation: "modify",
        });
        return stale;
      },
    );
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

    try {
      const port = await server.start(0);
      const response = await fetch(`http://127.0.0.1:${port}/events`);
      expect(response.headers.get("content-type")).toBe("text/event-stream");
      expect(response.headers.get("cache-control")).toBe(
        "no-cache, no-transform",
      );
      expect(response.headers.get("connection")).toBe("keep-alive");
      expect(response.headers.get("x-accel-buffering")).toBe("no");
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
      reader = response.body!.getReader();

      const first = await reader.read();
      const chunk = new TextDecoder().decode(first.value);
      expect(chunk.match(/event: snapshot/g)).toHaveLength(1);
      expect(chunk).not.toContain("event: update");
      expect(chunk).toContain('"connect-time-approval"');
    } finally {
      await reader?.cancel();
      await server.stop();
      service.dispose();
      hub.dispose();
    }
  });

  it("rolls back a failed start before retrying", async () => {
    const blocker = await new Promise<http.Server>((resolve) => {
      const candidate = http.createServer();
      candidate.listen(0, "127.0.0.1", () => resolve(candidate));
    });
    const blockedAddress = blocker.address();
    if (!blockedAddress || typeof blockedAddress === "string") {
      throw new Error("expected blocked TCP address");
    }
    const hub = new InMemoryAgentUiEventHub();
    const sessionManager = makeSessionManagerStub();
    const service = new BrowserGatewayService(
      hub,
      sessionManager as never,
      () => ({
        cssVariables: {},
        colorScheme: "dark",
        themeLabel: "Dark",
        source: "vscode-theme-api",
      }),
      () => "prompt",
      () => true,
      () => "high",
      () => null,
      () => [],
    );
    const server = new BrowserGatewayServer(
      service,
      makeChatViewProviderStub() as never,
      "test-token",
      "failed-start-instance",
      "Failed Start Workspace",
      "/workspace/failed-start",
      vi.fn(),
    );
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

    try {
      await expect(server.start(blockedAddress.port)).rejects.toMatchObject({
        code: "EADDRINUSE",
      });
      await new Promise<void>((resolve) => blocker.close(() => resolve()));

      const port = await server.start(0);
      const response = await fetch(`http://127.0.0.1:${port}/events`);
      reader = response.body!.getReader();
      await reader.read();
      hub.publishApproval("session-1", {
        kind: "write",
        id: "single-update-after-retry",
        filePath: "src/retry.ts",
        writeOperation: "modify",
      });
      const update = await reader.read();
      const chunk = new TextDecoder().decode(update.value);
      expect(chunk.match(/event: update/g)).toHaveLength(1);
      expect(chunk).toContain('"single-update-after-retry"');
    } finally {
      if (blocker.listening) {
        await new Promise<void>((resolve) => blocker.close(() => resolve()));
      }
      await reader?.cancel();
      await server.stop();
      service.dispose();
      hub.dispose();
    }
  });

  it("recreates the SSE hub on restart and reconnects with current full state", async () => {
    const hub = new InMemoryAgentUiEventHub();
    const sessionManager = makeSessionManagerStub();
    const service = new BrowserGatewayService(
      hub,
      sessionManager as never,
      () => ({
        cssVariables: {},
        colorScheme: "dark",
        themeLabel: "Dark",
        source: "vscode-theme-api",
      }),
      () => "prompt",
      () => true,
      () => "high",
      () => null,
      () => [],
    );
    const server = new BrowserGatewayServer(
      service,
      makeChatViewProviderStub() as never,
      "test-token",
      "restart-instance",
      "Restart Workspace",
      "/workspace/restart",
      vi.fn(),
    );
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

    try {
      let port = await server.start(0);
      let response = await fetch(`http://127.0.0.1:${port}/events`);
      reader = response.body!.getReader();
      await reader.read();
      await reader.cancel();
      reader = undefined;
      await server.stop();
      await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow();

      hub.publishApproval("session-1", {
        kind: "write",
        id: "approval-while-stopped",
        filePath: "src/reconnect.ts",
        writeOperation: "modify",
      });

      port = await server.start(0);
      response = await fetch(`http://127.0.0.1:${port}/events`);
      reader = response.body!.getReader();
      const reconnected = await reader.read();
      const snapshotChunk = new TextDecoder().decode(reconnected.value);
      expect(snapshotChunk).toContain("event: snapshot");
      expect(snapshotChunk).toContain('"approval-while-stopped"');

      hub.publishApprovalIdle("session-1", "approval-while-stopped");
      const update = await reader.read();
      const updateChunk = new TextDecoder().decode(update.value);
      expect(updateChunk).toContain("event: update");
      expect(updateChunk).toContain('"approval":null');
    } finally {
      await reader?.cancel();
      await server.stop();
      service.dispose();
      hub.dispose();
    }
  });

  it("serves API/stream routes, registry/snapshot state, diff detail, and routes browser actions", async () => {
    const hub = new InMemoryAgentUiEventHub();
    const sessionManager = makeSessionManagerStub();
    const chatViewProvider = makeChatViewProviderStub();
    let projectedModel = "claude-sonnet-4-6";
    let projectedQuestionRequest: {
      id: string;
      context: string;
      questions: Array<{ id: string; type: "yes_no"; question: string }>;
    } | null = null;
    chatViewProvider.submitBrowserSetModel.mockImplementation(
      async (model: string) => {
        projectedModel = model;
        return { ok: true };
      },
    );
    chatViewProvider.submitBrowserNewSession.mockImplementation(async () => {
      projectedModel = "gpt-5.3-codex";
      return { ok: true };
    });
    const service = new BrowserGatewayService(
      hub,
      sessionManager as never,
      () => ({
        cssVariables: {
          "--vscode-editor-background": "#1e1e1e",
        },
        colorScheme: "dark",
        themeLabel: "Dark",
        source: "vscode-theme-api",
      }),
      () => "prompt",
      () => true,
      () => "high",
      () => ({
        sessionId: "session-1",
        mode: "code",
        model: projectedModel,
        streaming: false,
        statusOverride: null,
        projectedMessages: [
          {
            id: "chat-1",
            role: "assistant",
            content: "",
            timestamp: 1,
            blocks: [{ type: "text", text: "world" }],
          },
        ],
        lastInputTokens: 10,
        lastOutputTokens: 20,
        lastCacheReadTokens: 3,
        estimatedTotalUsed: 33,
        thinkingEnabled: true,
        reasoningEffort: "high",
        messageQueue: [],
        questionRequest: projectedQuestionRequest,
        detectedQuestion: null,
        todos: [],
        debugInfo: null,
        systemPrompt: null,
        loadedInstructions: null,
        restoringSession: false,
        revertRecoveryNotice: null,
        contextBudget: {
          contextWindow: 200000,
          maxInputTokens: 191808,
          usedInputTokens: 10,
          outputReservation: 8192,
          safetyBufferTokens: 4096,
          softThresholdBudget: 150000,
          hardBudget: 180000,
        },
        condenseThreshold: 0.8,
      }),
      () => [],
    );
    const getSerializableSessionDetail = vi
      .spyOn(service, "getSerializableSessionDetail")
      .mockImplementation((selection) =>
        selection.controllerEpoch === "controller-1"
          ? ({
              selection,
              session: { sessionId: selection.sessionId },
            } as never)
          : null,
      );
    const server = new BrowserGatewayServer(
      service,
      chatViewProvider as never,
      "test-token",
      "instance-1",
      "Workspace One",
      "/workspace/one",
      vi.fn(),
      undefined,
      () => "helper-secret",
    );
    const helperLoopbackHeaders = buildBrowserGatewayHelperTrustHeaders(
      "helper-secret",
      "loopback",
    );
    const helperNonLoopbackHeaders = buildBrowserGatewayHelperTrustHeaders(
      "helper-secret",
      "non-loopback",
    );
    const port = await server.start(0);
    const baseUrl = `http://127.0.0.1:${port}`;

    hub.publishApproval("session-1", {
      kind: "write",
      id: "approval-1",
      filePath: "src/file.ts",
      writeOperation: "modify",
    });
    projectedQuestionRequest = {
      id: "question-1",
      context: "Need confirmation.",
      questions: [
        {
          id: "q1",
          type: "yes_no",
          question: "Continue?",
        },
      ],
    };
    hub.publishQuestionRequest(
      "session-1",
      projectedQuestionRequest.id,
      projectedQuestionRequest.context,
      projectedQuestionRequest.questions,
    );
    diffSnapshotHub.upsert({
      requestId: "approval-1",
      filePath: "src/file.ts",
      operation: "modify",
      originalContent: "before",
      proposedContent: "after",
      outsideWorkspace: false,
      createdAt: 1,
    });
    diffSnapshotHub.upsert({
      requestId: "approval-large",
      filePath: "src/large-file.ts",
      operation: "modify",
      originalContent: "a".repeat(1_000_001),
      proposedContent: "b".repeat(1_000_000),
      outsideWorkspace: false,
      createdAt: 2,
    });

    const instancesResponse = await fetch(`${baseUrl}/api/instances`);
    expect(instancesResponse.ok).toBe(true);
    const instancesJson = (await instancesResponse.json()) as {
      currentInstanceId: string;
      instances: Array<{
        instanceId: string;
        status?: { kind: string; label: string };
      }>;
    };
    expect(instancesJson).toHaveProperty("currentInstanceId", "instance-1");
    expect(Array.isArray(instancesJson.instances)).toBe(true);
    const currentInstance = instancesJson.instances.find(
      (instance) => instance.instanceId === "instance-1",
    );
    if (currentInstance) {
      expect(currentInstance.status).toEqual({
        kind: "awaiting_approval",
        label: "Question",
        detail: "Awaiting response",
        sessionTitle: "Test Session",
      });
    }

    const unauthorizedInstanceStatusResponse = await fetch(
      `${baseUrl}/api/instance-status`,
    );
    expect(unauthorizedInstanceStatusResponse.status).toBe(401);

    const instanceStatusResponse = await fetch(
      `${baseUrl}/api/instance-status`,
      { headers: { Authorization: "Bearer test-token" } },
    );
    expect(instanceStatusResponse.ok).toBe(true);
    expect(await instanceStatusResponse.json()).toEqual({
      kind: "awaiting_approval",
      label: "Question",
      detail: "Awaiting response",
      sessionTitle: "Test Session",
    });

    const sessionDetailQuery = new URLSearchParams({
      controllerEpoch: "controller-1",
      tabId: "tab-2",
      sessionId: "session-2",
    });
    const unauthorizedSessionDetail = await fetch(
      `${baseUrl}/api/session-detail?${sessionDetailQuery}`,
    );
    expect(unauthorizedSessionDetail.status).toBe(401);

    const invalidSessionDetail = await fetch(
      `${baseUrl}/api/session-detail?tabId=tab-2&sessionId=session-2`,
      { headers: { Authorization: "Bearer test-token" } },
    );
    expect(invalidSessionDetail.status).toBe(400);
    await expect(invalidSessionDetail.json()).resolves.toEqual({
      error: "invalid_request",
    });

    const sessionDetailResponse = await fetch(
      `${baseUrl}/api/session-detail?${sessionDetailQuery}`,
      { headers: { Authorization: "Bearer test-token" } },
    );
    expect(sessionDetailResponse.status).toBe(200);
    expect(sessionDetailResponse.headers.get("Content-Type")).toBe(
      "application/json; charset=utf-8",
    );
    await expect(sessionDetailResponse.json()).resolves.toMatchObject({
      selection: {
        controllerEpoch: "controller-1",
        tabId: "tab-2",
        sessionId: "session-2",
      },
      session: { sessionId: "session-2" },
    });
    expect(getSerializableSessionDetail).toHaveBeenCalledWith({
      controllerEpoch: "controller-1",
      tabId: "tab-2",
      sessionId: "session-2",
    });

    getSerializableSessionDetail.mockReturnValueOnce({
      selection: {
        controllerEpoch: "controller-1",
        tabId: "tab-2",
        sessionId: "session-2",
      },
      session: {
        sessionId: "session-2",
        projectedMessages: [
          {
            content: "x".repeat(
              BROWSER_GATEWAY_DATA_PLANE_LIMITS.authenticatedDetailResponseBytes,
            ),
          },
        ],
      },
    } as never);
    const oversizedSessionDetail = await fetch(
      `${baseUrl}/api/session-detail?${sessionDetailQuery}`,
      { headers: { Authorization: "Bearer test-token" } },
    );
    expect(oversizedSessionDetail.status).toBe(413);
    await expect(oversizedSessionDetail.json()).resolves.toEqual({
      error: "session_detail_too_large",
    });

    const staleSessionDetail = await fetch(
      `${baseUrl}/api/session-detail?${new URLSearchParams({
        controllerEpoch: "stale-controller",
        tabId: "tab-2",
        sessionId: "session-2",
      })}`,
      { headers: { Authorization: "Bearer test-token" } },
    );
    expect(staleSessionDetail.status).toBe(404);
    await expect(staleSessionDetail.json()).resolves.toEqual({
      error: "stale_selection",
    });

    const unauthorizedAskWebPolicyResponse = await fetch(
      `${baseUrl}/internal/ask-agent/web-policy`,
    );
    expect(unauthorizedAskWebPolicyResponse.status).toBe(401);

    const askWebPolicyResponse = await fetch(
      `${baseUrl}/internal/ask-agent/web-policy`,
      { headers: { Authorization: "Bearer test-token" } },
    );
    expect(askWebPolicyResponse.ok).toBe(true);
    expect(await askWebPolicyResponse.json()).toEqual({
      ok: true,
      settings: {
        searchBackend: "native",
        fetchBackend: "native",
        allowedDomains: [],
        blockedDomains: [],
        maxSearchUsesPerTurn: 5,
        maxFetchUsesPerTurn: 3,
        maxFetchContentTokens: 25000,
        maxReplayBytesPerTurn: 5242880,
      },
      revision: "web-policy-revision-1",
    });
    expect(
      chatViewProvider.submitBrowserAskAgentWebPolicy,
    ).toHaveBeenCalledOnce();

    const unauthorizedAskMcpStatusResponse = await fetch(
      `${baseUrl}/internal/ask-agent/mcp-status`,
    );
    expect(unauthorizedAskMcpStatusResponse.status).toBe(401);

    const askMcpStatusResponse = await fetch(
      `${baseUrl}/internal/ask-agent/mcp-status`,
      { headers: { Authorization: "Bearer test-token" } },
    );
    expect(askMcpStatusResponse.ok).toBe(true);
    expect(await askMcpStatusResponse.json()).toEqual({
      ok: true,
      infos: makeMcpConfigSnapshot().statusInfos,
      configSnapshot: makeMcpConfigSnapshot(),
    });
    expect(chatViewProvider.submitBrowserAskAgentMcpStatus).toHaveBeenCalled();

    const askMcpRefreshResponse = await fetch(
      `${baseUrl}/internal/ask-agent/mcp-refresh`,
      { method: "POST", headers: { Authorization: "Bearer test-token" } },
    );
    expect(askMcpRefreshResponse.ok).toBe(true);
    expect(await askMcpRefreshResponse.json()).toEqual({
      ok: true,
      infos: makeMcpConfigSnapshot().statusInfos,
      configSnapshot: makeMcpConfigSnapshot(),
    });
    expect(chatViewProvider.submitBrowserAskAgentMcpRefresh).toHaveBeenCalled();

    const askMcpConfigResponse = await fetch(
      `${baseUrl}/internal/ask-agent/mcp-config`,
      { headers: { Authorization: "Bearer test-token" } },
    );
    expect(askMcpConfigResponse.ok).toBe(true);
    expect(await askMcpConfigResponse.json()).toEqual({
      ok: true,
      configSnapshot: makeMcpConfigSnapshot(),
    });
    expect(
      chatViewProvider.submitBrowserMcpConfigSnapshot,
    ).toHaveBeenCalledWith("ask-agent");

    const mainMcpConfigResponse = await fetch(
      `${baseUrl}/api/mcp/config?profile=main&projectId=project-a`,
      { headers: { Authorization: "Bearer test-token" } },
    );
    expect(mainMcpConfigResponse.ok).toBe(true);
    expect(
      chatViewProvider.submitBrowserMcpConfigSnapshot,
    ).toHaveBeenLastCalledWith("main", "project-a");

    const askMcpConfigSaveResponse = await fetch(
      `${baseUrl}/internal/ask-agent/mcp-config/server`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json",
          ...helperLoopbackHeaders,
        },
        body: JSON.stringify({
          profile: "ask-agent",
          scope: "ask-agent-global",
          server: { name: "new", command: "new-mcp" },
        }),
      },
    );
    expect(askMcpConfigSaveResponse.ok).toBe(true);
    expect(chatViewProvider.submitBrowserMcpConfigServer).toHaveBeenCalledWith({
      profile: "ask-agent",
      scope: "ask-agent-global",
      server: { name: "new", command: "new-mcp" },
    });

    const mainMcpConfigSaveResponse = await fetch(
      `${baseUrl}/api/mcp/config/server`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          profile: "main",
          scope: "global",
          server: { name: "host", command: "host-mcp" },
        }),
      },
    );
    expect(mainMcpConfigSaveResponse.status).toBe(403);
    expect(await mainMcpConfigSaveResponse.json()).toEqual({
      error: "browser_mcp_config_unavailable",
    });
    expect(
      chatViewProvider.submitBrowserMcpConfigServer,
    ).not.toHaveBeenCalledWith(
      expect.objectContaining({
        profile: "main",
        scope: "global",
      }),
    );

    const askMcpConfigOpenRawResponse = await fetch(
      `${baseUrl}/internal/ask-agent/mcp-config/open-raw`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          profile: "ask-agent",
          scope: "ask-agent-global",
        }),
      },
    );
    expect(askMcpConfigOpenRawResponse.status).toBe(403);
    expect(await askMcpConfigOpenRawResponse.json()).toEqual({
      error: "browser_mcp_config_unavailable",
    });
    expect(
      chatViewProvider.submitBrowserMcpConfigOpenRaw,
    ).not.toHaveBeenCalled();

    const missingHelperTrustResponse = await fetch(
      `${baseUrl}/internal/ask-agent/mcp-config/server`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          profile: "ask-agent",
          scope: "ask-agent-global",
          server: { name: "forged", command: "forged-mcp" },
        }),
      },
    );
    expect(missingHelperTrustResponse.status).toBe(403);
    expect(await missingHelperTrustResponse.json()).toEqual({
      error: "helper_trust_required",
    });

    const lanStdioResponse = await fetch(
      `${baseUrl}/internal/ask-agent/mcp-config/server`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json",
          ...helperNonLoopbackHeaders,
        },
        body: JSON.stringify({
          profile: "ask-agent",
          scope: "ask-agent-global",
          server: { name: "lan-stdio", command: "lan-mcp" },
        }),
      },
    );
    expect(lanStdioResponse.status).toBe(403);
    expect(await lanStdioResponse.json()).toEqual({
      error: "browser_local_process_requires_loopback",
    });

    const lanHttpResponse = await fetch(
      `${baseUrl}/internal/ask-agent/mcp-config/server`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json",
          ...helperNonLoopbackHeaders,
        },
        body: JSON.stringify({
          profile: "ask-agent",
          scope: "ask-agent-global",
          server: {
            name: "lan-http",
            type: "http",
            url: "https://example.com/mcp",
          },
        }),
      },
    );
    expect(lanHttpResponse.ok).toBe(true);

    const lanBatchRemoveResponse = await fetch(
      `${baseUrl}/internal/ask-agent/mcp-config/server`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json",
          ...helperNonLoopbackHeaders,
        },
        body: JSON.stringify({
          operationId: "lan-remove",
          profile: "ask-agent",
          scope: "ask-agent-global",
          expectedRevision: "revision-1",
          operations: [{ kind: "remove", serverName: "lan-http" }],
        }),
      },
    );
    expect(lanBatchRemoveResponse.status).toBe(403);
    expect(await lanBatchRemoveResponse.json()).toEqual({
      error: "browser_local_process_requires_loopback",
    });

    const lanBatchSecretResponse = await fetch(
      `${baseUrl}/internal/ask-agent/mcp-config/server`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json",
          ...helperNonLoopbackHeaders,
        },
        body: JSON.stringify({
          operationId: "lan-secret",
          profile: "ask-agent",
          scope: "ask-agent-global",
          expectedRevision: "revision-1",
          operations: [
            {
              kind: "upsert",
              conflictAction: "replace",
              server: {
                name: "lan-http",
                type: "http",
                url: "https://example.com/mcp",
                headers: { mode: "patch", set: { Authorization: "secret" } },
              },
            },
          ],
        }),
      },
    );
    expect(lanBatchSecretResponse.status).toBe(403);
    expect(await lanBatchSecretResponse.json()).toEqual({
      error: "browser_secret_write_requires_loopback",
    });

    const lanBatchPreserveResponse = await fetch(
      `${baseUrl}/internal/ask-agent/mcp-config/server`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json",
          ...helperNonLoopbackHeaders,
        },
        body: JSON.stringify({
          operationId: "lan-preserve",
          profile: "ask-agent",
          scope: "ask-agent-global",
          expectedRevision: "revision-1",
          operations: [
            {
              kind: "upsert",
              conflictAction: "replace",
              server: {
                name: "lan-http",
                type: "http",
                url: "https://example.com/mcp",
                env: { mode: "preserve" },
                headers: { mode: "preserve" },
              },
            },
          ],
        }),
      },
    );
    expect(lanBatchPreserveResponse.ok).toBe(true);
    expect(await lanBatchPreserveResponse.json()).toMatchObject({
      operationId: "lan-preserve",
      ok: true,
    });

    const lanBatchHttpResponse = await fetch(
      `${baseUrl}/internal/ask-agent/mcp-config/server`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json",
          ...helperNonLoopbackHeaders,
        },
        body: JSON.stringify({
          operationId: "lan-http-batch",
          profile: "ask-agent",
          scope: "ask-agent-global",
          expectedRevision: "revision-1",
          operations: [
            {
              kind: "upsert",
              conflictAction: "replace",
              server: {
                name: "lan-http",
                type: "http",
                url: "https://example.com/mcp",
              },
            },
          ],
        }),
      },
    );
    expect(lanBatchHttpResponse.ok).toBe(true);
    expect(await lanBatchHttpResponse.json()).toMatchObject({
      operationId: "lan-http-batch",
      ok: true,
    });
    expect(chatViewProvider.submitMcpConfigMutation).toHaveBeenCalledWith(
      expect.objectContaining({ operationId: "lan-http-batch" }),
    );

    const lanDeleteResponse = await fetch(
      `${baseUrl}/internal/ask-agent/mcp-config/server`,
      {
        method: "DELETE",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json",
          ...helperNonLoopbackHeaders,
        },
        body: JSON.stringify({
          profile: "ask-agent",
          scope: "ask-agent-global",
          serverName: "lan-http",
        }),
      },
    );
    expect(lanDeleteResponse.status).toBe(403);
    expect(await lanDeleteResponse.json()).toEqual({
      error: "browser_local_process_requires_loopback",
    });

    const browserDisableResponse = await fetch(`${baseUrl}/api/mcp/action`, {
      method: "POST",
      headers: {
        Authorization: "Bearer test-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ serverName: "linear", action: "disable" }),
    });
    expect(browserDisableResponse.status).toBe(403);
    expect(await browserDisableResponse.json()).toEqual({
      error: "main_profile_read_only_in_browser",
    });
    expect(chatViewProvider.submitBrowserMcpAction).not.toHaveBeenCalled();

    const browserReconnectResponse = await fetch(`${baseUrl}/api/mcp/action`, {
      method: "POST",
      headers: {
        Authorization: "Bearer test-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ serverName: "linear", action: "reconnect" }),
    });
    expect(browserReconnectResponse.ok).toBe(true);
    expect(chatViewProvider.submitBrowserMcpAction).toHaveBeenCalledWith(
      "linear",
      "reconnect",
    );

    const pageResponse = await fetch(`${baseUrl}/`);
    expect(pageResponse.status).toBe(404);
    expect(await pageResponse.json()).toEqual({ error: "not_found" });

    const gatewayJsResponse = await fetch(`${baseUrl}/browser-gateway.js`);
    expect(gatewayJsResponse.status).toBe(404);

    const gatewayCssResponse = await fetch(`${baseUrl}/browser-gateway.css`);
    expect(gatewayCssResponse.status).toBe(404);

    const codiconFontResponse = await fetch(
      `${baseUrl}/codicon.ttf?c7330ef9199d97dc5b8aae3449a5dc27`,
    );
    expect(codiconFontResponse.status).toBe(404);

    const faviconResponse = await fetch(`${baseUrl}/favicon.ico`);
    expect(faviconResponse.status).toBe(404);

    const snapshotResponse = await fetch(`${baseUrl}/api/ui-state`);
    expect(snapshotResponse.ok).toBe(true);
    const snapshotJson = await snapshotResponse.json();
    expect(snapshotJson).toMatchObject({
      ui: {
        approval: {
          kind: "write",
          id: "approval-1",
          filePath: "src/file.ts",
          writeOperation: "modify",
        },
        mcpStatusInfos: [],
        question: {
          id: "question-1",
          context: "Need confirmation.",
          questions: [
            {
              id: "q1",
              type: "yes_no",
              question: "Continue?",
            },
          ],
        },
        questionProgress: null,
        formElicitation: null,
        urlElicitation: null,
        recentEvents: [
          {
            type: "showApproval",
            request: {
              kind: "write",
              id: "approval-1",
              filePath: "src/file.ts",
              writeOperation: "modify",
            },
          },
          {
            type: "agentQuestionRequest",
            id: "question-1",
            context: "Need confirmation.",
            questions: [
              {
                id: "q1",
                type: "yes_no",
                question: "Continue?",
              },
            ],
          },
        ],
      },
      session: {
        sessions: [
          {
            id: "session-1",
            mode: "code",
            model: "claude-sonnet-4-6",
            title: "Test Session",
            messageCount: 2,
            totalInputTokens: 10,
            totalOutputTokens: 20,
            createdAt: 1,
            lastActiveAt: 2,
          },
        ],
        repository: null,
        foreground: {
          sessionId: "session-1",
          title: "Test Session",
          mode: "code",
          model: "claude-sonnet-4-6",
          status: "idle",
          streaming: false,
          projectedMessages: [
            {
              id: "chat-1",
              role: "assistant",
              content: "",
              timestamp: 1,
              blocks: [{ type: "text", text: "world" }],
            },
          ],
          statusOverride: null,
          thinkingEnabled: true,
          reasoningEffort: "high",
          lastInputTokens: 10,
          lastOutputTokens: 20,
          lastCacheReadTokens: 3,
          estimatedTotalUsed: 33,
          messageQueue: [],
          questionRequest: {
            id: "question-1",
            context: "Need confirmation.",
            questions: [
              {
                id: "q1",
                type: "yes_no",
                question: "Continue?",
              },
            ],
          },
          detectedQuestion: null,
          todos: [],
          debugInfo: null,
          systemPrompt: null,
          loadedInstructions: null,
          restoringSession: false,
          revertRecoveryNotice: null,
          contextBudget: {
            contextWindow: 200000,
            maxInputTokens: 191808,
            usedInputTokens: 10,
            outputReservation: 8192,
            safetyBufferTokens: 4096,
            softThresholdBudget: 150000,
            hardBudget: 180000,
          },
          condenseThreshold: 0.8,
          agentWriteApproval: "prompt",
          commandApprovalPolicy: "safe",
          configuredCommandApprovalPolicy: "safe",
        },
      },
      background: [
        {
          id: "bg-1",
          task: "Review implementation",
          status: "streaming",
          displayStatus: "streaming",
          resolvedMode: "review",
          resolvedModel: "claude-opus-4-8",
        },
      ],
      diffs: [
        {
          requestId: "approval-1",
          filePath: "src/file.ts",
          operation: "modify",
          originalPreview: "before",
          proposedPreview: "after",
          outsideWorkspace: false,
          createdAt: 1,
        },
        {
          requestId: "approval-large",
          filePath: "src/large-file.ts",
          operation: "modify",
          originalPreview: "a".repeat(600),
          proposedPreview: "b".repeat(600),
          outsideWorkspace: false,
          createdAt: 2,
        },
      ],
      theme: {
        cssVariables: {
          "--vscode-editor-background": "#1e1e1e",
        },
        colorScheme: "dark",
        themeLabel: "Dark",
        source: "vscode-theme-api",
      },
      modelsVersion: 0,
    });

    const unauthorizedDiffDetailResponse = await fetch(
      `${baseUrl}/api/diff/approval-1`,
    );
    expect(unauthorizedDiffDetailResponse.status).toBe(401);
    expect(await unauthorizedDiffDetailResponse.json()).toEqual({
      error: "unauthorized",
    });

    const diffDetailResponse = await fetch(`${baseUrl}/api/diff/approval-1`, {
      headers: { Authorization: "Bearer test-token" },
    });
    expect(diffDetailResponse.ok).toBe(true);
    expect(await diffDetailResponse.json()).toEqual({
      requestId: "approval-1",
      filePath: "src/file.ts",
      operation: "modify",
      outsideWorkspace: false,
      createdAt: 1,
      originalContent: "before",
      proposedContent: "after",
    });

    const missingDiffResponse = await fetch(`${baseUrl}/api/diff/missing`, {
      headers: { Authorization: "Bearer test-token" },
    });
    expect(missingDiffResponse.status).toBe(404);
    expect(await missingDiffResponse.json()).toEqual({ error: "not_found" });

    const largeDiffResponse = await fetch(
      `${baseUrl}/api/diff/approval-large`,
      {
        headers: { Authorization: "Bearer test-token" },
      },
    );
    expect(largeDiffResponse.status).toBe(413);
    expect(await largeDiffResponse.json()).toEqual({
      error: "diff_too_large",
      maxChars: 2_000_000,
      totalChars: 2_000_001,
      requestId: "approval-large",
      filePath: "src/large-file.ts",
      operation: "modify",
      outsideWorkspace: false,
      createdAt: 2,
    });

    const sseResponse = await fetch(`${baseUrl}/events`, {
      headers: { Accept: "text/event-stream" },
    });
    expect(sseResponse.ok).toBe(true);
    expect(sseResponse.body).toBeTruthy();

    const reader = sseResponse.body!.getReader();
    const decoder = new TextDecoder();

    const firstChunk = await reader.read();
    const snapshotChunk = decoder.decode(firstChunk.value, { stream: true });
    expect(snapshotChunk).toContain("event: snapshot");
    expect(snapshotChunk).toContain('"approval-1"');
    expect(snapshotChunk).toContain('"question-1"');
    expect(snapshotChunk).toContain('"session-1"');
    expect(snapshotChunk).toContain('"bg-1"');

    hub.publishApprovalIdle("session-1", "approval-1");

    const secondChunk = await reader.read();
    const updateChunk = decoder.decode(secondChunk.value, { stream: true });
    expect(updateChunk).toContain("event: update");
    expect(updateChunk).toContain('"approval":null');

    const unauthorizedApproval = await fetch(`${baseUrl}/api/approval`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "approval-1",
        approvalKind: "write",
        decision: "accept",
      }),
    });
    expect(unauthorizedApproval.status).toBe(401);

    const invalidApproval = await fetch(`${baseUrl}/api/approval`, {
      method: "POST",
      headers: {
        Authorization: "Bearer test-token",
      },
      body: "{bad json",
    });
    expect(invalidApproval.status).toBe(400);
    expect(await invalidApproval.json()).toEqual({ error: "invalid_json" });

    const authorizedApproval = await fetch(`${baseUrl}/api/approval`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-token",
      },
      body: JSON.stringify({
        id: "approval-1",
        approvalKind: "command",
        decision: "run-once",
        rules: [
          {
            pattern: "npm publish",
            mode: "exact",
            decision: "prompt",
            scope: "project",
          },
        ],
      }),
    });
    expect(authorizedApproval.status).toBe(200);
    expect(await authorizedApproval.json()).toEqual({ ok: true });
    expect(chatViewProvider.submitBrowserApprovalDecision).toHaveBeenCalledWith(
      {
        id: "approval-1",
        approvalKind: "command",
        decision: "run-once",
        rules: [
          {
            pattern: "npm publish",
            mode: "exact",
            decision: "prompt",
            scope: "project",
          },
        ],
      },
    );

    chatViewProvider.submitBrowserApprovalDecision.mockReturnValueOnce(false);
    const staleApproval = await fetch(`${baseUrl}/api/approval`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-token",
      },
      body: JSON.stringify({
        id: "approval-1",
        approvalKind: "write",
        decision: "run-once",
      }),
    });
    expect(staleApproval.status).toBe(404);
    expect(await staleApproval.json()).toEqual({ ok: false });

    const malformedApproval = await fetch(`${baseUrl}/api/approval`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-token",
      },
      body: JSON.stringify({ id: "approval-1", decision: "accept" }),
    });
    expect(malformedApproval.status).toBe(400);
    expect(await malformedApproval.json()).toEqual({
      error: "invalid_request",
    });

    const authorizedQuestion = await fetch(`${baseUrl}/api/question`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-token",
      },
      body: JSON.stringify({
        id: "question-1",
        answers: { q1: "Yes" },
        notes: {},
        attachments: {
          q1: [
            {
              kind: "image",
              name: "screen.png",
              mimeType: "image/png",
              base64: "image-data",
            },
          ],
        },
      }),
    });
    expect(authorizedQuestion.status).toBe(200);
    expect(await authorizedQuestion.json()).toEqual({ ok: true });
    expect(chatViewProvider.submitBrowserQuestionResponse).toHaveBeenCalledWith(
      {
        id: "question-1",
        answers: { q1: "Yes" },
        notes: {},
        attachments: {
          q1: [
            {
              kind: "image",
              name: "screen.png",
              mimeType: "image/png",
              base64: "image-data",
            },
          ],
        },
      },
    );

    const unauthorizedFormElicitation = await fetch(
      `${baseUrl}/api/form-elicitation`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "form-1",
          action: "accept",
          values: { project: "agentlink" },
        }),
      },
    );
    expect(unauthorizedFormElicitation.status).toBe(401);

    const authorizedFormElicitation = await fetch(
      `${baseUrl}/api/form-elicitation`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer test-token",
        },
        body: JSON.stringify({
          id: "form-1",
          action: "accept",
          values: {
            project: "agentlink",
            retries: 2,
            enabled: true,
            regions: ["us", "eu"],
          },
        }),
      },
    );
    expect(authorizedFormElicitation.status).toBe(200);
    expect(await authorizedFormElicitation.json()).toEqual({ ok: true });
    expect(chatViewProvider.submitBrowserFormElicitation).toHaveBeenCalledWith({
      id: "form-1",
      action: "accept",
      values: {
        project: "agentlink",
        retries: 2,
        enabled: true,
        regions: ["us", "eu"],
      },
    });

    const invalidFormElicitation = await fetch(
      `${baseUrl}/api/form-elicitation`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer test-token",
        },
        body: JSON.stringify({
          id: "form-1",
          action: "accept",
          values: { nested: { rejected: true } },
        }),
      },
    );
    expect(invalidFormElicitation.status).toBe(400);

    chatViewProvider.submitBrowserFormElicitation.mockReturnValueOnce({
      ok: false as const,
      reason: "invalid_values" as const,
      errors: { project: "Select a project." },
    });
    const invalidFormValues = await fetch(`${baseUrl}/api/form-elicitation`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-token",
      },
      body: JSON.stringify({
        id: "form-1",
        action: "accept",
        values: { project: "" },
      }),
    });
    expect(invalidFormValues.status).toBe(400);
    expect(await invalidFormValues.json()).toEqual({
      ok: false,
      errors: { project: "Select a project." },
    });

    chatViewProvider.submitBrowserFormElicitation.mockReturnValueOnce({
      ok: false as const,
      reason: "stale_request" as const,
    });
    const staleFormElicitation = await fetch(
      `${baseUrl}/api/form-elicitation`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer test-token",
        },
        body: JSON.stringify({ id: "stale-form", action: "cancel" }),
      },
    );
    expect(staleFormElicitation.status).toBe(404);
    expect(await staleFormElicitation.json()).toEqual({ ok: false });
    expect(
      chatViewProvider.submitBrowserFormElicitation,
    ).toHaveBeenLastCalledWith({
      id: "stale-form",
      action: "cancel",
    });

    const authorizedUrlElicitation = await fetch(
      `${baseUrl}/api/url-elicitation`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer test-token",
        },
        body: JSON.stringify({ id: "url-1", action: "accept" }),
      },
    );
    expect(authorizedUrlElicitation.status).toBe(200);
    expect(await authorizedUrlElicitation.json()).toEqual({ ok: true });
    expect(chatViewProvider.submitBrowserUrlElicitation).toHaveBeenCalledWith({
      id: "url-1",
      action: "accept",
    });

    const invalidUrlElicitation = await fetch(
      `${baseUrl}/api/url-elicitation`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer test-token",
        },
        body: JSON.stringify({ id: "url-1" }),
      },
    );
    expect(invalidUrlElicitation.status).toBe(400);

    const authorizedProgress = await fetch(`${baseUrl}/api/question-progress`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-token",
      },
      body: JSON.stringify({
        id: "question-1",
        step: 1,
        answers: { q1: "Yes" },
        notes: { q1: "because reasons" },
        origin: "browser-origin-abc",
      }),
    });
    expect(authorizedProgress.status).toBe(200);
    expect(await authorizedProgress.json()).toEqual({ ok: true });
    expect(
      chatViewProvider.publishBrowserQuestionProgress,
    ).toHaveBeenCalledWith({
      id: "question-1",
      step: 1,
      answers: { q1: "Yes" },
      notes: { q1: "because reasons" },
      origin: "browser-origin-abc",
    });

    const invalidProgress = await fetch(`${baseUrl}/api/question-progress`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-token",
      },
      body: JSON.stringify({ id: "question-1" }),
    });
    expect(invalidProgress.status).toBe(400);

    const authorizedSend = await fetch(`${baseUrl}/api/send`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-token",
      },
      body: JSON.stringify({
        text: "Ship it",
        sessionId: "session-1",
        mode: "code",
        images: [
          {
            name: "diagram.png",
            mimeType: "image/png",
            base64: "img-base64",
          },
        ],
        documents: [
          {
            name: "brief.pdf",
            mimeType: "application/pdf",
            base64: "pdf-base64",
          },
        ],
      }),
    });
    expect(authorizedSend.status).toBe(200);
    expect(await authorizedSend.json()).toEqual({ ok: true });
    expect(chatViewProvider.submitBrowserSend).toHaveBeenCalledWith({
      text: "Ship it",
      sessionId: "session-1",
      projectId: "project-a",
      mode: "code",
      thinkingEnabled: undefined,
      reasoningEffort: undefined,
      attachments: [],
      images: [
        {
          name: "diagram.png",
          mimeType: "image/png",
          base64: "img-base64",
        },
      ],
      documents: [
        {
          name: "brief.pdf",
          mimeType: "application/pdf",
          base64: "pdf-base64",
        },
      ],
      displayText: undefined,
      slashCommandLabel: undefined,
      isSlashCommand: false,
    });

    chatViewProvider.submitBrowserSend.mockResolvedValueOnce({
      ok: true,
      queued: true,
    });
    const queuedSend = await fetch(`${baseUrl}/api/send`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-token",
      },
      body: JSON.stringify({
        text: "Queue it",
        sessionId: "session-1",
        mode: "code",
        interject: true,
      }),
    });
    expect(queuedSend.status).toBe(200);
    expect(await queuedSend.json()).toEqual({ ok: true, queued: true });
    expect(chatViewProvider.submitBrowserSend).toHaveBeenLastCalledWith(
      expect.objectContaining({
        text: "Queue it",
        sessionId: "session-1",
        interject: true,
      }),
    );

    const authorizedMode = await fetch(`${baseUrl}/api/mode`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-token",
      },
      body: JSON.stringify({
        mode: "architect",
      }),
    });
    expect(authorizedMode.status).toBe(200);
    expect(await authorizedMode.json()).toEqual({
      approved: true,
      mode: "architect",
    });
    expect(chatViewProvider.submitBrowserModeSwitch).toHaveBeenCalledWith(
      "architect",
      "project-a",
    );

    const unauthorizedSlash = await fetch(`${baseUrl}/api/slash-commands`);
    expect(unauthorizedSlash.status).toBe(401);

    const authorizedSlash = await fetch(`${baseUrl}/api/slash-commands`, {
      headers: { Authorization: "Bearer test-token" },
    });
    expect(authorizedSlash.status).toBe(200);
    expect(await authorizedSlash.json()).toEqual({
      commands: [
        {
          name: "new",
          description: "Create new session",
          source: "builtin",
          builtin: true,
        },
        {
          name: "mcp",
          description: "Open MCP panel",
          source: "builtin",
          builtin: true,
        },
      ],
    });
    expect(chatViewProvider.getBrowserSlashCommands).toHaveBeenCalledWith(
      "project-a",
    );

    const invalidSearch = await fetch(`${baseUrl}/api/search-files`, {
      headers: { Authorization: "Bearer test-token" },
    });
    expect(invalidSearch.status).toBe(400);

    const authorizedSearch = await fetch(
      `${baseUrl}/api/search-files?query=src`,
      {
        headers: { Authorization: "Bearer test-token" },
      },
    );
    expect(authorizedSearch.status).toBe(200);
    expect(await authorizedSearch.json()).toEqual({
      files: [{ path: "src/index.ts", kind: "file" }],
    });
    expect(chatViewProvider.searchBrowserFiles).toHaveBeenCalledWith(
      "src",
      "project-a",
    );

    const authorizedModes = await fetch(`${baseUrl}/api/modes`, {
      headers: { Authorization: "Bearer test-token" },
    });
    expect(authorizedModes.status).toBe(200);
    expect(await authorizedModes.json()).toEqual({
      modes: [
        { slug: "code", name: "Code", icon: "code" },
        { slug: "architect", name: "Architect", icon: "symbol-structure" },
      ],
    });
    expect(chatViewProvider.getBrowserModes).toHaveBeenCalledWith("project-a");

    const authorizedModels = await fetch(`${baseUrl}/api/models`, {
      headers: { Authorization: "Bearer test-token" },
    });
    expect(authorizedModels.status).toBe(200);
    expect(await authorizedModels.json()).toEqual({
      models: [
        {
          id: "claude-sonnet-4-6",
          displayName: "Claude Sonnet 4.6",
          provider: "anthropic",
          contextWindow: 200000,
          authenticated: true,
          condenseThreshold: 0.8,
        },
      ],
    });
    expect(chatViewProvider.getBrowserModels).toHaveBeenCalled();

    const authorizedModelSwitch = await fetch(`${baseUrl}/api/model`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-token",
      },
      body: JSON.stringify({ model: "claude-opus-4-8" }),
    });
    expect(authorizedModelSwitch.status).toBe(200);
    const modelSwitchJson = await authorizedModelSwitch.json();
    expect(modelSwitchJson).toMatchObject({
      ok: true,
      snapshot: {
        session: {
          foreground: {
            model: "claude-opus-4-8",
          },
        },
      },
    });
    expect(chatViewProvider.submitBrowserSetModel).toHaveBeenCalledWith(
      "claude-opus-4-8",
    );

    const authorizedWriteApproval = await fetch(
      `${baseUrl}/api/write-approval`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer test-token",
        },
        body: JSON.stringify({ mode: "session" }),
      },
    );
    expect(authorizedWriteApproval.status).toBe(200);
    expect(await authorizedWriteApproval.json()).toEqual({ ok: true });
    expect(chatViewProvider.submitBrowserSetWriteApproval).toHaveBeenCalledWith(
      "session",
    );

    const authorizedCommandApprovalPolicy = await fetch(
      `${baseUrl}/api/command-approval-policy`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer test-token",
        },
        body: JSON.stringify({ policy: "approve-for-me" }),
      },
    );
    expect(authorizedCommandApprovalPolicy.status).toBe(200);
    expect(await authorizedCommandApprovalPolicy.json()).toEqual({ ok: true });
    expect(
      chatViewProvider.submitBrowserSetCommandApprovalPolicy,
    ).toHaveBeenCalledWith("approve-for-me");

    const invalidCommandApprovalPolicy = await fetch(
      `${baseUrl}/api/command-approval-policy`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer test-token",
        },
        body: JSON.stringify({ policy: "dangerous" }),
      },
    );
    expect(invalidCommandApprovalPolicy.status).toBe(400);
    expect(await invalidCommandApprovalPolicy.json()).toEqual({
      error: "invalid_request",
    });
    expect(
      chatViewProvider.submitBrowserSetCommandApprovalPolicy,
    ).toHaveBeenCalledTimes(1);

    const authorizedThinking = await fetch(`${baseUrl}/api/thinking`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-token",
      },
      body: JSON.stringify({ enabled: false }),
    });
    expect(authorizedThinking.status).toBe(200);
    expect(await authorizedThinking.json()).toEqual({ ok: true });
    expect(
      chatViewProvider.submitBrowserSetThinkingEnabled,
    ).toHaveBeenCalledWith(false);

    const authorizedAttach = await fetch(`${baseUrl}/api/attach-file`, {
      method: "POST",
      headers: {
        Authorization: "Bearer test-token",
      },
    });
    expect(authorizedAttach.status).toBe(200);
    expect(await authorizedAttach.json()).toEqual({
      files: ["/tmp/from-picker.txt"],
    });
    expect(chatViewProvider.submitBrowserAttachFile).toHaveBeenCalledWith(
      "project-a",
    );

    const authorizedOpenFile = await fetch(`${baseUrl}/api/open-file`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-token",
      },
      body: JSON.stringify({ path: "src/index.ts", line: 12 }),
    });
    expect(authorizedOpenFile.status).toBe(200);
    expect(await authorizedOpenFile.json()).toEqual({ ok: true });
    expect(chatViewProvider.submitBrowserOpenFile).toHaveBeenCalledWith(
      "src/index.ts",
      12,
      "project-a",
    );

    const invalidOpenFile = await fetch(`${baseUrl}/api/open-file`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-token",
      },
      body: JSON.stringify({ path: "src/index.ts", line: 0 }),
    });
    expect(invalidOpenFile.status).toBe(400);

    const authorizedNewSession = await fetch(`${baseUrl}/api/session/new`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-token",
      },
      body: JSON.stringify({ mode: "code" }),
    });
    expect(authorizedNewSession.status).toBe(200);
    await expect(authorizedNewSession.json()).resolves.toMatchObject({
      ok: true,
      snapshot: {
        session: {
          foreground: {
            model: "gpt-5.3-codex",
          },
        },
      },
    });
    expect(chatViewProvider.submitBrowserNewSession).toHaveBeenCalledWith(
      "code",
      "project-a",
    );

    const browserSelection = {
      controllerEpoch: "controller-1",
      tabId: "tab-2",
      sessionId: "session-2",
    };
    chatViewProvider.submitBrowserNewSession.mockResolvedValueOnce({
      ok: true,
      controllerEpoch: "controller-1",
      tabId: "tab-2",
      sessionId: "session-new",
      projectId: "project-a",
    } as never);
    const selectedNewSession = await fetch(`${baseUrl}/api/session/new`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-token",
      },
      body: JSON.stringify({
        mode: "code",
        projectId: "project-a",
        selection: browserSelection,
        stopRunning: true,
      }),
    });
    expect(selectedNewSession.status).toBe(200);
    await expect(selectedNewSession.json()).resolves.toEqual({
      ok: true,
      controllerEpoch: "controller-1",
      tabId: "tab-2",
      sessionId: "session-new",
      projectId: "project-a",
    });
    expect(chatViewProvider.submitBrowserNewSession).toHaveBeenLastCalledWith(
      "code",
      "project-a",
      browserSelection,
      true,
    );

    const selectedLoadSession = await fetch(`${baseUrl}/api/session/load`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-token",
      },
      body: JSON.stringify({
        sessionId: "session-1",
        projectId: "project-a",
        selection: browserSelection,
        stopRunning: true,
      }),
    });
    expect(selectedLoadSession.status).toBe(200);
    expect(chatViewProvider.submitBrowserLoadSession).toHaveBeenCalledWith(
      "session-1",
      browserSelection,
      true,
    );

    sessionManager.getWorkspaceProjects.mockReturnValue([
      {
        id: "project-a",
        name: "Project A",
        uri: "file:///workspace/a",
        rootPath: "/workspace/a",
        availability: { status: "available" },
      },
      {
        id: "project-b",
        name: "Project B",
        uri: "file:///workspace/b",
        rootPath: "/workspace/b",
        availability: { status: "available" },
      },
    ]);

    const missingProjectNewSession = await fetch(`${baseUrl}/api/session/new`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-token",
      },
      body: JSON.stringify({ mode: "code" }),
    });
    expect(missingProjectNewSession.status).toBe(409);
    await expect(missingProjectNewSession.json()).resolves.toMatchObject({
      error: "project_state_mismatch",
      reason: "project_required",
      refresh: true,
    });

    const missingProjectModes = await fetch(`${baseUrl}/api/modes`, {
      headers: { Authorization: "Bearer test-token" },
    });
    expect(missingProjectModes.status).toBe(409);
    await expect(missingProjectModes.json()).resolves.toMatchObject({
      error: "project_state_mismatch",
      reason: "project_required",
      refresh: true,
    });

    const projectBModes = await fetch(
      `${baseUrl}/api/modes?projectId=project-b`,
      { headers: { Authorization: "Bearer test-token" } },
    );
    expect(projectBModes.status).toBe(200);
    expect(chatViewProvider.getBrowserModes).toHaveBeenLastCalledWith(
      "project-b",
    );

    const projectBSlash = await fetch(
      `${baseUrl}/api/slash-commands?projectId=project-b`,
      { headers: { Authorization: "Bearer test-token" } },
    );
    expect(projectBSlash.status).toBe(200);
    expect(chatViewProvider.getBrowserSlashCommands).toHaveBeenLastCalledWith(
      "project-b",
    );

    const projectBSearch = await fetch(
      `${baseUrl}/api/search-files?query=src&projectId=project-b`,
      { headers: { Authorization: "Bearer test-token" } },
    );
    expect(projectBSearch.status).toBe(200);
    expect(chatViewProvider.searchBrowserFiles).toHaveBeenLastCalledWith(
      "src",
      "project-b",
    );

    const projectBAttach = await fetch(`${baseUrl}/api/attach-file`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-token",
      },
      body: JSON.stringify({ projectId: "project-b" }),
    });
    expect(projectBAttach.status).toBe(200);
    expect(chatViewProvider.submitBrowserAttachFile).toHaveBeenLastCalledWith(
      "project-b",
    );

    const modeSwitchCalls =
      chatViewProvider.submitBrowserModeSwitch.mock.calls.length;
    const mismatchedMode = await fetch(`${baseUrl}/api/mode`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-token",
      },
      body: JSON.stringify({
        mode: "architect",
        sessionId: "session-1",
        projectId: "project-b",
      }),
    });
    expect(mismatchedMode.status).toBe(409);
    await expect(mismatchedMode.json()).resolves.toMatchObject({
      error: "project_state_mismatch",
      reason: "session_project_mismatch",
      refresh: true,
    });
    expect(chatViewProvider.submitBrowserModeSwitch).toHaveBeenCalledTimes(
      modeSwitchCalls,
    );

    for (const route of ["steer", "interject"]) {
      const mismatchedQueue = await fetch(`${baseUrl}/api/queue/${route}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer test-token",
        },
        body: JSON.stringify({
          sessionId: "session-1",
          projectId: "project-b",
          queueId: `queue-${route}`,
          text: "Wrong project",
        }),
      });
      expect(mismatchedQueue.status).toBe(409);
      await expect(mismatchedQueue.json()).resolves.toMatchObject({
        error: "project_state_mismatch",
        reason: "session_project_mismatch",
        refresh: true,
      });
    }
    expect(
      chatViewProvider.submitBrowserSteerQueuedMessage,
    ).not.toHaveBeenCalled();
    expect(
      chatViewProvider.submitBrowserInterjectQueuedMessage,
    ).not.toHaveBeenCalled();

    const mismatchedSend = await fetch(`${baseUrl}/api/send`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-token",
      },
      body: JSON.stringify({
        text: "Wrong project",
        sessionId: "session-1",
        projectId: "project-b",
      }),
    });
    expect(mismatchedSend.status).toBe(409);
    await expect(mismatchedSend.json()).resolves.toMatchObject({
      error: "project_state_mismatch",
      reason: "session_project_mismatch",
      sessionProjectId: "project-a",
      refresh: true,
    });

    const mismatchedLoad = await fetch(`${baseUrl}/api/session/load`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-token",
      },
      body: JSON.stringify({
        sessionId: "session-1",
        projectId: "project-b",
      }),
    });
    expect(mismatchedLoad.status).toBe(409);
    await expect(mismatchedLoad.json()).resolves.toMatchObject({
      error: "project_state_mismatch",
      reason: "session_project_mismatch",
      refresh: true,
    });

    const unknownDefault = await fetch(`${baseUrl}/api/project/default`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-token",
      },
      body: JSON.stringify({ projectId: "project-missing" }),
    });
    expect(unknownDefault.status).toBe(409);
    await expect(unknownDefault.json()).resolves.toMatchObject({
      error: "project_state_mismatch",
      reason: "project_not_found",
      refresh: true,
    });

    const selectedDefault = await fetch(`${baseUrl}/api/project/default`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-token",
      },
      body: JSON.stringify({ projectId: "project-b" }),
    });
    expect(selectedDefault.status).toBe(200);
    await expect(selectedDefault.json()).resolves.toMatchObject({
      ok: true,
      projectId: "project-b",
    });
    expect(sessionManager.setBrowserPreferredProject).toHaveBeenCalledWith(
      "project-b",
    );

    const authorizedStop = await fetch(`${baseUrl}/api/stop`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-token",
      },
      body: JSON.stringify({ sessionId: "session-1" }),
    });
    expect(authorizedStop.status).toBe(200);
    expect(await authorizedStop.json()).toEqual({ ok: true });
    expect(chatViewProvider.submitBrowserStop).toHaveBeenCalledWith(
      "session-1",
    );

    const authorizedResume = await fetch(`${baseUrl}/api/resume`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-token",
      },
      body: JSON.stringify({ sessionId: "session-1" }),
    });
    expect(authorizedResume.status).toBe(202);
    expect(await authorizedResume.json()).toEqual({ ok: true });
    expect(chatViewProvider.submitBrowserResume).toHaveBeenCalledWith(
      "session-1",
    );

    chatViewProvider.submitBrowserResume.mockResolvedValueOnce({
      ok: false,
      error: "resume_not_started",
    });
    const rejectedResume = await fetch(`${baseUrl}/api/resume`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-token",
      },
      body: JSON.stringify({ sessionId: "session-1" }),
    });
    expect(rejectedResume.status).toBe(409);
    expect(await rejectedResume.json()).toEqual({
      ok: false,
      error: "resume_not_started",
    });

    const invalidResume = await fetch(`${baseUrl}/api/resume`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-token",
      },
      body: JSON.stringify({}),
    });
    expect(invalidResume.status).toBe(400);
    const unauthorizedResume = await fetch(`${baseUrl}/api/resume`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "session-1" }),
    });
    expect(unauthorizedResume.status).toBe(401);

    const authorizedBgStop = await fetch(`${baseUrl}/api/background/stop`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-token",
      },
      body: JSON.stringify({ sessionId: "bg-1" }),
    });
    expect(authorizedBgStop.status).toBe(200);
    expect(await authorizedBgStop.json()).toEqual({ ok: true });
    expect(chatViewProvider.submitBrowserStopBackground).toHaveBeenCalledWith(
      "bg-1",
    );

    const authorizedBgTranscript = await fetch(
      `${baseUrl}/api/background/open-transcript`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer test-token",
        },
        body: JSON.stringify({ sessionId: "bg-1" }),
      },
    );
    expect(authorizedBgTranscript.status).toBe(200);
    await expect(authorizedBgTranscript.json()).resolves.toMatchObject({
      ok: true,
      transcript: {
        sessionId: "bg-1",
        task: "Background Agent",
      },
    });
    expect(chatViewProvider.getBrowserBgTranscript).toHaveBeenCalledWith(
      "bg-1",
    );

    await reader.cancel();
    await server.stop();
    service.dispose();
    hub.dispose();
  });
});
