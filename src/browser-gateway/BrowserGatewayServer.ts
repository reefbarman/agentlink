import * as http from "http";
import type * as vscode from "vscode";

import { isCoreReasoningEffort } from "../core/modelCatalog.js";
import type {
  McpFormElicitationResponse,
  McpElicitationValues,
} from "../shared/mcpElicitation.js";
import type {
  McpConfigBatchMutation,
  McpManagerProfile,
  McpManagerScope,
  McpManagerServerDraft,
} from "../shared/mcpManagerTypes.js";
import {
  clearBrowserGatewayDiscovery,
  writeBrowserGatewayDiscovery,
} from "./browserGatewayDiscovery.js";
import type { BrowserGatewayDataPlaneMode } from "./browserGatewayDataPlaneMode.js";
import {
  getBrowserGatewayRegistryPath,
  listCheckedBrowserGatewayInstances,
  listRegisteredBrowserGatewayInstances,
  removeBrowserGatewayInstance,
  upsertBrowserGatewayInstance,
} from "./browserGatewayRegistry.js";
import {
  hasBrowserGatewayMcpSecretWrite,
  verifyBrowserGatewayHelperTrust,
} from "./browserGatewayRequestTrust.js";

import type { BrowserGatewayInstanceStatusSummary } from "./protocol.js";
import type {
  BrowserGatewayService,
  BrowserGatewaySnapshotPublication,
} from "./BrowserGatewayService.js";
import type { ChatViewProvider } from "../agent/ChatViewProvider.js";
import type { DecisionMessage } from "../approvals/webview/types.js";
import { isCommandApprovalPolicy } from "../approvals/commandApprovalPolicy.js";
import { diffSnapshotHub } from "./DiffSnapshotHub.js";
import { writeBrowserGatewayThemeCache } from "./browserGatewayThemeCache.js";
import {
  BrowserGatewayHttpRouter,
  type BrowserGatewayHttpMethod,
  type BrowserGatewayHttpRoute,
  type BrowserGatewayRouteErrorPolicy,
  type BrowserGatewayRouteMatch,
} from "./browserGatewayHttpRouter.js";
import { readJsonBody } from "./nodeHttpPrimitives.js";
import { SseHub, type SsePublication } from "./SseHub.js";
import {
  getDevelopmentStreamingBaselineMetrics,
  type StreamingBaselineMetrics,
} from "../shared/streamingBaselineMetrics.js";

export type BrowserGatewaySnapshot = ReturnType<
  BrowserGatewayService["getSerializableSnapshotState"]
>;

export type BrowserGatewayInstanceListItem = Omit<
  Awaited<ReturnType<typeof listRegisteredBrowserGatewayInstances>>[number],
  "authToken"
> & {
  status?: BrowserGatewayInstanceStatusSummary;
};

const SSE_KEEPALIVE_INTERVAL_MS = 15_000;
const REGISTRY_HEARTBEAT_INTERVAL_MS = 10_000;
const MAX_BROWSER_DIFF_DETAIL_CHARS = 2_000_000;

export class BrowserGatewayServer implements vscode.Disposable {
  private server: http.Server | null = null;
  private port: number | null = null;
  private sseHub: SseHub<BrowserGatewaySnapshot> | null = null;
  private readonly disposables: vscode.Disposable[] = [];
  private registryHeartbeatTimer: NodeJS.Timeout | undefined;
  private startedAtIso: string | null = null;
  private lastPersistedThemeSnapshot = "";
  private httpRouter: BrowserGatewayHttpRouter | undefined;

  constructor(
    private readonly gatewayService: BrowserGatewayService,
    private readonly chatViewProvider: ChatViewProvider,
    private readonly authToken: string,
    private readonly instanceId: string,
    private readonly workspaceName: string,
    private readonly workspacePath: string,
    private readonly log: (message: string) => void,
    private readonly streamingMetrics: StreamingBaselineMetrics = getDevelopmentStreamingBaselineMetrics(
      "vscode-gateway",
      __DEV_BUILD__,
    ),
    private readonly getHelperSharedSecret: () => string | null = () => null,
    private readonly dataPlaneMode: BrowserGatewayDataPlaneMode = "off",
  ) {}

