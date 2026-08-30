/** @vitest-environment node */

import * as fs from "fs/promises";
import * as http from "http";
import * as path from "path";

import type {
  BrowserGatewayOwnerEvent,
  BrowserGatewayOwnerEventKind,
} from "../dataPlane/protocol.js";
import type {
  BrowserGatewayOwnerProjectionReadSet,
  BrowserGatewayOwnerProjectionSourceKind,
  BrowserGatewayOwnerProjectionSources,
} from "../dataPlane/ownerProjectionSources.js";

import type { BrowserGatewayHelper } from "../helper/browserGatewayHelper.js";
import type { BrowserGatewayInstanceRecord } from "../browserGatewayRegistry.js";
import type { BrowserGatewayOwnerRuntime } from "../dataPlane/BrowserGatewayOwnerRuntime.js";
import type { ChatMessage } from "@agentlink/protocol/chat-transcript";
import {
  evaluatePhase3MobilePaintGate,
  type Phase3MobilePaintCategory,
  type Phase3MobilePaintSample,
} from "./phase3MobilePaintGate.js";

const FIXTURE_WORKSPACE_NAME = "Phase 3 Mobile Fixture";
const FIXTURE_INSTANCE_ID = "phase3-mobile-instance";
const FIXTURE_OWNER_ID = "phase3-mobile-owner";
const FIXTURE_OWNER_GENERATION_ID = "phase3-mobile-owner-generation";
const FIXTURE_METADATA_AUTH_TOKEN = "phase3-mobile-metadata-token";
const RELAY_WAIT_TIMEOUT_MS = 5_000;

export interface Phase3MobileBrowserFixtureOptions {
  readonly helperPort: number;
  readonly metadataPort: number;
  readonly homeRootPath: string;
  readonly extensionRootPath: string;
  readonly dataPlaneMode?: "on" | "shadow";
}

export interface Phase3MobileBrowserTriggerResult {
  readonly category: Phase3MobilePaintCategory;
  readonly eventId: string;
  readonly eventKind: BrowserGatewayOwnerEventKind;
  readonly ownerSequence: number;
}

export interface Phase3MobileBrowserIdentity {
  readonly instanceId: string;
  readonly workspaceName: string;
  readonly ownerId: string;
  readonly ownerGenerationId: string;
  readonly helperGenerationId: string;
}

type RegistryModule = typeof import("../browserGatewayRegistry.js");

type MutableReadSet = BrowserGatewayOwnerProjectionReadSet & {
  foreground: NonNullable<BrowserGatewayOwnerProjectionReadSet["foreground"]>;
};

class MutableProjectionSources implements BrowserGatewayOwnerProjectionSources {
  private readonly listeners = new Set<
    (source: BrowserGatewayOwnerProjectionSourceKind) => void
  >();

  constructor(readonly readSet: MutableReadSet) {}

  capture(): BrowserGatewayOwnerProjectionReadSet {
    return this.readSet;
  }

  onDidChange(
    listener: (source: BrowserGatewayOwnerProjectionSourceKind) => void,
  ): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  fire(source: BrowserGatewayOwnerProjectionSourceKind): void {
    for (const listener of this.listeners) listener(source);
  }
}

class RelayObserver {
  private readonly events: BrowserGatewayOwnerEvent[] = [];
  private readonly waiters = new Set<() => void>();
  private reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  private consumeTask: Promise<void> | undefined;
  private browserConnectionId = "";
  private csrfNonce = "";
  private checkpointSeen = false;
  private plannedClose = false;
  private error: Error | undefined;

  constructor(
    private readonly baseUrl: string,
    private readonly cookie: string,
    private readonly ownerId: string,
    private readonly ownerGenerationId: string,
  ) {}

  get lastOwnerSequence(): number {
    return this.events.at(-1)?.ownerSequence ?? 0;
  }

