import * as http from "http";
import type * as vscode from "vscode";

import {
  clearBrowserGatewayDiscovery,
  writeBrowserGatewayDiscovery,
} from "./browserGatewayDiscovery.js";
import {
  listHealthyBrowserGatewayInstances,
  removeBrowserGatewayInstance,
  upsertBrowserGatewayInstance,
} from "./browserGatewayRegistry.js";

import type { BrowserGatewayInstanceStatusSummary } from "./protocol.js";
import type { BrowserGatewayService } from "./BrowserGatewayService.js";
import type { ChatViewProvider } from "../agent/ChatViewProvider.js";
import type { DecisionMessage } from "../approvals/webview/types.js";
import { diffSnapshotHub } from "./DiffSnapshotHub.js";

export type BrowserGatewaySnapshot = ReturnType<
  BrowserGatewayService["getSerializableSnapshotState"]
>;

export type BrowserGatewayInstanceListItem = Omit<
  Awaited<ReturnType<typeof listHealthyBrowserGatewayInstances>>[number],
  "authToken"
> & {
  status?: BrowserGatewayInstanceStatusSummary;
};

const SSE_KEEPALIVE_INTERVAL_MS = 15_000;

export class BrowserGatewayServer implements vscode.Disposable {
  private server: http.Server | null = null;
  private port: number | null = null;
  private readonly sseClients = new Set<http.ServerResponse>();
  private readonly sseKeepaliveTimers = new Map<
    http.ServerResponse,
    NodeJS.Timeout
  >();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly gatewayService: BrowserGatewayService,
    private readonly chatViewProvider: ChatViewProvider,
    private readonly authToken: string,
    private readonly instanceId: string,
    private readonly workspaceName: string,
    private readonly workspacePath: string,
    private readonly log: (message: string) => void,
  ) {}

  async start(port = 0): Promise<number> {
    if (this.server && this.port !== null) {
      return this.port;
    }

    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res);
    });
    this.server.timeout = 0;
    this.server.keepAliveTimeout = 0;
    this.server.headersTimeout = 0;

    this.disposables.push(
      this.gatewayService.onDidChange(() => {
        this.broadcast(this.getSnapshot());
      }),
    );

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
    await writeBrowserGatewayDiscovery({
      pid: process.pid,
      port: this.port,
      url,
      protocolVersion: 1,
      startedAt,
      authToken: this.authToken,
    });
    await upsertBrowserGatewayInstance({
      instanceId: this.instanceId,
      workspaceName: this.workspaceName,
      workspacePath: this.workspacePath,
      pid: process.pid,
      port: this.port,
      url,
      protocolVersion: 1,
      startedAt,
      authToken: this.authToken,
    });
    this.log(`[browser-gateway] listening on ${url}`);
    return this.port;
  }

  getUrl(): string | null {
    if (this.port === null) return null;
    return `http://127.0.0.1:${this.port}`;
  }

  getSnapshot(): BrowserGatewaySnapshot {
    return this.gatewayService.getSerializableSnapshotState();
  }

  async stop(): Promise<void> {
    await clearBrowserGatewayDiscovery();
    await removeBrowserGatewayInstance(this.instanceId);
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables.length = 0;

    for (const client of this.sseClients) {
      this.removeSseClient(client);
    }
    this.sseClients.clear();

    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
      });
      this.server = null;
    }
    this.port = null;
  }

  dispose(): void {
    void this.stop();
  }

  private handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    const method = req.method ?? "GET";
    const url = req.url ?? "/";

    if (method === "GET" && url === "/health") {
      this.writeJson(res, 200, { status: "ok" });
      return;
    }

    if (method === "GET" && url === "/api/ui-state") {
      this.writeJson(res, 200, this.getSnapshot());
      return;
    }

    if (method === "GET" && url === "/api/instance-status") {
      if (!this.isAuthorized(req)) {
        this.writeJson(res, 401, { error: "unauthorized" });
        return;
      }
      this.writeJson(res, 200, this.gatewayService.getInstanceStatusSummary());
      return;
    }

    if (method === "GET" && url === "/api/instances") {
      void this.handleInstancesRequest(res);
      return;
    }

    if (method === "GET" && url.startsWith("/api/diff/")) {
      this.handleDiffDetailRequest(url, res);
      return;
    }

    if (method === "GET" && url === "/events") {
      this.handleSse(req, res);
      return;
    }

    if (method === "POST" && url === "/api/approval") {
      void this.handleApprovalAction(req, res).catch((err) => {
        this.log(`[browser-gateway] approval action failed: ${err}`);
        if (!res.headersSent) {
          this.writeJson(
            res,
            String(err) === "Error: invalid_json" ? 400 : 500,
            {
              error:
                String(err) === "Error: invalid_json"
                  ? "invalid_json"
                  : "internal_error",
            },
          );
        }
      });
      return;
    }

    if (method === "POST" && url === "/api/suggest-regex") {
      void this.handleSuggestRegexAction(req, res).catch((err: unknown) => {
        this.log(`[browser-gateway] suggest-regex action failed: ${err}`);
        if (!res.headersSent) {
          this.writeJson(
            res,
            String(err) === "Error: invalid_json" ? 400 : 500,
            {
              error:
                String(err) === "Error: invalid_json"
                  ? "invalid_json"
                  : "internal_error",
            },
          );
        }
      });
      return;
    }

    if (method === "POST" && url === "/api/question") {
      void this.handleQuestionAction(req, res).catch((err) => {
        this.log(`[browser-gateway] question action failed: ${err}`);
        if (!res.headersSent) {
          this.writeJson(
            res,
            String(err) === "Error: invalid_json" ? 400 : 500,
            {
              error:
                String(err) === "Error: invalid_json"
                  ? "invalid_json"
                  : "internal_error",
            },
          );
        }
      });
      return;
    }

    if (method === "POST" && url === "/api/question-progress") {
      void this.handleQuestionProgressAction(req, res).catch((err: unknown) => {
        this.log(`[browser-gateway] question-progress action failed: ${err}`);
        if (!res.headersSent) {
          this.writeJson(
            res,
            String(err) === "Error: invalid_json" ? 400 : 500,
            {
              error:
                String(err) === "Error: invalid_json"
                  ? "invalid_json"
                  : "internal_error",
            },
          );
        }
      });
      return;
    }

    if (method === "POST" && url === "/api/send") {
      void this.handleSendAction(req, res).catch((err) => {
        this.log(`[browser-gateway] send action failed: ${err}`);
        if (!res.headersSent) {
          this.writeJson(
            res,
            String(err) === "Error: invalid_json" ? 400 : 500,
            {
              error:
                String(err) === "Error: invalid_json"
                  ? "invalid_json"
                  : "internal_error",
            },
          );
        }
      });
      return;
    }

    if (method === "POST" && url === "/api/mode") {
      void this.handleModeAction(req, res).catch((err) => {
        this.log(`[browser-gateway] mode action failed: ${err}`);
        if (!res.headersSent) {
          this.writeJson(
            res,
            String(err) === "Error: invalid_json" ? 400 : 500,
            {
              error:
                String(err) === "Error: invalid_json"
                  ? "invalid_json"
                  : "internal_error",
            },
          );
        }
      });
      return;
    }

    if (method === "GET" && url === "/api/slash-commands") {
      void this.handleSlashCommandsRequest(req, res).catch((err) => {
        this.log(`[browser-gateway] slash commands request failed: ${err}`);
        if (!res.headersSent) {
          this.writeJson(res, 500, { error: "internal_error" });
        }
      });
      return;
    }

    if (method === "GET" && url.startsWith("/api/search-files")) {
      void this.handleSearchFilesRequest(req, url, res).catch((err) => {
        this.log(`[browser-gateway] file search request failed: ${err}`);
        if (!res.headersSent) {
          this.writeJson(res, 500, { error: "internal_error" });
        }
      });
      return;
    }

    if (method === "GET" && url === "/api/modes") {
      void this.handleModesRequest(req, res).catch((err) => {
        this.log(`[browser-gateway] modes request failed: ${err}`);
        if (!res.headersSent) {
          this.writeJson(res, 500, { error: "internal_error" });
        }
      });
      return;
    }

    if (method === "GET" && url === "/api/models") {
      void this.handleModelsRequest(req, res).catch((err) => {
        this.log(`[browser-gateway] models request failed: ${err}`);
        if (!res.headersSent) {
          this.writeJson(res, 500, { error: "internal_error" });
        }
      });
      return;
    }

    if (method === "GET" && url === "/api/sessions") {
      void this.handleSessionsRequest(req, res).catch((err) => {
        this.log(`[browser-gateway] sessions request failed: ${err}`);
        if (!res.headersSent) {
          this.writeJson(res, 500, { error: "internal_error" });
        }
      });
      return;
    }

    if (method === "POST" && url === "/api/model") {
      void this.handleModelAction(req, res).catch((err) => {
        this.log(`[browser-gateway] model action failed: ${err}`);
        if (!res.headersSent) {
          this.writeJson(
            res,
            String(err) === "Error: invalid_json" ? 400 : 500,
            {
              error:
                String(err) === "Error: invalid_json"
                  ? "invalid_json"
                  : "internal_error",
            },
          );
        }
      });
      return;
    }

    if (method === "POST" && url === "/api/write-approval") {
      void this.handleWriteApprovalAction(req, res).catch((err) => {
        this.log(`[browser-gateway] write approval action failed: ${err}`);
        if (!res.headersSent) {
          this.writeJson(
            res,
            String(err) === "Error: invalid_json" ? 400 : 500,
            {
              error:
                String(err) === "Error: invalid_json"
                  ? "invalid_json"
                  : "internal_error",
            },
          );
        }
      });
      return;
    }

    if (method === "POST" && url === "/api/thinking") {
      void this.handleThinkingAction(req, res).catch((err) => {
        this.log(`[browser-gateway] thinking action failed: ${err}`);
        if (!res.headersSent) {
          this.writeJson(
            res,
            String(err) === "Error: invalid_json" ? 400 : 500,
            {
              error:
                String(err) === "Error: invalid_json"
                  ? "invalid_json"
                  : "internal_error",
            },
          );
        }
      });
      return;
    }

    if (method === "POST" && url === "/api/attach-file") {
      void this.handleAttachFileAction(req, res).catch((err) => {
        this.log(`[browser-gateway] attach file action failed: ${err}`);
        if (!res.headersSent) {
          this.writeJson(
            res,
            String(err) === "Error: invalid_json" ? 400 : 500,
            {
              error:
                String(err) === "Error: invalid_json"
                  ? "invalid_json"
                  : "internal_error",
            },
          );
        }
      });
      return;
    }

    if (method === "POST" && url === "/api/session/new") {
      void this.handleSessionNewAction(req, res).catch((err) => {
        this.log(`[browser-gateway] session new action failed: ${err}`);
        if (!res.headersSent) {
          this.writeJson(
            res,
            String(err) === "Error: invalid_json" ? 400 : 500,
            {
              error:
                String(err) === "Error: invalid_json"
                  ? "invalid_json"
                  : "internal_error",
            },
          );
        }
      });
      return;
    }

    if (method === "POST" && url === "/api/session/load") {
      void this.handleSessionLoadAction(req, res).catch((err) => {
        this.log(`[browser-gateway] session load action failed: ${err}`);
        if (!res.headersSent) {
          this.writeJson(
            res,
            String(err) === "Error: invalid_json" ? 400 : 500,
            {
              error:
                String(err) === "Error: invalid_json"
                  ? "invalid_json"
                  : "internal_error",
            },
          );
        }
      });
      return;
    }

    if (method === "POST" && url === "/api/session/delete") {
      void this.handleSessionDeleteAction(req, res).catch((err) => {
        this.log(`[browser-gateway] session delete action failed: ${err}`);
        if (!res.headersSent) {
          this.writeJson(
            res,
            String(err) === "Error: invalid_json" ? 400 : 500,
            {
              error:
                String(err) === "Error: invalid_json"
                  ? "invalid_json"
                  : "internal_error",
            },
          );
        }
      });
      return;
    }

    if (method === "POST" && url === "/api/session/rename") {
      void this.handleSessionRenameAction(req, res).catch((err) => {
        this.log(`[browser-gateway] session rename action failed: ${err}`);
        if (!res.headersSent) {
          this.writeJson(
            res,
            String(err) === "Error: invalid_json" ? 400 : 500,
            {
              error:
                String(err) === "Error: invalid_json"
                  ? "invalid_json"
                  : "internal_error",
            },
          );
        }
      });
      return;
    }

    if (method === "POST" && url === "/api/session/copy-first-prompt") {
      void this.handleSessionCopyFirstPromptAction(req, res).catch((err) => {
        this.log(
          `[browser-gateway] session copy first prompt action failed: ${err}`,
        );
        if (!res.headersSent) {
          this.writeJson(
            res,
            String(err) === "Error: invalid_json" ? 400 : 500,
            {
              error:
                String(err) === "Error: invalid_json"
                  ? "invalid_json"
                  : "internal_error",
            },
          );
        }
      });
      return;
    }

    if (method === "POST" && url === "/api/debug/refresh") {
      void this.handleDebugRefreshAction(req, res).catch((err) => {
        this.log(`[browser-gateway] debug refresh action failed: ${err}`);
        if (!res.headersSent) {
          this.writeJson(res, 500, { error: "internal_error" });
        }
      });
      return;
    }

    if (method === "POST" && url === "/api/mcp/action") {
      void this.handleMcpAction(req, res).catch((err) => {
        this.log(`[browser-gateway] mcp action failed: ${err}`);
        if (!res.headersSent) {
          this.writeJson(
            res,
            String(err) === "Error: invalid_json" ? 400 : 500,
            {
              error:
                String(err) === "Error: invalid_json"
                  ? "invalid_json"
                  : "internal_error",
            },
          );
        }
      });
      return;
    }

    if (method === "POST" && url === "/api/background/stop") {
      void this.handleBackgroundStopAction(req, res).catch((err) => {
        this.log(`[browser-gateway] background stop action failed: ${err}`);
        if (!res.headersSent) {
          this.writeJson(
            res,
            String(err) === "Error: invalid_json" ? 400 : 500,
            {
              error:
                String(err) === "Error: invalid_json"
                  ? "invalid_json"
                  : "internal_error",
            },
          );
        }
      });
      return;
    }

    if (method === "POST" && url === "/api/background/open-transcript") {
      void this.handleBackgroundOpenTranscriptAction(req, res).catch((err) => {
        this.log(
          `[browser-gateway] background open transcript action failed: ${err}`,
        );
        if (!res.headersSent) {
          this.writeJson(
            res,
            String(err) === "Error: invalid_json" ? 400 : 500,
            {
              error:
                String(err) === "Error: invalid_json"
                  ? "invalid_json"
                  : "internal_error",
            },
          );
        }
      });
      return;
    }

    this.writeJson(res, 404, { error: "not_found" });
  }

  private handleSse(req: http.IncomingMessage, res: http.ServerResponse): void {
    req.socket.setTimeout(0);
    res.socket?.setTimeout(0);
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "Access-Control-Allow-Origin": "*",
    });
    res.flushHeaders?.();

    const snapshot = this.getSnapshot();
    if (
      !this.writeSseChunk(
        res,
        `event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`,
      )
    ) {
      return;
    }
    this.sseClients.add(res);
    this.sseKeepaliveTimers.set(
      res,
      setInterval(() => {
        if (!this.writeSseChunk(res, `: keepalive ${Date.now()}\n\n`)) {
          this.removeSseClient(res);
        }
      }, SSE_KEEPALIVE_INTERVAL_MS),
    );

    const removeClient = () => {
      this.removeSseClient(res);
    };

    req.on("close", removeClient);
    res.on("close", removeClient);
    res.on("error", removeClient);
  }

  private broadcast(payload: unknown): void {
    const chunk = `event: update\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const client of this.sseClients) {
      if (!this.writeSseChunk(client, chunk)) {
        this.removeSseClient(client);
      }
    }
  }

  private writeSseChunk(client: http.ServerResponse, chunk: string): boolean {
    if (client.destroyed || client.writableEnded) return false;
    try {
      client.write(chunk);
      return true;
    } catch {
      return false;
    }
  }

  private removeSseClient(client: http.ServerResponse): void {
    this.sseClients.delete(client);
    const keepaliveTimer = this.sseKeepaliveTimers.get(client);
    if (keepaliveTimer) {
      clearInterval(keepaliveTimer);
      this.sseKeepaliveTimers.delete(client);
    }
    if (!client.destroyed && !client.writableEnded) {
      try {
        client.end();
      } catch {
        // ignore
      }
    }
  }

  private async handleInstancesRequest(
    res: http.ServerResponse,
  ): Promise<void> {
    const instances = await listHealthyBrowserGatewayInstances();
    this.writeJson(res, 200, {
      currentInstanceId: this.instanceId,
      instances: instances.map(({ authToken: _authToken, ...instance }) => ({
        ...instance,
        status:
          instance.instanceId === this.instanceId
            ? this.gatewayService.getInstanceStatusSummary()
            : undefined,
      })),
    });
  }

  private handleDiffDetailRequest(url: string, res: http.ServerResponse): void {
    const pathOnly = url.split("?", 1)[0] ?? url;
    const requestId = decodeURIComponent(pathOnly.slice("/api/diff/".length));
    const snapshot = diffSnapshotHub.get(requestId);
    if (!snapshot) {
      this.writeJson(res, 404, { error: "not_found" });
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

    const body = await this.readJsonBody(req);
    const parsed =
      body && typeof body === "object"
        ? (body as Record<string, unknown>)
        : undefined;
    if (typeof parsed?.id !== "string") {
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

    const body = (await this.readJsonBody(req)) as {
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

  private async handleQuestionAction(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    if (!this.isAuthorized(req)) {
      this.writeJson(res, 401, { error: "unauthorized" });
      return;
    }

    const body = (await this.readJsonBody(req)) as {
      id?: string;
      answers?: Record<
        string,
        string | string[] | number | boolean | undefined
      >;
      notes?: Record<string, string>;
    };
    if (
      typeof body?.id !== "string" ||
      !body.answers ||
      typeof body.answers !== "object"
    ) {
      this.writeJson(res, 400, { error: "invalid_request" });
      return;
    }
    const ok = this.chatViewProvider.submitBrowserQuestionResponse({
      id: body.id,
      answers: body.answers,
      notes: body.notes,
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

    const body = (await this.readJsonBody(req)) as {
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

    const body = (await this.readJsonBody(req)) as {
      text?: string;
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

    const ok = await this.chatViewProvider.submitBrowserSend({
      text,
      mode: body.mode,
      sessionId: body.sessionId,
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
    });
    this.writeJson(res, ok ? 200 : 400, { ok });
  }

  private async handleModeAction(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    if (!this.isAuthorized(req)) {
      this.writeJson(res, 401, { error: "unauthorized" });
      return;
    }

    const body = (await this.readJsonBody(req)) as {
      mode?: string;
      reason?: string;
    };
    if (typeof body?.mode !== "string" || !body.mode.trim()) {
      this.writeJson(res, 400, { error: "invalid_request" });
      return;
    }

    const result = await this.chatViewProvider.submitBrowserModeSwitch(
      body.mode,
    );
    this.writeJson(res, 200, result);
  }

  private async handleSlashCommandsRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    if (!this.isAuthorized(req)) {
      this.writeJson(res, 401, { error: "unauthorized" });
      return;
    }

    const commands = await this.chatViewProvider.getBrowserSlashCommands();
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

    const files = await this.chatViewProvider.searchBrowserFiles(query);
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

    const modes = await this.chatViewProvider.getBrowserModes();
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

    const body = (await this.readJsonBody(req)) as {
      model?: string;
    };
    if (typeof body?.model !== "string" || !body.model.trim()) {
      this.writeJson(res, 400, { error: "invalid_request" });
      return;
    }

    const result = await this.chatViewProvider.submitBrowserSetModel(
      body.model,
    );
    this.writeJson(res, result.ok ? 200 : 400, result);
  }

  private async handleWriteApprovalAction(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    if (!this.isAuthorized(req)) {
      this.writeJson(res, 401, { error: "unauthorized" });
      return;
    }

    const body = (await this.readJsonBody(req)) as {
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

  private async handleThinkingAction(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    if (!this.isAuthorized(req)) {
      this.writeJson(res, 401, { error: "unauthorized" });
      return;
    }

    const body = (await this.readJsonBody(req)) as {
      enabled?: boolean;
      effort?: import("../agent/providers/types.js").ReasoningEffort;
    };
    if (typeof body?.effort === "string" && body.effort.trim()) {
      if (!isReasoningEffort(body.effort)) {
        this.writeJson(res, 400, { error: "invalid_request" });
        return;
      }
      const result = this.chatViewProvider.submitBrowserSetReasoningEffort(
        body.effort,
      );
      this.writeJson(res, result.ok ? 200 : 400, result);
      return;
    }
    if (typeof body?.enabled !== "boolean") {
      this.writeJson(res, 400, { error: "invalid_request" });
      return;
    }

    const result = this.chatViewProvider.submitBrowserSetThinkingEnabled(
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

    const result = await this.chatViewProvider.submitBrowserAttachFile();
    this.writeJson(res, 200, result);
  }

  private async handleSessionNewAction(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    if (!this.isAuthorized(req)) {
      this.writeJson(res, 401, { error: "unauthorized" });
      return;
    }

    const body = (await this.readJsonBody(req)) as { mode?: string };
    const result = await this.chatViewProvider.submitBrowserNewSession(
      body?.mode,
    );
    this.writeJson(res, result.ok ? 200 : 400, result);
  }

  private async handleSessionLoadAction(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    if (!this.isAuthorized(req)) {
      this.writeJson(res, 401, { error: "unauthorized" });
      return;
    }

    const body = (await this.readJsonBody(req)) as { sessionId?: string };
    if (typeof body?.sessionId !== "string" || !body.sessionId.trim()) {
      this.writeJson(res, 400, { error: "invalid_request" });
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

    const body = (await this.readJsonBody(req)) as { sessionId?: string };
    if (typeof body?.sessionId !== "string" || !body.sessionId.trim()) {
      this.writeJson(res, 400, { error: "invalid_request" });
      return;
    }

    const result = this.chatViewProvider.submitBrowserDeleteSession(
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

    const body = (await this.readJsonBody(req)) as {
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

    const result = this.chatViewProvider.submitBrowserRenameSession(
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

    const body = (await this.readJsonBody(req)) as { sessionId?: string };
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

  private async handleMcpAction(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    if (!this.isAuthorized(req)) {
      this.writeJson(res, 401, { error: "unauthorized" });
      return;
    }

    const body = (await this.readJsonBody(req)) as {
      serverName?: string;
      action?: "disable" | "reconnect" | "reauthenticate";
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

    const result = this.chatViewProvider.submitBrowserMcpAction(
      body.serverName,
      body.action,
    );
    this.writeJson(res, result.ok ? 200 : 400, result);
  }

  private async handleBackgroundStopAction(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    if (!this.isAuthorized(req)) {
      this.writeJson(res, 401, { error: "unauthorized" });
      return;
    }

    const body = (await this.readJsonBody(req)) as {
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

  private async handleBackgroundOpenTranscriptAction(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    if (!this.isAuthorized(req)) {
      this.writeJson(res, 401, { error: "unauthorized" });
      return;
    }

    const body = (await this.readJsonBody(req)) as {
      sessionId?: string;
    };
    if (typeof body?.sessionId !== "string" || !body.sessionId.trim()) {
      this.writeJson(res, 400, { error: "invalid_request" });
      return;
    }

    const result = this.chatViewProvider.getBrowserBgTranscript(body.sessionId);
    this.writeJson(res, result.ok ? 200 : 404, result);
  }

  private async readJsonBody(req: http.IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const raw = Buffer.concat(chunks).toString("utf-8");
    if (!raw.trim()) return {};
    try {
      return JSON.parse(raw);
    } catch {
      throw new Error("invalid_json");
    }
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

function isReasoningEffort(
  value: string,
): value is import("../agent/providers/types.js").ReasoningEffort {
  return ["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(
    value,
  );
}