  async start(port = 0): Promise<number> {
    if (this.server && this.port !== null) {
      return this.port;
    }

    this.sseHub = this.createSseHub();
    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res);
    });
    this.server.timeout = 0;
    this.server.keepAliveTimeout = 0;
    this.server.headersTimeout = 0;

    this.disposables.push(
      this.gatewayService.onDidChange((publication) => {
        void this.persistCurrentThemeSnapshot(publication.snapshot.theme);
        this.broadcast(publication);
      }),
    );

    // Let the service skip explicit snapshot work when no client is connected.
    this.gatewayService.setHasActiveClientsProbe(
      () => (this.sseHub?.size ?? 0) > 0,
    );

    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error) => {
          this.server?.off("listening", onListening);
          reject(err);
        };
        const onListening = () => {
          this.server?.off("error", onError);
          resolve();
        };
        this.server!.once("error", onError);
        this.server!.once("listening", onListening);
        this.server!.listen(port, "127.0.0.1");
      });

      this.server.on("error", (err) => {
        this.log(`[browser-gateway] server error: ${err}`);
      });

      const address = this.server.address();
      this.port = typeof address === "object" && address ? address.port : port;
      const url = `http://127.0.0.1:${this.port}`;
      const startedAt = new Date().toISOString();
      this.startedAtIso = startedAt;
      await writeBrowserGatewayDiscovery({
        pid: process.pid,
        port: this.port,
        url,
        protocolVersion: 1,
        startedAt,
        authToken: this.authToken,
      });
      const theme = this.gatewayService.getCurrentThemeSnapshot();
      this.lastPersistedThemeSnapshot = JSON.stringify(theme);
      await writeBrowserGatewayThemeCache(theme).catch((err: unknown) => {
        this.log(`[browser-gateway] failed to write theme cache: ${err}`);
      });
      await this.upsertCurrentRegistryRecord(theme);
      this.startRegistryHeartbeat();
      this.log(
        `[browser-gateway] listening on ${url} instanceId=${this.instanceId} pid=${process.pid} workspace=${JSON.stringify(this.workspaceName)} path=${JSON.stringify(this.workspacePath)} registry=${getBrowserGatewayRegistryPath()}`,
      );
      return this.port;
    } catch (error) {
      await this.rollbackFailedStart();
      throw error;
    }
  }

  getUrl(): string | null {
    if (this.port === null) return null;
    return `http://127.0.0.1:${this.port}`;
  }

  getSnapshot(): BrowserGatewaySnapshot {
    const startedAt = this.streamingMetrics.enabled ? performance.now() : 0;
    const snapshot = this.gatewayService.getSerializableSnapshotState();
    if (this.streamingMetrics.enabled) {
      this.streamingMetrics.record({
        type: "snapshot_build",
        surface: "vscode-gateway",
        durationMs: performance.now() - startedAt,
        messageCount:
          snapshot.session.foreground?.projectedMessages.length ?? 0,
      });
    }
    return snapshot;
  }

  private async upsertCurrentRegistryRecord(
    theme = this.gatewayService.getCurrentThemeSnapshot(),
  ): Promise<void> {
    if (this.port === null) return;
    const url = `http://127.0.0.1:${this.port}`;
    await upsertBrowserGatewayInstance({
      instanceId: this.instanceId,
      workspaceName: this.workspaceName,
      workspacePath: this.workspacePath,
      pid: process.pid,
      port: this.port,
      url,
      protocolVersion: 1,
      startedAt: this.startedAtIso ?? new Date().toISOString(),
      authToken: this.authToken,
      dataPlaneMode: this.dataPlaneMode,
      theme,
    });
    this.log(
      `[browser-gateway] registry heartbeat instanceId=${this.instanceId} pid=${process.pid} port=${this.port} url=${url}`,
    );
  }

  private startRegistryHeartbeat(): void {
    if (this.registryHeartbeatTimer) return;
    this.registryHeartbeatTimer = setInterval(() => {
      void this.upsertCurrentRegistryRecord().catch((err: unknown) => {
        this.log(
          `[browser-gateway] failed to refresh registry heartbeat: ${err}`,
        );
      });
    }, REGISTRY_HEARTBEAT_INTERVAL_MS);
  }

  private async persistCurrentThemeSnapshot(
    theme = this.gatewayService.getCurrentThemeSnapshot(),
  ): Promise<void> {
    if (this.port === null) return;
    const serializedTheme = JSON.stringify(theme);
    if (serializedTheme === this.lastPersistedThemeSnapshot) return;
    this.lastPersistedThemeSnapshot = serializedTheme;
    await writeBrowserGatewayThemeCache(theme).catch((err: unknown) => {
      this.log(`[browser-gateway] failed to write theme cache: ${err}`);
    });
    await this.upsertCurrentRegistryRecord(theme).catch((err: unknown) => {
      this.log(`[browser-gateway] failed to update theme registry: ${err}`);
    });
  }

  async stop(): Promise<void> {
    await this.teardownLocalServer();
    await this.clearExternalRegistration();
  }

  dispose(): void {
    void this.stop();
  }

  private async rollbackFailedStart(): Promise<void> {
    await this.teardownLocalServer();
    await this.clearExternalRegistration();
  }

  private async teardownLocalServer(): Promise<void> {
    if (this.registryHeartbeatTimer) {
      clearInterval(this.registryHeartbeatTimer);
      this.registryHeartbeatTimer = undefined;
    }
    this.gatewayService.setHasActiveClientsProbe(undefined);
    for (const disposable of this.disposables) disposable.dispose();
    this.disposables.length = 0;
    this.sseHub?.dispose();
    const server = this.server;
    if (server?.listening) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    this.server = null;
    this.sseHub = null;
    this.port = null;
    this.startedAtIso = null;
    this.lastPersistedThemeSnapshot = "";
  }

  private async clearExternalRegistration(): Promise<void> {
    await Promise.allSettled([
      clearBrowserGatewayDiscovery(),
      removeBrowserGatewayInstance(this.instanceId),
    ]);
  }

  private handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    this.getHttpRouter().dispatch(req, res);
  }

  private getHttpRouter(): BrowserGatewayHttpRouter {
    this.httpRouter ??= new BrowserGatewayHttpRouter(this.createHttpRoutes(), {
      writeJson: (res, status, body) => this.writeJson(res, status, body),
      log: (message) => this.log(message),
    });
    return this.httpRouter;
  }

  private createHttpRoutes(): readonly BrowserGatewayHttpRoute[] {
    const none = { kind: "none" } as const;
    const internal = (logLabel: string): BrowserGatewayRouteErrorPolicy => ({
      kind: "internal",
      logLabel,
    });
    const json = (logLabel: string): BrowserGatewayRouteErrorPolicy => ({
      kind: "invalid-json-or-internal",
      logLabel,
    });
    const match = (
      kind: BrowserGatewayRouteMatch["kind"],
      value: string,
    ): BrowserGatewayRouteMatch => ({ kind, value });
    const route = (
      method: BrowserGatewayHttpMethod,
      routeMatch: BrowserGatewayRouteMatch,
      invoke: BrowserGatewayHttpRoute["invoke"],
      error: BrowserGatewayRouteErrorPolicy = none,
      authorize?: BrowserGatewayHttpRoute["authorize"],
    ): BrowserGatewayHttpRoute => ({
      method,
      match: routeMatch,
      error,
      authorize,
      invoke,
    });
    const rawExact = (value: string): BrowserGatewayRouteMatch =>
      match("raw-exact", value);
    const pathExact = (value: string): BrowserGatewayRouteMatch =>
      match("path-exact", value);

    return [
      route("GET", rawExact("/health"), ({ res }) => {
        this.writeJson(res, 200, { status: "ok" });
      }),
      route("GET", pathExact("/api/ui-state"), ({ res }) => {
        this.writeJson(res, 200, this.getSnapshot());
      }),
      route(
        "GET",
        pathExact("/api/instance-status"),
        ({ res }) => {
          this.writeJson(
            res,
            200,
            this.gatewayService.getInstanceStatusSummary(),
          );
        },
        none,
        ({ req }) => this.isAuthorized(req),
      ),
      route("GET", pathExact("/api/instances"), ({ res }) => {
        void this.handleInstancesRequest(res);
      }),
      route(
        "GET",
        match("path-prefix", "/api/diff/"),
        ({ req, rawUrl, res }) => {
          this.handleDiffDetailRequest(req, rawUrl, res);
        },
      ),
      route(
        "GET",
        pathExact("/events"),
        ({ req, res }) => this.handleSse(req, res),
        internal("SSE subscription failed"),
      ),
      route(
        "POST",
        rawExact("/api/approval"),
        ({ req, res }) => this.handleApprovalAction(req, res),
        json("approval action failed"),
      ),
      route(
        "POST",
        rawExact("/api/suggest-regex"),
        ({ req, res }) => this.handleSuggestRegexAction(req, res),
        json("suggest-regex action failed"),
      ),
      route(
        "POST",
        rawExact("/api/polish-prompt"),
        ({ req, res }) => this.handlePolishPromptAction(req, res),
        json("polish-prompt action failed"),
      ),
      route(
        "POST",
        rawExact("/api/question"),
        ({ req, res }) => this.handleQuestionAction(req, res),
        json("question action failed"),
      ),
      route(
        "POST",
        rawExact("/api/form-elicitation"),
        ({ req, res }) => this.handleFormElicitationAction(req, res),
        json("form elicitation action failed"),
      ),
      route(
        "POST",
        rawExact("/api/url-elicitation"),
        ({ req, res }) => this.handleUrlElicitationAction(req, res),
        json("url elicitation action failed"),
      ),
      route(
        "POST",
        rawExact("/api/question-progress"),
        ({ req, res }) => this.handleQuestionProgressAction(req, res),
        json("question-progress action failed"),
      ),
      route(
        "POST",
        rawExact("/api/send"),
        ({ req, res }) => this.handleSendAction(req, res),
        json("send action failed"),
      ),
      route(
        "POST",
        rawExact("/api/queue/steer"),
        ({ req, res }) => this.handleQueueSteerAction(req, res),
        json("queue steer action failed"),
      ),
      route(
        "POST",
        rawExact("/api/queue/interject"),
        ({ req, res }) => this.handleQueueInterjectAction(req, res),
        json("queue interject action failed"),
      ),
      route(
        "POST",
        rawExact("/api/mode"),
        ({ req, res }) => this.handleModeAction(req, res),
        json("mode action failed"),
      ),
      route(
        "GET",
        pathExact("/api/slash-commands"),
        ({ req, res }) => this.handleSlashCommandsRequest(req, res),
        internal("slash commands request failed"),
      ),
      route(
        "GET",
        match("raw-prefix", "/api/search-files"),
        ({ req, rawUrl, res }) =>
          this.handleSearchFilesRequest(req, rawUrl, res),
        internal("file search request failed"),
      ),
      route(
        "GET",
        pathExact("/api/modes"),
        ({ req, res }) => this.handleModesRequest(req, res),
        internal("modes request failed"),
      ),
      route(
        "GET",
        rawExact("/api/models"),
        ({ req, res }) => this.handleModelsRequest(req, res),
        internal("models request failed"),
      ),
      route(
        "GET",
        rawExact("/api/sessions"),
        ({ req, res }) => this.handleSessionsRequest(req, res),
        internal("sessions request failed"),
      ),
      route(
        "POST",
        rawExact("/api/model"),
        ({ req, res }) => this.handleModelAction(req, res),
        json("model action failed"),
      ),
      route(
        "POST",
        rawExact("/api/write-approval"),
        ({ req, res }) => this.handleWriteApprovalAction(req, res),
        json("write approval action failed"),
      ),
      route(
        "POST",
        rawExact("/api/command-approval-policy"),
        ({ req, res }) => this.handleCommandApprovalPolicyAction(req, res),
        json("command approval policy action failed"),
      ),
      route(
        "POST",
        rawExact("/api/thinking"),
        ({ req, res }) => this.handleThinkingAction(req, res),
        json("thinking action failed"),
      ),
      route(
        "POST",
        rawExact("/api/attach-file"),
        ({ req, res }) => this.handleAttachFileAction(req, res),
        json("attach file action failed"),
      ),
      route(
        "POST",
        rawExact("/api/open-file"),
        ({ req, res }) => this.handleOpenFileAction(req, res),
        json("open file action failed"),
      ),
      route(
        "POST",
        rawExact("/api/project/default"),
        ({ req, res }) => this.handleDefaultProjectAction(req, res),
        json("default project action failed"),
      ),
      route(
        "POST",
        rawExact("/api/session/new"),
        ({ req, res }) => this.handleSessionNewAction(req, res),
        json("session new action failed"),
      ),
      route(
        "POST",
        rawExact("/api/session/load"),
        ({ req, res }) => this.handleSessionLoadAction(req, res),
        json("session load action failed"),
      ),
      route(
        "POST",
        rawExact("/api/session/delete"),
        ({ req, res }) => this.handleSessionDeleteAction(req, res),
        json("session delete action failed"),
      ),
      route(
        "POST",
        rawExact("/api/session/rename"),
        ({ req, res }) => this.handleSessionRenameAction(req, res),
        json("session rename action failed"),
      ),
      route(
        "POST",
        rawExact("/api/session/copy-first-prompt"),
        ({ req, res }) => this.handleSessionCopyFirstPromptAction(req, res),
        json("session copy first prompt action failed"),
      ),
      route(
        "POST",
        rawExact("/api/debug/refresh"),
        ({ req, res }) => this.handleDebugRefreshAction(req, res),
        internal("debug refresh action failed"),
      ),
      route(
        "GET",
        rawExact("/internal/ask-agent/web-policy"),
        ({ req, res }) => this.handleAskAgentWebPolicy(req, res),
        internal("ask-agent web policy failed"),
      ),
      route(
        "GET",
        rawExact("/internal/ask-agent/mcp-tools"),
        ({ req, res }) => this.handleAskAgentMcpTools(req, res),
        internal("ask-agent mcp tools failed"),
      ),
      route(
        "GET",
        pathExact("/internal/ask-agent/mcp-status"),
        ({ req, res }) => this.handleAskAgentMcpStatus(req, res),
        internal("ask-agent mcp status failed"),
      ),
      route(
        "GET",
        pathExact("/internal/ask-agent/mcp-config"),
        ({ req, pathOnly, res }) =>
          this.handleMcpConfigSnapshot(
            req,
            `${pathOnly}?profile=ask-agent`,
            res,
          ),
        internal("ask-agent mcp config failed"),
      ),
      route(
        "POST",
        pathExact("/internal/ask-agent/mcp-config/server"),
        ({ req, res }) => this.handleMcpConfigServer(req, res, true),
        json("ask-agent mcp config save failed"),
      ),
      route(
        "DELETE",
        pathExact("/internal/ask-agent/mcp-config/server"),
        ({ req, res }) => this.handleMcpConfigRemove(req, res, true),
        json("ask-agent mcp config remove failed"),
      ),
      route(
        "POST",
        pathExact("/internal/ask-agent/mcp-config/open-raw"),
        ({ req, res }) => this.handleBrowserMcpConfigUnavailable(req, res),
        json("ask-agent mcp config raw open failed"),
      ),
      route(
        "POST",
        pathExact("/internal/ask-agent/mcp-refresh"),
        ({ req, res }) => this.handleAskAgentMcpRefresh(req, res),
        internal("ask-agent mcp refresh failed"),
      ),
      route(
        "POST",
        pathExact("/internal/ask-agent/mcp-tool"),
        ({ req, res }) => this.handleAskAgentMcpTool(req, res),
        json("ask-agent mcp tool failed"),
      ),
      route(
        "GET",
        pathExact("/api/mcp/config"),
        ({ req, rawUrl, res }) =>
          this.handleMcpConfigSnapshot(req, rawUrl, res),
        internal("mcp config snapshot failed"),
      ),
      route(
        "POST",
        pathExact("/api/mcp/config/server"),
        ({ req, res }) => this.handleBrowserMcpConfigUnavailable(req, res),
        json("mcp config save failed"),
      ),
      route(
        "DELETE",
        pathExact("/api/mcp/config/server"),
        ({ req, res }) => this.handleBrowserMcpConfigUnavailable(req, res),
        json("mcp config remove failed"),
      ),
      route(
        "POST",
        pathExact("/api/mcp/config/open-raw"),
        ({ req, res }) => this.handleBrowserMcpConfigUnavailable(req, res),
        json("mcp config raw open failed"),
      ),
      route(
        "POST",
        pathExact("/api/mcp/action"),
        ({ req, res }) => this.handleMcpAction(req, res),
        json("mcp action failed"),
      ),
      route(
        "POST",
        rawExact("/api/stop"),
        ({ req, res }) => this.handleStopAction(req, res),
        json("stop action failed"),
      ),
      route(
        "POST",
        rawExact("/api/background/stop"),
        ({ req, res }) => this.handleBackgroundStopAction(req, res),
        json("background stop action failed"),
      ),
      route(
        "POST",
        rawExact("/api/background/action"),
        ({ req, res }) => this.handleBackgroundAction(req, res),
        internal("background action failed"),
      ),
      route(
        "POST",
        rawExact("/api/background/open-transcript"),
        ({ req, res }) => this.handleBackgroundOpenTranscriptAction(req, res),
        json("background open transcript action failed"),
      ),
    ];
  }

  private async handleSse(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const sseHub = this.sseHub;
    if (!sseHub) {
      this.writeJson(res, 503, { error: "service_unavailable" });
      return;
    }
    await sseHub.subscribe(req, res, () =>
      this.toSsePublication(this.gatewayService.createSnapshotPublication()),
    );
  }

  private broadcast(publication: BrowserGatewaySnapshotPublication): void {
    const result = this.sseHub?.broadcast(
      this.toSsePublication(publication),
    ) ?? {
      attempted: 0,
      delivered: 0,
    };
    if (this.streamingMetrics.enabled) {
      this.streamingMetrics.record({
        type: "broadcast",
        surface: "vscode-gateway",
        clientCount: result.attempted,
        deliveredClientCount: result.delivered,
        bytes: publication.bytes,
      });
    }
  }

  private createSseHub(): SseHub<BrowserGatewaySnapshot> {
    return new SseHub({
      serialize: JSON.stringify,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
        "Access-Control-Allow-Origin": "*",
      },
      keepaliveIntervalMs: SSE_KEEPALIVE_INTERVAL_MS,
      onClientCountChanged: (clientCount) => {
        if (!this.streamingMetrics.enabled) return;
        this.streamingMetrics.record({
          type: "sse_clients",
          surface: "vscode-gateway",
          clientCount,
        });
      },
      onClientRemoved: (reason) => {
        if (!this.streamingMetrics.enabled) return;
        this.streamingMetrics.record({
          type: "sse_client_removed",
          surface: "vscode-gateway",
          reason,
        });
      },
      onFirstDelivery: ({ durationMs, bytes }) => {
        if (!this.streamingMetrics.enabled) return;
        this.streamingMetrics.record({
          type: "sse_first_delivery",
          surface: "vscode-gateway",
          durationMs,
          bytes,
        });
      },
    });
  }

  private toSsePublication(
    publication: BrowserGatewaySnapshotPublication,
  ): SsePublication<BrowserGatewaySnapshot> {
    return {
      revision: publication.revision,
      value: publication.snapshot,
      serialized: publication.serialized,
      bytes: publication.bytes,
    };
  }

  private async handleInstancesRequest(
    res: http.ServerResponse,
  ): Promise<void> {
    const { registered: registeredInstances, healthy: healthyInstances } =
      await listCheckedBrowserGatewayInstances();
    this.log(
      `[browser-gateway] /api/instances currentInstanceId=${this.instanceId} registered=${registeredInstances.length} healthy=${healthyInstances.length} registeredIds=${registeredInstances.map((instance) => instance.instanceId).join(",") || "none"}`,
    );
    this.writeJson(res, 200, {
      currentInstanceId: this.instanceId,
      instances: registeredInstances.map(
        ({ authToken: _authToken, ...instance }) => ({
          ...instance,
          status:
            instance.instanceId === this.instanceId
              ? this.gatewayService.getInstanceStatusSummary()
              : undefined,
        }),
      ),
    });
  }

  private handleDiffDetailRequest(
    req: http.IncomingMessage,
    url: string,
    res: http.ServerResponse,
  ): void {
    if (!this.isAuthorized(req)) {
      this.writeJson(res, 401, { error: "unauthorized" });
      return;
    }

    const pathOnly = url.split("?", 1)[0] ?? url;
    const requestId = decodeURIComponent(pathOnly.slice("/api/diff/".length));
    const snapshot = diffSnapshotHub.get(requestId);
    if (!snapshot) {
      this.writeJson(res, 404, { error: "not_found" });
      return;
    }

    const totalChars =
      snapshot.originalContent.length + snapshot.proposedContent.length;
    if (totalChars > MAX_BROWSER_DIFF_DETAIL_CHARS) {
      this.writeJson(res, 413, {
        error: "diff_too_large",
        maxChars: MAX_BROWSER_DIFF_DETAIL_CHARS,
        totalChars,
        requestId: snapshot.requestId,
        filePath: snapshot.filePath,
        operation: snapshot.operation,
        outsideWorkspace: snapshot.outsideWorkspace,
        createdAt: snapshot.createdAt,
      });
      return;
    }

    this.writeJson(res, 200, {
      requestId: snapshot.requestId,
      filePath: snapshot.filePath,
      operation: snapshot.operation,
      outsideWorkspace: snapshot.outsideWorkspace,
      createdAt: snapshot.createdAt,
      originalContent: snapshot.originalContent,
      proposedContent: snapshot.proposedContent,
    });
  }

  private async handleApprovalAction(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    if (!this.isAuthorized(req)) {
      this.writeJson(res, 401, { error: "unauthorized" });
      return;
    }

    const body = await readJsonBody(req);
    const parsed =
      body && typeof body === "object"
        ? (body as Record<string, unknown>)
        : undefined;
    if (
      typeof parsed?.id !== "string" ||
      typeof parsed.approvalKind !== "string" ||
      typeof parsed.decision !== "string"
    ) {
      this.writeJson(res, 400, { error: "invalid_request" });
      return;
    }
    const ok = this.chatViewProvider.submitBrowserApprovalDecision(
      parsed as unknown as DecisionMessage,
    );
    this.writeJson(res, ok ? 200 : 404, { ok });
  }

  private async handleSuggestRegexAction(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    if (!this.isAuthorized(req)) {
      this.writeJson(res, 401, { error: "unauthorized" });
      return;
    }

    const body = (await readJsonBody(req)) as {
      subCommand?: string;
      fullCommand?: string;
    } | null;
    if (
      !body ||
      typeof body.subCommand !== "string" ||
      typeof body.fullCommand !== "string"
    ) {
      this.writeJson(res, 400, { error: "invalid_request" });
      return;
    }
    try {
      const pattern = await this.chatViewProvider.suggestRegexForCommand({
        subCommand: body.subCommand,
        fullCommand: body.fullCommand,
      });
      this.writeJson(res, 200, { ok: true, pattern });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.writeJson(res, 200, { ok: false, error: message });
    }
  }

  private async handlePolishPromptAction(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    if (!this.isAuthorized(req)) {
      this.writeJson(res, 401, { error: "unauthorized" });
      return;
    }

    const body = (await readJsonBody(req)) as { draft?: string } | null;
    if (!body || typeof body.draft !== "string" || !body.draft.trim()) {
      this.writeJson(res, 400, { error: "invalid_request" });
      return;
    }
    try {
      const polished = await this.chatViewProvider.polishPrompt({
        draft: body.draft,
      });
      this.writeJson(res, 200, { ok: true, polished });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.writeJson(res, 200, { ok: false, error: message });
    }
  }

  private async handleQuestionAction(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    if (!this.isAuthorized(req)) {
      this.writeJson(res, 401, { error: "unauthorized" });
      return;
    }

    const body = (await readJsonBody(req)) as {
      id?: string;
      answers?: Record<
        string,
        string | string[] | number | boolean | undefined
      >;
      notes?: Record<string, string>;
      attachments?: import("../core/capabilities/sessionControl.js").UserQuestionResponse["attachments"];
    };
    if (
      typeof body?.id !== "string" ||
      !body.answers ||
      typeof body.answers !== "object"
    ) {
      this.writeJson(res, 400, { error: "invalid_request" });
      return;
    }
    const ok = await this.chatViewProvider.submitBrowserQuestionResponse({
      id: body.id,
      answers: body.answers,
      notes: body.notes,
      attachments: body.attachments,
    });
    this.writeJson(res, ok ? 200 : 404, { ok });
  }

  private async handleFormElicitationAction(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    if (!this.isAuthorized(req)) {
      this.writeJson(res, 401, { error: "unauthorized" });
      return;
    }

    const body = (await readJsonBody(req)) as {
      id?: unknown;
      action?: unknown;
      values?: unknown;
    };
    if (
      typeof body?.id !== "string" ||
      !body.id.trim() ||
      (body.action !== "accept" && body.action !== "cancel") ||
      (body.action === "accept" && !isMcpElicitationValues(body.values))
    ) {
      this.writeJson(res, 400, { error: "invalid_request" });
      return;
    }

    const response: McpFormElicitationResponse =
      body.action === "accept"
        ? {
            id: body.id,
            action: "accept",
            values: body.values as McpElicitationValues,
          }
        : { id: body.id, action: "cancel" };
    const result = this.chatViewProvider.submitBrowserFormElicitation(response);
    if (result.ok) {
      this.writeJson(res, 200, { ok: true });
      return;
    }
    if (result.reason === "invalid_values") {
      this.writeJson(res, 400, { ok: false, errors: result.errors });
      return;
    }
    this.writeJson(res, 404, { ok: false });
  }

  private async handleUrlElicitationAction(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    if (!this.isAuthorized(req)) {
      this.writeJson(res, 401, { error: "unauthorized" });
      return;
    }

    const body = (await readJsonBody(req)) as {
      id?: string;
      action?: string;
    };
    if (
      typeof body?.id !== "string" ||
      (body.action !== "accept" &&
        body.action !== "cancel" &&
        body.action !== "decline")
    ) {
      this.writeJson(res, 400, { error: "invalid_request" });
      return;
    }
    const ok = this.chatViewProvider.submitBrowserUrlElicitation({
      id: body.id,
      action: body.action,
    });
    this.writeJson(res, ok ? 200 : 404, { ok });
  }

  private async handleQuestionProgressAction(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    if (!this.isAuthorized(req)) {
      this.writeJson(res, 401, { error: "unauthorized" });
      return;
    }

    const body = (await readJsonBody(req)) as {
      id?: string;
      step?: number;
      answers?: Record<
        string,
        string | string[] | number | boolean | undefined
      >;
      notes?: Record<string, string>;
      origin?: string;
    };
    if (
      typeof body?.id !== "string" ||
      typeof body.step !== "number" ||
      !body.answers ||
      typeof body.answers !== "object" ||
      !body.notes ||
      typeof body.notes !== "object" ||
      typeof body.origin !== "string"
    ) {
      this.writeJson(res, 400, { error: "invalid_request" });
      return;
    }
    const ok = this.chatViewProvider.publishBrowserQuestionProgress({
      id: body.id,
      step: body.step,
      answers: body.answers,
      notes: body.notes,
      origin: body.origin,
    });
    this.writeJson(res, ok ? 200 : 404, { ok });
  }

  private async handleSendAction(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    if (!this.isAuthorized(req)) {
      this.writeJson(res, 401, { error: "unauthorized" });
      return;
    }

    const body = (await readJsonBody(req)) as {
      text?: string;
      id?: string;
      mode?: string;
      sessionId?: string;
      thinkingEnabled?: boolean;
      reasoningEffort?: import("../agent/providers/types.js").ReasoningEffort;
      attachments?: string[];
      images?: Array<{ name?: string; mimeType?: string; base64?: string }>;
      documents?: Array<{ name?: string; mimeType?: string; base64?: string }>;
      displayText?: string;
      slashCommandLabel?: string;
      isSlashCommand?: boolean;
      projectId?: string;
      interject?: boolean;
    };

    const text = typeof body?.text === "string" ? body.text : "";
    const attachments = Array.isArray(body?.attachments)
      ? body.attachments
          .map((item) => (typeof item === "string" ? item.trim() : ""))
          .filter((item) => item.length > 0)
      : [];
    const images = Array.isArray(body?.images)
      ? body.images
          .map((item) => ({
            name: typeof item?.name === "string" ? item.name : "",
            mimeType: typeof item?.mimeType === "string" ? item.mimeType : "",
            base64: typeof item?.base64 === "string" ? item.base64 : "",
          }))
          .filter((item) => item.name && item.mimeType && item.base64)
      : [];
    const documents = Array.isArray(body?.documents)
      ? body.documents
          .map((item) => ({
            name: typeof item?.name === "string" ? item.name : "",
            mimeType: typeof item?.mimeType === "string" ? item.mimeType : "",
            base64: typeof item?.base64 === "string" ? item.base64 : "",
          }))
          .filter((item) => item.name && item.mimeType && item.base64)
      : [];

    if (
      !text.trim() &&
      attachments.length === 0 &&
      images.length === 0 &&
      documents.length === 0
    ) {
      this.writeJson(res, 400, { error: "invalid_request" });
      return;
    }

    const projectId = this.resolveRequestedProjectId(body.projectId, res);
    if (!projectId) return;
    if (
      body.sessionId &&
      !this.validateSessionProject(body.sessionId, projectId, res)
    ) {
      return;
    }

    const result = await this.chatViewProvider.submitBrowserSend({
      text,
      id: typeof body.id === "string" ? body.id : undefined,
      mode: body.mode,
      sessionId: body.sessionId,
      projectId,
      thinkingEnabled: body.thinkingEnabled,
      reasoningEffort: body.reasoningEffort,
      attachments,
      images,
      documents,
      displayText:
        typeof body.displayText === "string" ? body.displayText : undefined,
      slashCommandLabel:
        typeof body.slashCommandLabel === "string"
          ? body.slashCommandLabel
          : undefined,
      isSlashCommand: body.isSlashCommand === true,
      ...(body.interject === true ? { interject: true } : {}),
    });
    this.writeJson(res, result.ok ? 200 : 400, result);
  }

  private normalizeQueueMessageActionBody(
    body: {
      sessionId?: unknown;
      queueId?: unknown;
      text?: unknown;
      displayText?: unknown;
      isSlashCommand?: unknown;
      slashCommandLabel?: unknown;
      attachments?: unknown;
      images?: unknown;
      documents?: unknown;
      projectId?: unknown;
    } | null,
  ): {
    sessionId: string;
    projectId?: string;
    queueId: string;
    text: string;
    displayText?: string;
    isSlashCommand?: boolean;
    slashCommandLabel?: string;
    attachments: string[];
    images: Array<{ name: string; mimeType: string; base64: string }>;
    documents: Array<{ name: string; mimeType: string; base64: string }>;
  } | null {
    const sessionId =
      typeof body?.sessionId === "string" ? body.sessionId.trim() : "";
    const queueId =
      typeof body?.queueId === "string" ? body.queueId.trim() : "";
    const text = typeof body?.text === "string" ? body.text : "";
    const attachments = Array.isArray(body?.attachments)
      ? body.attachments
          .map((item) => (typeof item === "string" ? item.trim() : ""))
          .filter((item) => item.length > 0)
      : [];
    const images = Array.isArray(body?.images)
      ? body.images
          .map((item) => {
            const record =
              item && typeof item === "object"
                ? (item as Record<string, unknown>)
                : {};
            return {
              name: typeof record.name === "string" ? record.name : "",
              mimeType:
                typeof record.mimeType === "string" ? record.mimeType : "",
              base64: typeof record.base64 === "string" ? record.base64 : "",
            };
          })
          .filter((item) => item.name && item.mimeType && item.base64)
      : [];
    const documents = Array.isArray(body?.documents)
      ? body.documents
          .map((item) => {
            const record =
              item && typeof item === "object"
                ? (item as Record<string, unknown>)
                : {};
            return {
              name: typeof record.name === "string" ? record.name : "",
              mimeType:
                typeof record.mimeType === "string" ? record.mimeType : "",
              base64: typeof record.base64 === "string" ? record.base64 : "",
            };
          })
          .filter((item) => item.name && item.mimeType && item.base64)
      : [];

    if (
      !sessionId ||
      !queueId ||
      (!text.trim() &&
        attachments.length === 0 &&
        images.length === 0 &&
        documents.length === 0)
    ) {
      return null;
    }

    return {
      sessionId,
      projectId:
        typeof body?.projectId === "string" ? body.projectId.trim() : undefined,
      queueId,
      text,
      displayText:
        typeof body?.displayText === "string" ? body.displayText : undefined,
      isSlashCommand: body?.isSlashCommand === true,
      slashCommandLabel:
        typeof body?.slashCommandLabel === "string"
          ? body.slashCommandLabel
          : undefined,
      attachments,
      images,
      documents,
    };
  }

  private async handleQueueSteerAction(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    if (!this.isAuthorized(req)) {
      this.writeJson(res, 401, { error: "unauthorized" });
      return;
    }

    const body = (await readJsonBody(req)) as {
      sessionId?: unknown;
      projectId?: unknown;
      queueId?: unknown;
      text?: unknown;
      displayText?: unknown;
      isSlashCommand?: unknown;
      slashCommandLabel?: unknown;
      attachments?: unknown;
      images?: unknown;
      documents?: unknown;
    } | null;
    const input = this.normalizeQueueMessageActionBody(body);
    if (!input) {
      this.writeJson(res, 400, { error: "invalid_request" });
      return;
    }
    const projectId = this.resolveRequestedProjectId(input.projectId, res);
    if (
      !projectId ||
      !this.validateSessionProject(input.sessionId, projectId, res)
    ) {
      return;
    }

    const result = await this.chatViewProvider.submitBrowserSteerQueuedMessage({
      ...input,
      projectId,
    });
    this.writeJson(
      res,
      result.ok ? 200 : 404,
      result.ok ? { ...result, snapshot: this.getSnapshot() } : result,
    );
  }

  private async handleQueueInterjectAction(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    if (!this.isAuthorized(req)) {
      this.writeJson(res, 401, { error: "unauthorized" });
      return;
    }

    const body = (await readJsonBody(req)) as {
      sessionId?: unknown;
      projectId?: unknown;
      queueId?: unknown;
      text?: unknown;
      displayText?: unknown;
      isSlashCommand?: unknown;
      slashCommandLabel?: unknown;
      attachments?: unknown;
      images?: unknown;
      documents?: unknown;
    } | null;
    const input = this.normalizeQueueMessageActionBody(body);
    if (!input) {
      this.writeJson(res, 400, { error: "invalid_request" });
      return;
    }
    const projectId = this.resolveRequestedProjectId(input.projectId, res);
    if (
      !projectId ||
      !this.validateSessionProject(input.sessionId, projectId, res)
    ) {
      return;
    }

    const result = this.chatViewProvider.submitBrowserInterjectQueuedMessage({
      ...input,
      projectId,
    });
    this.writeJson(
      res,
      result.ok ? 200 : 409,
      result.ok ? { ...result, snapshot: this.getSnapshot() } : result,
    );
  }

  private async handleModeAction(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    if (!this.isAuthorized(req)) {
      this.writeJson(res, 401, { error: "unauthorized" });
      return;
    }

    const body = (await readJsonBody(req)) as {
      mode?: string;
      reason?: string;
      projectId?: unknown;
      sessionId?: unknown;
    };
    if (typeof body?.mode !== "string" || !body.mode.trim()) {
      this.writeJson(res, 400, { error: "invalid_request" });
      return;
    }

    const projectId = this.resolveRequestedProjectId(body.projectId, res);
    if (!projectId) return;
    const foregroundSessionId =
      this.gatewayService.getSerializableSessionState().foreground?.sessionId;
    const sessionId =
      typeof body.sessionId === "string" && body.sessionId.trim()
        ? body.sessionId.trim()
        : foregroundSessionId;
    if (!sessionId || !this.validateSessionProject(sessionId, projectId, res)) {
      return;
    }

    const result = await this.chatViewProvider.submitBrowserModeSwitch(
      body.mode,
      projectId,
    );
    this.writeJson(res, result.approved ? 200 : 409, result);
  }

  private async handleSlashCommandsRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    if (!this.isAuthorized(req)) {
      this.writeJson(res, 401, { error: "unauthorized" });
      return;
    }

    const parsedUrl = new URL(
      req.url ?? "/api/slash-commands",
      "http://127.0.0.1",
    );
    const projectId = this.resolveRequestedProjectId(
      parsedUrl.searchParams.get("projectId"),
      res,
    );
    if (!projectId) return;
    const commands =
      await this.chatViewProvider.getBrowserSlashCommands(projectId);
    this.writeJson(res, 200, { commands });
  }

  private async handleSearchFilesRequest(
    req: http.IncomingMessage,
    url: string,
    res: http.ServerResponse,
  ): Promise<void> {
    if (!this.isAuthorized(req)) {
      this.writeJson(res, 401, { error: "unauthorized" });
      return;
    }

    const parsedUrl = new URL(url, "http://127.0.0.1");
    const query = parsedUrl.searchParams.get("query")?.trim();
    if (!query) {
      this.writeJson(res, 400, { error: "invalid_request" });
      return;
    }

    const projectId = this.resolveRequestedProjectId(
      parsedUrl.searchParams.get("projectId"),
      res,
    );
    if (!projectId) return;
    const files = await this.chatViewProvider.searchBrowserFiles(
      query,
      projectId,
    );
    this.writeJson(res, 200, { files });
  }

  private async handleModesRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    if (!this.isAuthorized(req)) {
      this.writeJson(res, 401, { error: "unauthorized" });
      return;
    }

    const parsedUrl = new URL(req.url ?? "/api/modes", "http://127.0.0.1");
    const projectId = this.resolveRequestedProjectId(
      parsedUrl.searchParams.get("projectId"),
      res,
    );
    if (!projectId) return;
    const modes = await this.chatViewProvider.getBrowserModes(projectId);
    this.writeJson(res, 200, { modes });
  }

  private async handleModelsRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    if (!this.isAuthorized(req)) {
      this.writeJson(res, 401, { error: "unauthorized" });
      return;
    }

    const models = await this.chatViewProvider.getBrowserModels();
    this.writeJson(res, 200, { models });
  }

  private async handleSessionsRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    if (!this.isAuthorized(req)) {
      this.writeJson(res, 401, { error: "unauthorized" });
      return;
    }
    const result = this.chatViewProvider.submitBrowserListSessions();
    this.writeJson(res, 200, { sessions: result.sessions });
  }

  private async handleModelAction(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    if (!this.isAuthorized(req)) {
      this.writeJson(res, 401, { error: "unauthorized" });
      return;
    }

    const body = (await readJsonBody(req)) as {
      model?: string;
    };
    if (typeof body?.model !== "string" || !body.model.trim()) {
      this.writeJson(res, 400, { error: "invalid_request" });
      return;
    }

    const result = await this.chatViewProvider.submitBrowserSetModel(
      body.model,
    );
    this.writeJson(
      res,
      result.ok ? 200 : 400,
      result.ok ? { ...result, snapshot: this.getSnapshot() } : result,
    );
  }

  private async handleWriteApprovalAction(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    if (!this.isAuthorized(req)) {
      this.writeJson(res, 401, { error: "unauthorized" });
      return;
    }

    const body = (await readJsonBody(req)) as {
      mode?: string;
    };
    if (typeof body?.mode !== "string" || !body.mode.trim()) {
      this.writeJson(res, 400, { error: "invalid_request" });
      return;
    }

    const result = this.chatViewProvider.submitBrowserSetWriteApproval(
      body.mode,
    );
    this.writeJson(res, result.ok ? 200 : 400, result);
  }

  private async handleCommandApprovalPolicyAction(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    if (!this.isAuthorized(req)) {
      this.writeJson(res, 401, { error: "unauthorized" });
      return;
    }

    const body = (await readJsonBody(req)) as { policy?: unknown };
    if (!isCommandApprovalPolicy(body?.policy)) {
      this.writeJson(res, 400, { error: "invalid_request" });
      return;
    }
    const result = this.chatViewProvider.submitBrowserSetCommandApprovalPolicy(
      body.policy,
    );
    this.writeJson(
      res,
      result.ok ? 200 : 400,
      result.ok ? result : { error: "invalid_request" },
    );
  }

  private async handleThinkingAction(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    if (!this.isAuthorized(req)) {
      this.writeJson(res, 401, { error: "unauthorized" });
      return;
    }

    const body = (await readJsonBody(req)) as {
      enabled?: boolean;
      effort?: import("../agent/providers/types.js").ReasoningEffort;
    };
    if (typeof body?.effort === "string" && body.effort.trim()) {
      if (!isCoreReasoningEffort(body.effort)) {
        this.writeJson(res, 400, { error: "invalid_request" });
        return;
      }
      const result =
        await this.chatViewProvider.submitBrowserSetReasoningEffort(
          body.effort,
        );
      this.writeJson(res, result.ok ? 200 : 400, result);
      return;
    }
    if (typeof body?.enabled !== "boolean") {
      this.writeJson(res, 400, { error: "invalid_request" });
      return;
    }

    const result = await this.chatViewProvider.submitBrowserSetThinkingEnabled(
      body.enabled,
    );
    this.writeJson(res, result.ok ? 200 : 400, result);
  }

  private async handleAttachFileAction(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    if (!this.isAuthorized(req)) {
      this.writeJson(res, 401, { error: "unauthorized" });
      return;
    }

    const body = (await readJsonBody(req)) as { projectId?: unknown };
    const projectId = this.resolveRequestedProjectId(body?.projectId, res);
    if (!projectId) return;
    const result =
      await this.chatViewProvider.submitBrowserAttachFile(projectId);
    this.writeJson(res, 200, result);
  }

  private async handleOpenFileAction(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    if (!this.isAuthorized(req)) {
      this.writeJson(res, 401, { error: "unauthorized" });
      return;
    }

    const body = (await readJsonBody(req)) as {
      path?: unknown;
      line?: unknown;
      projectId?: unknown;
    };
    if (
      typeof body?.path !== "string" ||
      !body.path.trim() ||
      (body.line !== undefined &&
        (typeof body.line !== "number" ||
          !Number.isInteger(body.line) ||
          body.line < 1))
    ) {
      this.writeJson(res, 400, { error: "invalid_request" });
      return;
    }
    const projectId = this.resolveRequestedProjectId(body.projectId, res);
    if (!projectId) return;
    const result = await this.chatViewProvider.submitBrowserOpenFile(
      body.path,
      body.line === undefined ? undefined : Number(body.line),
      projectId,
    );
    this.writeJson(res, result.ok ? 200 : 404, result);
  }

  private async handleDefaultProjectAction(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    if (!this.isAuthorized(req)) {
      this.writeJson(res, 401, { error: "unauthorized" });
      return;
    }

    const body = (await readJsonBody(req)) as { projectId?: unknown };
    const projectId = this.resolveRequestedProjectId(body?.projectId, res, {
      requireExplicit: true,
    });
    if (!projectId) return;
    const ok = this.gatewayService.setDefaultProject(projectId);
    this.writeJson(
      res,
      ok ? 200 : 409,
      ok
        ? { ok: true, projectId, snapshot: this.getSnapshot() }
        : {
            error: "project_state_mismatch",
            reason: "project_unavailable",
            projectId,
            refresh: true,
          },
    );
  }

  private resolveRequestedProjectId(
    value: unknown,
    res: http.ServerResponse,
    options: { requireExplicit?: boolean } = {},
  ): string | undefined {
    const projects = this.gatewayService.getSerializableSessionState().projects;
    const requestedProjectId =
      typeof value === "string" && value.trim() ? value.trim() : undefined;
    const projectId =
      requestedProjectId ??
      (!options.requireExplicit && projects.length === 1
        ? projects[0].projectId
        : undefined);
    if (!projectId) {
      this.writeJson(res, 409, {
        error: "project_state_mismatch",
        reason: "project_required",
        refresh: true,
      });
      return undefined;
    }

    const availability = this.gatewayService.getProjectAvailability(projectId);
    if (availability !== "available") {
      this.writeJson(res, 409, {
        error: "project_state_mismatch",
        reason:
          availability === "unknown"
            ? "project_not_found"
            : "project_unavailable",
        projectId,
        refresh: true,
      });
      return undefined;
    }
    return projectId;
  }

  private validateSessionProject(
    sessionId: string,
    projectId: string,
    res: http.ServerResponse,
  ): boolean {
    const sessionProjectId = this.gatewayService.getSessionProjectId(sessionId);
    if (sessionProjectId === projectId) return true;
    this.writeJson(res, 409, {
      error: "project_state_mismatch",
      reason: sessionProjectId
        ? "session_project_mismatch"
        : "session_not_found",
      sessionId,
      projectId,
      ...(sessionProjectId ? { sessionProjectId } : {}),
      refresh: true,
    });
    return false;
  }

  private validateSessionLoadProject(
    sessionId: string,
    value: unknown,
    res: http.ServerResponse,
  ): boolean {
    const sessionProjectId = this.gatewayService.getSessionProjectId(sessionId);
    if (!sessionProjectId) {
      this.writeJson(res, 409, {
        error: "project_state_mismatch",
        reason: "session_not_found",
        sessionId,
        refresh: true,
      });
      return false;
    }

    const requestedProjectId =
      typeof value === "string" && value.trim() ? value.trim() : undefined;
    const projectCount =
      this.gatewayService.getSerializableSessionState().projects.length;
    if (!requestedProjectId && projectCount > 1) {
      this.writeJson(res, 409, {
        error: "project_state_mismatch",
        reason: "project_required",
        sessionId,
        refresh: true,
      });
      return false;
    }
    if (requestedProjectId && requestedProjectId !== sessionProjectId) {
      this.writeJson(res, 409, {
        error: "project_state_mismatch",
        reason: "session_project_mismatch",
        sessionId,
        projectId: requestedProjectId,
        sessionProjectId,
        refresh: true,
      });
      return false;
    }
    return true;
  }

  private async handleSessionNewAction(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    if (!this.isAuthorized(req)) {
      this.writeJson(res, 401, { error: "unauthorized" });
      return;
    }

    const body = (await readJsonBody(req)) as {
      mode?: string;
      projectId?: unknown;
    };
    const projectId = this.resolveRequestedProjectId(body?.projectId, res);
    if (!projectId) return;
    const result = await this.chatViewProvider.submitBrowserNewSession(
      body?.mode,
      projectId,
    );
    this.writeJson(
      res,
      result.ok ? 200 : 400,
      result.ok ? { ...result, snapshot: this.getSnapshot() } : result,
    );
  }

  private async handleSessionLoadAction(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    if (!this.isAuthorized(req)) {
      this.writeJson(res, 401, { error: "unauthorized" });
      return;
    }

    const body = (await readJsonBody(req)) as {
      sessionId?: string;
      projectId?: unknown;
    };
    if (typeof body?.sessionId !== "string" || !body.sessionId.trim()) {
      this.writeJson(res, 400, { error: "invalid_request" });
      return;
    }

    if (!this.validateSessionLoadProject(body.sessionId, body.projectId, res)) {
      return;
    }

    const result = await this.chatViewProvider.submitBrowserLoadSession(
      body.sessionId,
    );
    this.writeJson(res, result.ok ? 200 : 404, result);
  }

  private async handleSessionDeleteAction(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    if (!this.isAuthorized(req)) {
      this.writeJson(res, 401, { error: "unauthorized" });
      return;
    }

    const body = (await readJsonBody(req)) as { sessionId?: string };
    if (typeof body?.sessionId !== "string" || !body.sessionId.trim()) {
      this.writeJson(res, 400, { error: "invalid_request" });
      return;
    }

    const result = await this.chatViewProvider.submitBrowserDeleteSession(
      body.sessionId,
    );
    this.writeJson(res, result.ok ? 200 : 404, result);
  }

  private async handleSessionRenameAction(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    if (!this.isAuthorized(req)) {
      this.writeJson(res, 401, { error: "unauthorized" });
      return;
    }

    const body = (await readJsonBody(req)) as {
      sessionId?: string;
      title?: string;
    };
    if (
      typeof body?.sessionId !== "string" ||
      !body.sessionId.trim() ||
      typeof body?.title !== "string" ||
      !body.title.trim()
    ) {
      this.writeJson(res, 400, { error: "invalid_request" });
      return;
    }

    const result = await this.chatViewProvider.submitBrowserRenameSession(
      body.sessionId,
      body.title,
    );
    this.writeJson(res, result.ok ? 200 : 404, result);
  }

  private async handleSessionCopyFirstPromptAction(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    if (!this.isAuthorized(req)) {
      this.writeJson(res, 401, { error: "unauthorized" });
      return;
    }

    const body = (await readJsonBody(req)) as { sessionId?: string };
    if (typeof body?.sessionId !== "string" || !body.sessionId.trim()) {
      this.writeJson(res, 400, { error: "invalid_request" });
      return;
    }

    const result = this.chatViewProvider.submitBrowserCopyFirstPrompt(
      body.sessionId,
    );
    this.writeJson(res, result.ok ? 200 : 404, result);
  }

  private async handleDebugRefreshAction(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    if (!this.isAuthorized(req)) {
      this.writeJson(res, 401, { error: "unauthorized" });
      return;
    }
    const result = await this.chatViewProvider.submitBrowserRefreshDebugInfo();
    this.writeJson(res, result.ok ? 200 : 500, result);
  }

  private async handleAskAgentWebPolicy(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    if (!this.isAuthorized(req)) {
      this.writeJson(res, 401, { error: "unauthorized" });
      return;
    }
    this.writeJson(
      res,
      200,
      this.chatViewProvider.submitBrowserAskAgentWebPolicy(),
    );
  }

  private async handleAskAgentMcpTools(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    if (!this.isAuthorized(req)) {
      this.writeJson(res, 401, { error: "unauthorized" });
      return;
    }
    this.writeJson(
      res,
      200,
      this.chatViewProvider.submitBrowserAskAgentMcpTools(),
    );
  }

  private async handleAskAgentMcpStatus(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    if (!this.isAuthorized(req)) {
      this.writeJson(res, 401, { error: "unauthorized" });
      return;
    }
    this.writeJson(
      res,
      200,
      this.chatViewProvider.submitBrowserAskAgentMcpStatus(),
    );
  }

  private async handleAskAgentMcpRefresh(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    if (!this.isAuthorized(req)) {
      this.writeJson(res, 401, { error: "unauthorized" });
      return;
    }
    const result =
      await this.chatViewProvider.submitBrowserAskAgentMcpRefresh();
    this.writeJson(res, result.ok ? 200 : 500, result);
  }

  private async handleAskAgentMcpTool(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    if (!this.isAuthorized(req)) {
      this.writeJson(res, 401, { error: "unauthorized" });
      return;
    }
    const body = (await readJsonBody(req)) as {
      name?: string;
      input?: Record<string, unknown>;
      sessionId?: string;
    };
    if (typeof body?.name !== "string" || !body.name.trim()) {
      this.writeJson(res, 400, { error: "invalid_request" });
      return;
    }
    const controller = new AbortController();
    req.on("aborted", () => controller.abort());
    res.on("close", () => controller.abort());
    const result = await this.chatViewProvider.submitBrowserAskAgentMcpTool({
      name: body.name,
      input:
        body.input &&
        typeof body.input === "object" &&
        !Array.isArray(body.input)
          ? body.input
          : {},
      sessionId: body.sessionId,
      signal: controller.signal,
    });
    this.writeJson(res, result.ok ? 200 : 400, result);
  }

  private parseMcpProfile(value: unknown): McpManagerProfile | null {
    return value === "main" || value === "ask-agent" ? value : null;
  }

  private parseMcpScope(value: unknown): McpManagerScope | null {
    return value === "global" ||
      value === "project" ||
      value === "ask-agent-global"
      ? value
      : null;
  }

  private async handleMcpConfigSnapshot(
    req: http.IncomingMessage,
    url: string,
    res: http.ServerResponse,
  ): Promise<void> {
    if (!this.isAuthorized(req)) {
      this.writeJson(res, 401, { error: "unauthorized" });
      return;
    }
    const requestUrl = new URL(url, "http://agentlink.local");
    const profile = this.parseMcpProfile(
      requestUrl.searchParams.get("profile") ?? "main",
    );
    const projectId = requestUrl.searchParams.get("projectId") ?? undefined;
    if (!profile) {
      this.writeJson(res, 400, { error: "invalid_request" });
      return;
    }
    const result =
      profile === "main"
        ? await this.chatViewProvider.submitBrowserMcpConfigSnapshot(
            profile,
            projectId,
          )
        : await this.chatViewProvider.submitBrowserMcpConfigSnapshot(profile);
    this.writeJson(res, 200, result);
  }

  private async handleMcpConfigServer(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    requireHelperTrust = false,
  ): Promise<void> {
    if (!this.isAuthorized(req)) {
      this.writeJson(res, 401, { error: "unauthorized" });
      return;
    }
    const body = (await readJsonBody(req)) as {
      profile?: unknown;
      scope?: unknown;
      server?: unknown;
      operationId?: unknown;
      expectedRevision?: unknown;
      operations?: unknown;
    } | null;
    const profile = this.parseMcpProfile(body?.profile);
    const scope = this.parseMcpScope(body?.scope);
    const isBatch = Array.isArray(body?.operations);
    if (
      !profile ||
      !scope ||
      (!isBatch && (!body?.server || typeof body.server !== "object")) ||
      (isBatch &&
        (typeof body?.operationId !== "string" ||
          typeof body?.expectedRevision !== "string"))
    ) {
      this.writeJson(res, 400, { error: "invalid_request" });
      return;
    }
    if (profile !== "ask-agent") {
      this.writeJson(res, 403, { error: "main_profile_read_only_in_browser" });
      return;
    }
    if (requireHelperTrust) {
      const origin = verifyBrowserGatewayHelperTrust(
        req.headers,
        this.getHelperSharedSecret(),
      );
      if (!origin) {
        this.writeJson(res, 403, { error: "helper_trust_required" });
        return;
      }
      const operations = isBatch
        ? (body.operations as Array<{
            kind?: unknown;
            server?: {
              type?: unknown;
              env?: unknown;
              headers?: unknown;
            };
          }>)
        : undefined;
      if (
        origin === "non-loopback" &&
        operations?.some((operation) => operation.kind === "remove")
      ) {
        this.writeJson(res, 403, {
          error: "browser_local_process_requires_loopback",
        });
        return;
      }
      const servers = operations
        ? operations
            .filter((operation) => operation.kind === "upsert")
            .map((operation) => operation.server)
        : [
            body.server as {
              type?: unknown;
              env?: unknown;
              headers?: unknown;
            },
          ];
      if (
        origin === "non-loopback" &&
        servers.some(
          (server) =>
            server?.type === undefined ||
            server.type === "stdio" ||
            hasBrowserGatewayMcpSecretWrite(server),
        )
      ) {
        this.writeJson(res, 403, {
          error: servers.some(hasBrowserGatewayMcpSecretWrite)
            ? "browser_secret_write_requires_loopback"
            : "browser_local_process_requires_loopback",
        });
        return;
      }
    }
    const result = isBatch
      ? await this.chatViewProvider.submitMcpConfigMutation(
          body as McpConfigBatchMutation,
        )
      : await this.chatViewProvider.submitBrowserMcpConfigServer({
          profile,
          scope,
          server: body.server as McpManagerServerDraft,
          expectedRevision:
            typeof body.expectedRevision === "string"
              ? body.expectedRevision
              : undefined,
          operationId:
            typeof body.operationId === "string" ? body.operationId : undefined,
        });
    this.writeJson(res, result.ok ? 200 : 400, result);
  }

  private async handleMcpConfigRemove(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    requireHelperTrust = false,
  ): Promise<void> {
    if (!this.isAuthorized(req)) {
      this.writeJson(res, 401, { error: "unauthorized" });
      return;
    }
    const body = (await readJsonBody(req)) as {
      profile?: unknown;
      scope?: unknown;
      serverName?: unknown;
    } | null;
    const profile = this.parseMcpProfile(body?.profile);
    const scope = this.parseMcpScope(body?.scope);
    if (!profile || !scope || typeof body?.serverName !== "string") {
      this.writeJson(res, 400, { error: "invalid_request" });
      return;
    }
    if (profile !== "ask-agent") {
      this.writeJson(res, 403, { error: "main_profile_read_only_in_browser" });
      return;
    }
    if (requireHelperTrust) {
      const origin = verifyBrowserGatewayHelperTrust(
        req.headers,
        this.getHelperSharedSecret(),
      );
      if (!origin) {
        this.writeJson(res, 403, { error: "helper_trust_required" });
        return;
      }
      if (origin === "non-loopback") {
        this.writeJson(res, 403, {
          error: "browser_local_process_requires_loopback",
        });
        return;
      }
    }
    const result = await this.chatViewProvider.submitBrowserMcpConfigRemove({
      profile,
      scope,
      serverName: body.serverName,
    });
    this.writeJson(res, result.ok ? 200 : 400, result);
  }

  private handleBrowserMcpConfigUnavailable(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    if (!this.isAuthorized(req)) {
      this.writeJson(res, 401, { error: "unauthorized" });
      return;
    }
    this.writeJson(res, 403, { error: "browser_mcp_config_unavailable" });
  }

  private async handleMcpAction(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    if (!this.isAuthorized(req)) {
      this.writeJson(res, 401, { error: "unauthorized" });
      return;
    }

    const body = (await readJsonBody(req)) as {
      serverName?: string;
      action?: "disable" | "reconnect" | "reauthenticate";
      projectId?: string;
    };
    if (
      typeof body?.serverName !== "string" ||
      !body.serverName.trim() ||
      (body.action !== "disable" &&
        body.action !== "reconnect" &&
        body.action !== "reauthenticate")
    ) {
      this.writeJson(res, 400, { error: "invalid_request" });
      return;
    }

    if (body.action === "disable") {
      this.writeJson(res, 403, { error: "main_profile_read_only_in_browser" });
      return;
    }

    const result = body.projectId
      ? await this.chatViewProvider.submitBrowserMcpAction(
          body.serverName,
          body.action,
          body.projectId,
        )
      : await this.chatViewProvider.submitBrowserMcpAction(
          body.serverName,
          body.action,
        );
    this.writeJson(res, result.ok ? 200 : 400, result);
  }

  private async handleStopAction(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    if (!this.isAuthorized(req)) {
      this.writeJson(res, 401, { error: "unauthorized" });
      return;
    }

    const body = (await readJsonBody(req)) as {
      sessionId?: string;
    };
    if (typeof body?.sessionId !== "string" || !body.sessionId.trim()) {
      this.writeJson(res, 400, { error: "invalid_request" });
      return;
    }

    const result = this.chatViewProvider.submitBrowserStop(body.sessionId);
    this.writeJson(res, result.ok ? 200 : 404, result);
  }

  private async handleBackgroundStopAction(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    if (!this.isAuthorized(req)) {
      this.writeJson(res, 401, { error: "unauthorized" });
      return;
    }

    const body = (await readJsonBody(req)) as {
      sessionId?: string;
    };
    if (typeof body?.sessionId !== "string" || !body.sessionId.trim()) {
      this.writeJson(res, 400, { error: "invalid_request" });
      return;
    }

    const result = this.chatViewProvider.submitBrowserStopBackground(
      body.sessionId,
    );
    this.writeJson(res, result.ok ? 200 : 404, result);
  }

  private async handleBackgroundAction(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    if (!this.isAuthorized(req)) {
      this.writeJson(res, 401, { error: "unauthorized" });
      return;
    }
    const body = (await readJsonBody(req)) as {
      action?:
        | "steer"
        | "detach"
        | "retry"
        | "archive"
        | "pause"
        | "resume"
        | "mark_read";
      sessionId?: string;
      message?: string;
    };
    if (!body.action || typeof body.sessionId !== "string") {
      this.writeJson(res, 400, { error: "invalid_request" });
      return;
    }
    const result = await this.chatViewProvider.submitBrowserBackgroundAction({
      action: body.action,
      sessionId: body.sessionId,
      message: body.message,
    });
    this.writeJson(res, result.ok ? 200 : 400, result);
  }

  private async handleBackgroundOpenTranscriptAction(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    if (!this.isAuthorized(req)) {
      this.writeJson(res, 401, { error: "unauthorized" });
      return;
    }

    const body = (await readJsonBody(req)) as {
      sessionId?: string;
    };
    if (typeof body?.sessionId !== "string" || !body.sessionId.trim()) {
      this.writeJson(res, 400, { error: "invalid_request" });
      return;
    }

    const result = this.chatViewProvider.getBrowserBgTranscript(body.sessionId);
    this.writeJson(res, result.ok ? 200 : 404, result);
  }

  private isAuthorized(req: http.IncomingMessage): boolean {
    const auth = req.headers.authorization;
    return auth === `Bearer ${this.authToken}`;
  }

  private writeJson(
    res: http.ServerResponse,
    status: number,
    body: unknown,
  ): void {
    res.writeHead(status, {
      "Content-Type": "application/json",
    });
    res.end(JSON.stringify(body));
  }
}

function isMcpElicitationValues(value: unknown): value is McpElicitationValues {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).every(
    (entry) =>
      typeof entry === "string" ||
      typeof entry === "boolean" ||
      (typeof entry === "number" && Number.isFinite(entry)) ||
      (Array.isArray(entry) && entry.every((item) => typeof item === "string")),
  );
}