  async start(): Promise<void> {
    const response = await fetch(`${this.baseUrl}/api/relay/events`, {
      headers: { Cookie: this.cookie },
    });
    if (!response.ok || !response.body) {
      throw new Error(`phase3_mobile_relay_open_failed:${response.status}`);
    }
    this.reader = response.body.getReader();
    this.consumeTask = this.consume();
    await this.waitFor(() =>
      Boolean(this.browserConnectionId && this.csrfNonce),
    );

    const subscription = await fetch(`${this.baseUrl}/api/relay/subscription`, {
      method: "POST",
      headers: {
        Cookie: this.cookie,
        Origin: this.baseUrl,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        browserConnectionId: this.browserConnectionId,
        csrfNonce: this.csrfNonce,
        ownerId: this.ownerId,
        ownerGenerationId: this.ownerGenerationId,
      }),
    });
    if (subscription.status !== 202) {
      throw new Error(
        `phase3_mobile_relay_subscription_failed:${subscription.status}`,
      );
    }
    await this.waitFor(() => this.checkpointSeen);
  }

  async waitForEvent(
    afterSequence: number,
    kind: BrowserGatewayOwnerEventKind,
  ): Promise<BrowserGatewayOwnerEvent> {
    await this.waitFor(() =>
      this.events.some(
        (event) => event.ownerSequence > afterSequence && event.kind === kind,
      ),
    );
    const event = this.events.find(
      (candidate) =>
        candidate.ownerSequence > afterSequence && candidate.kind === kind,
    );
    if (!event) throw new Error("phase3_mobile_relay_event_missing");
    return event;
  }

  async close(): Promise<void> {
    if (this.plannedClose) return;
    this.plannedClose = true;
    await this.reader?.cancel().catch(() => undefined);
    await this.consumeTask?.catch(() => undefined);
  }

  private async consume(): Promise<void> {
    const reader = this.reader;
    if (!reader) return;
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) {
          if (!this.plannedClose) {
            this.error = new Error("phase3_mobile_relay_closed_unexpectedly");
          }
          this.notify();
          return;
        }
        buffer += decoder
          .decode(next.value, { stream: true })
          .replaceAll("\r\n", "\n");
        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          this.acceptFrame(buffer.slice(0, boundary));
          buffer = buffer.slice(boundary + 2);
          boundary = buffer.indexOf("\n\n");
        }
      }
    } catch (error) {
      if (!this.plannedClose) {
        this.error = error instanceof Error ? error : new Error(String(error));
      }
      this.notify();
    }
  }

  private acceptFrame(frame: string): void {
    const parsed = parseSseFrame(frame);
    if (!parsed) return;
    if (parsed.name === "hello") {
      this.browserConnectionId = stringField(
        parsed.data,
        "browserConnectionId",
        "phase3_mobile_relay_hello_invalid",
      );
      this.csrfNonce = stringField(
        parsed.data,
        "csrfNonce",
        "phase3_mobile_relay_hello_invalid",
      );
    } else if (parsed.name === "checkpoint") {
      this.checkpointSeen = true;
    } else if (parsed.name === "owner.event") {
      const record = objectField(
        parsed.data,
        "record",
        "phase3_mobile_relay_event_invalid",
      );
      const event = objectField(
        record,
        "event",
        "phase3_mobile_relay_event_invalid",
      ) as unknown as BrowserGatewayOwnerEvent;
      if (
        event.ownerId === this.ownerId &&
        event.ownerGenerationId === this.ownerGenerationId
      ) {
        this.events.push(event);
      }
    }
    this.notify();
  }

  private async waitFor(predicate: () => boolean): Promise<void> {
    const deadline = Date.now() + RELAY_WAIT_TIMEOUT_MS;
    while (!predicate()) {
      if (this.error) throw this.error;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("phase3_mobile_relay_wait_timeout");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(
          () => {
            this.waiters.delete(done);
            resolve();
          },
          Math.min(remaining, 100),
        );
        const done = () => {
          clearTimeout(timer);
          this.waiters.delete(done);
          resolve();
        };
        this.waiters.add(done);
      });
    }
  }

  private notify(): void {
    for (const waiter of this.waiters) waiter();
  }
}

export class Phase3MobileBrowserFixture {
  readonly baseUrl: string;
  readonly metadataBaseUrl: string;
  readonly metadataAuthToken = FIXTURE_METADATA_AUTH_TOKEN;

  private readonly originalHome = process.env.HOME;
  private readonly readSet = createReadSet();
  private readonly sources = new MutableProjectionSources(this.readSet);
  private readonly metadataServer = http.createServer((request, response) => {
    void this.handleMetadataRequest(request, response);
  });
  private readonly helperServer = http.createServer();
  private helper: BrowserGatewayHelper | undefined;
  private runtime: BrowserGatewayOwnerRuntime | undefined;
  private relayObserver: RelayObserver | undefined;
  private registry: RegistryModule | undefined;
  private helperGenerationId = "";
  private effectiveOwnerId = FIXTURE_OWNER_ID;
  private started = false;
  private stopping = false;
  private triggerSequence = 0;

  constructor(private readonly options: Phase3MobileBrowserFixtureOptions) {
    validatePort(options.helperPort, "helperPort");
    validatePort(options.metadataPort, "metadataPort");
    if (options.helperPort === options.metadataPort) {
      throw new Error("phase3_mobile_fixture_ports_must_differ");
    }
    this.baseUrl = `http://127.0.0.1:${options.helperPort}`;
    this.metadataBaseUrl = `http://127.0.0.1:${options.metadataPort}`;
  }

  get identity(): Phase3MobileBrowserIdentity {
    if (!this.helperGenerationId) {
      throw new Error("phase3_mobile_fixture_not_started");
    }
    return {
      instanceId: FIXTURE_INSTANCE_ID,
      workspaceName: FIXTURE_WORKSPACE_NAME,
      ownerId: this.effectiveOwnerId,
      ownerGenerationId: FIXTURE_OWNER_GENERATION_ID,
      helperGenerationId: this.helperGenerationId,
    };
  }

  async start(): Promise<void> {
    if (this.started) return;
    if (this.stopping) throw new Error("phase3_mobile_fixture_stopping");
    process.env.HOME = this.options.homeRootPath;
    await fs.mkdir(this.options.homeRootPath, { recursive: true });
    await listen(this.metadataServer, this.options.metadataPort);

    try {
      const [
        helperModule,
        registry,
        runtimeModule,
        preferencesModule,
        historyModule,
        memoryModule,
      ] = await Promise.all([
        import("../helper/browserGatewayHelper.js"),
        import("../browserGatewayRegistry.js"),
        import("../dataPlane/BrowserGatewayOwnerRuntime.js"),
        import("../browserGatewayAskAgentPreferences.js"),
        import("../browserGatewayAskAgentHistory.js"),
        import("../browserGatewayAskAgentMemory.js"),
      ]);
      this.registry = registry;
      const storeRoot = path.join(this.options.homeRootPath, ".agentlink");
      this.helper = new helperModule.BrowserGatewayHelper(
        {
          port: this.options.helperPort,
          helperVersion: "phase3-mobile-fixture",
          idleShutdownMs: 120_000,
          shutdownTimeoutMs: 2_000,
          extensionRootPath: this.options.extensionRootPath,
          askAgentLogPath: path.join(storeRoot, "ask-agent.jsonl"),
        },
        this.helperServer,
        {
          askAgentPreferencesStore:
            new preferencesModule.BrowserGatewayAskAgentPreferencesStore({
              filePath: path.join(storeRoot, "preferences.json"),
            }),
          askAgentHistoryStore:
            new historyModule.BrowserGatewayAskAgentHistoryStore({
              filePath: path.join(storeRoot, "history.json"),
            }),
          askAgentMemoryStore:
            new memoryModule.BrowserGatewayAskAgentMemoryStore({
              filePath: path.join(storeRoot, "memory.json"),
            }),
        },
      );
      this.helperServer.on("request", this.helper.handleRequest);
      await this.helper.start();

      const healthResponse = await fetch(`${this.baseUrl}/health`);
      if (!healthResponse.ok) {
        throw new Error(
          `phase3_mobile_helper_health_failed:${healthResponse.status}`,
        );
      }
      const health = (await healthResponse.json()) as {
        status?: unknown;
        helperGenerationId?: unknown;
      };
      if (
        health.status !== "ok" ||
        typeof health.helperGenerationId !== "string" ||
        !health.helperGenerationId
      ) {
        throw new Error("phase3_mobile_helper_health_invalid");
      }
      this.helperGenerationId = health.helperGenerationId;

      await registry.upsertBrowserGatewayInstance(this.registryRecord());
      this.runtime = new runtimeModule.BrowserGatewayOwnerRuntime({
        helperUrl: this.baseUrl,
        clientSharedSecret: this.helper.getClientSharedSecret(),
        helperGenerationId: this.helperGenerationId,
        owner: {
          ownerId: FIXTURE_OWNER_ID,
          ownerKind: "vscode",
          displayName: FIXTURE_WORKSPACE_NAME,
          scope: {
            kind: "workspace",
            workspaceId: FIXTURE_INSTANCE_ID,
            displayName: FIXTURE_WORKSPACE_NAME,
          },
          ownerGenerationId: FIXTURE_OWNER_GENERATION_ID,
          instanceId: FIXTURE_INSTANCE_ID,
          processId: process.pid,
        },
        sources: this.sources,
        executor: { execute: async () => undefined },
        commandCapabilities: [],
        heartbeatIntervalMs: 5_000,
      });
      const registration = await this.runtime.start();
      this.effectiveOwnerId = registration.effectiveOwnerId;

      const root = await fetch(`${this.baseUrl}/`);
      if (!root.ok) {
        throw new Error(`phase3_mobile_helper_root_failed:${root.status}`);
      }
      const html = await root.text();
      if (!html.includes("window.__AGENTLINK_BROWSER_GATEWAY__")) {
        throw new Error("phase3_mobile_helper_bootstrap_missing");
      }
      const cookie = root.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
      if (!cookie) throw new Error("phase3_mobile_helper_cookie_missing");

      this.relayObserver = new RelayObserver(
        this.baseUrl,
        cookie,
        this.effectiveOwnerId,
        FIXTURE_OWNER_GENERATION_ID,
      );
      await this.relayObserver.start();
      this.started = true;
    } catch (error) {
      await this.stop().catch(() => undefined);
      throw error;
    }
  }

  async trigger(
    category: Phase3MobilePaintCategory,
  ): Promise<Phase3MobileBrowserTriggerResult> {
    if (!this.started || !this.relayObserver) {
      throw new Error("phase3_mobile_fixture_not_started");
    }
    const afterSequence = this.relayObserver.lastOwnerSequence;
    const eventKind = this.applyTrigger(category);
    const event = await this.relayObserver.waitForEvent(
      afterSequence,
      eventKind,
    );
    return {
      category,
      eventId: event.eventId,
      eventKind: event.kind,
      ownerSequence: event.ownerSequence,
    };
  }

  async listRegistryInstances(): Promise<BrowserGatewayInstanceRecord[]> {
    if (!this.registry) throw new Error("phase3_mobile_fixture_not_started");
    return await this.registry.listBrowserGatewayInstances();
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    try {
      await this.relayObserver?.close().catch(() => undefined);
      this.relayObserver = undefined;
      await this.runtime?.close().catch(() => undefined);
      this.runtime = undefined;
      if (this.registry) {
        await this.registry
          .removeBrowserGatewayInstance(FIXTURE_INSTANCE_ID)
          .catch(() => undefined);
      }
      await this.helper
        ?.stop("phase3_mobile_fixture_stop")
        .catch(() => undefined);
      this.helper = undefined;
      if (this.metadataServer.listening) {
        await closeServer(this.metadataServer);
      }
      this.started = false;
    } finally {
      if (this.originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = this.originalHome;
      this.stopping = false;
    }
  }

  private applyTrigger(
    category: Phase3MobilePaintCategory,
  ): BrowserGatewayOwnerEventKind {
    this.triggerSequence += 1;
    const sequence = this.triggerSequence;
    const foreground = this.readSet.foreground;
    const messages = foreground.messages as ChatMessage[];
    const message = messages[0];
    if (!message) throw new Error("phase3_mobile_fixture_message_missing");

    switch (category) {
      case "text": {
        const block = message.blocks[0];
        if (!block || block.type !== "text") {
          throw new Error("phase3_mobile_fixture_text_block_missing");
        }
        message.blocks = [{ ...block, text: `${block.text} ${sequence}` }];
        this.sources.fire("foreground");
        return "transcript.block.delta";
      }
      case "progress":
        foreground.status = `working-${sequence}`;
        foreground.streaming = true;
        this.sources.fire("foreground");
        return "foreground.control.updated";
      case "approval": {
        const requestId = `phase3-approval-${sequence}`;
        this.readSet.interaction = {
          requestId,
          kind: "approval",
          backgroundTask: "Phase 3 mobile approval",
          payload: {
            approval: {
              id: requestId,
              kind: "command",
              command: "printf phase3-mobile",
              reason: "Measure approval paint latency",
              cwd: this.options.extensionRootPath,
            },
            question: null,
            questionProgress: null,
            formElicitation: null,
            urlElicitation: null,
          },
        };
        this.sources.fire("ui");
        return "interaction.updated";
      }
      case "question": {
        const requestId = `phase3-question-${sequence}`;
        this.readSet.interaction = {
          requestId,
          kind: "question",
          backgroundTask: "Phase 3 mobile question",
          payload: {
            approval: null,
            question: {
              id: requestId,
              context: "Measure question paint latency.",
              questions: [
                {
                  id: "continue",
                  type: "yes_no",
                  question: "Continue the Phase 3 fixture?",
                },
              ],
            },
            questionProgress: null,
            formElicitation: null,
            urlElicitation: null,
          },
        };
        this.sources.fire("ui");
        return "interaction.updated";
      }
      case "error":
        delete message.finalMarker;
        message.error = {
          message: `Phase 3 fixture error ${sequence}`,
          retryable: true,
          code: "phase3_fixture_error",
        };
        this.sources.fire("foreground");
        return "transcript.message.upserted";
      case "completion":
        delete message.error;
        message.finalMarker = {
          status: "completed",
          summary: `Phase 3 fixture completion ${sequence}`,
          source: "tool",
        };
        this.sources.fire("foreground");
        return "transcript.message.upserted";
    }
  }

  private registryRecord(): BrowserGatewayInstanceRecord {
    return {
      instanceId: FIXTURE_INSTANCE_ID,
      workspaceName: FIXTURE_WORKSPACE_NAME,
      workspacePath: this.options.extensionRootPath,
      dataPlaneMode: this.options.dataPlaneMode ?? "on",
      theme: { colorScheme: "dark", cssVariables: {} },
      pid: process.pid,
      port: this.options.metadataPort,
      url: this.metadataBaseUrl,
      protocolVersion: 1,
      startedAt: new Date().toISOString(),
      authToken: FIXTURE_METADATA_AUTH_TOKEN,
    };
  }

  private async handleMetadataRequest(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    const requestUrl = new URL(request.url ?? "/", this.metadataBaseUrl);
    if (request.method === "OPTIONS") {
      response.writeHead(204, this.controlCorsHeaders());
      response.end();
      return;
    }
    if (request.method === "GET" && requestUrl.pathname === "/health") {
      writeJson(response, 200, { status: "ok" });
      return;
    }
    if (
      request.method === "GET" &&
      requestUrl.pathname === "/api/instance-status"
    ) {
      if (!this.isMetadataAuthorized(request)) {
        writeJson(response, 401, { error: "unauthorized" });
        return;
      }
      writeJson(response, 200, {
        kind: this.readSet.interaction ? "awaiting_approval" : "working",
        label: "Phase 3 fixture",
        sessionTitle: this.readSet.foreground.title,
      });
      return;
    }
    if (
      request.method === "POST" &&
      requestUrl.pathname === "/__phase3/evaluate"
    ) {
      if (!this.isMetadataAuthorized(request)) {
        writeJson(
          response,
          401,
          { error: "unauthorized" },
          this.controlCorsHeaders(),
        );
        return;
      }
      try {
        const body = (await readJson(request)) as {
          samples?: unknown;
          minimumSamplesPerClass?: unknown;
        };
        if (!Array.isArray(body.samples)) {
          writeJson(
            response,
            400,
            { error: "invalid_samples" },
            this.controlCorsHeaders(),
          );
          return;
        }
        const minimumSamplesPerClass =
          typeof body.minimumSamplesPerClass === "number"
            ? body.minimumSamplesPerClass
            : undefined;
        const report = evaluatePhase3MobilePaintGate(
          body.samples as Phase3MobilePaintSample[],
          minimumSamplesPerClass === undefined
            ? {}
            : { minimumSamplesPerClass },
        );
        writeJson(response, 200, report, this.controlCorsHeaders());
      } catch (error) {
        writeJson(
          response,
          400,
          { error: error instanceof Error ? error.message : String(error) },
          this.controlCorsHeaders(),
        );
      }
      return;
    }
    if (
      request.method === "POST" &&
      requestUrl.pathname === "/__phase3/trigger"
    ) {
      if (!this.isMetadataAuthorized(request)) {
        writeJson(
          response,
          401,
          { error: "unauthorized" },
          this.controlCorsHeaders(),
        );
        return;
      }
      try {
        const body = (await readJson(request)) as { category?: unknown };
        if (!isPaintCategory(body.category)) {
          writeJson(
            response,
            400,
            { error: "invalid_category" },
            this.controlCorsHeaders(),
          );
          return;
        }
        const result = await this.trigger(body.category);
        writeJson(response, 200, result, this.controlCorsHeaders());
      } catch (error) {
        writeJson(
          response,
          500,
          { error: error instanceof Error ? error.message : String(error) },
          this.controlCorsHeaders(),
        );
      }
      return;
    }
    writeJson(response, 404, { error: "not_found" });
  }

  private isMetadataAuthorized(request: http.IncomingMessage): boolean {
    return (
      request.headers.authorization === `Bearer ${FIXTURE_METADATA_AUTH_TOKEN}`
    );
  }

  private controlCorsHeaders(): http.OutgoingHttpHeaders {
    return {
      "Access-Control-Allow-Origin": this.baseUrl,
      "Access-Control-Allow-Headers": "authorization, content-type",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
    };
  }
}

function createReadSet(): MutableReadSet {
  const message: ChatMessage = {
    id: "phase3-mobile-message",
    role: "assistant",
    content: "",
    timestamp: Date.now(),
    blocks: [{ type: "text", text: "Phase 3 mobile fixture" }],
  };
  return {
    catalog: {
      projects: [
        {
          projectId: FIXTURE_INSTANCE_ID,
          displayName: FIXTURE_WORKSPACE_NAME,
          availability: "available",
        },
      ],
      sessions: [
        {
          sessionId: "phase3-mobile-session",
          projectId: FIXTURE_INSTANCE_ID,
          title: FIXTURE_WORKSPACE_NAME,
          mode: "code",
          model: "phase3-fixture-model",
          messageCount: 1,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ],
      defaultProjectId: FIXTURE_INSTANCE_ID,
      foregroundSessionId: "phase3-mobile-session",
    },
    foreground: {
      sessionId: "phase3-mobile-session",
      title: FIXTURE_WORKSPACE_NAME,
      mode: "code",
      model: "phase3-fixture-model",
      status: "working",
      streaming: true,
      statusOverride: null,
      thinkingEnabled: true,
      reasoningEffort: "high",
      lastInputTokens: 0,
      lastOutputTokens: 0,
      lastCacheReadTokens: 0,
      contextHealth: null,
      restoringSession: false,
      revertRecoveryNotice: null,
      messages: [message],
      earlierCursor: null,
      hasEarlier: false,
      cursorBeforeMessage: (messageId) => `before:${messageId}`,
      queue: [],
      todos: [],
    },
    interaction: null,
    background: [],
    fleet: [],
    diffs: [],
    repository: null,
    theme: { colorScheme: "dark", cssVariables: {} },
    modelCatalogRevision: "phase3-mobile-models-1",
    mcp: [],
    policies: {
      agentWriteApproval: "prompt",
      commandApprovalPolicy: "safe",
      approvalPolicy: "on-request",
      approvalReviewer: "user",
      executionPreset: "native-manual",
      configuredCommandApprovalPolicy: "safe",
    },
  };
}

function parseSseFrame(
  frame: string,
): { readonly name: string; readonly data: unknown } | null {
  let name = "";
  const data: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) name = line.slice(6).trim();
    if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  if (!name || data.length === 0) return null;
  return { name, data: JSON.parse(data.join("\n")) };
}

function objectField(
  value: unknown,
  key: string,
  error: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object") throw new Error(error);
  const field = (value as Record<string, unknown>)[key];
  if (!field || typeof field !== "object") throw new Error(error);
  return field as Record<string, unknown>;
}

function stringField(value: unknown, key: string, error: string): string {
  if (!value || typeof value !== "object") throw new Error(error);
  const field = (value as Record<string, unknown>)[key];
  if (typeof field !== "string" || field.length === 0) throw new Error(error);
  return field;
}

function isPaintCategory(value: unknown): value is Phase3MobilePaintCategory {
  return (
    value === "text" ||
    value === "progress" ||
    value === "approval" ||
    value === "question" ||
    value === "error" ||
    value === "completion"
  );
}

function validatePort(value: number, field: string): void {
  if (!Number.isInteger(value) || value <= 0 || value > 65_535) {
    throw new Error(`phase3_mobile_fixture_invalid_${field}`);
  }
}

async function listen(server: http.Server, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
}

async function closeServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function readJson(request: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf-8"));
}

function writeJson(
  response: http.ServerResponse,
  status: number,
  value: unknown,
  headers: http.OutgoingHttpHeaders = {},
): void {
  response.writeHead(status, {
    "Content-Type": "application/json",
    ...headers,
  });
  response.end(JSON.stringify(value));
}
