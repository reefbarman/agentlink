import type { AgentModelReference } from "@agentlink/core";
import type { ApprovalRequest } from "@agentlink/protocol/approval-transport";
import { isBrowserGatewayAskAgentSessionId } from "@agentlink/protocol/browser-gateway-ask-agent-identity";
import type { BrowserGatewayThemeSnapshot } from "@agentlink/protocol/browser-gateway-theme";
import type { EmbeddedAgentTurnEvent } from "@agentlink/protocol";
import { promises as fs } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";

import type { BrowserGatewayAskAgentPersistedSession } from "../../../src/browser-gateway/browserGatewayAskAgentSessionStore.js";
import type { BrowserGatewayModelCredentialStatus } from "../../../src/browser-gateway/browserGatewayModelCredentialCache.js";
import { BAKED_BROWSER_GATEWAY_THEME } from "../../../src/browser-gateway/browserGatewayThemeCache.js";
import { BrowserGatewayCoreOwnerRegistry } from "../../../src/browser-gateway/coreOwnerRegistry.js";
import {
  AskAgentController,
  type AskAgentControllerPublication,
  type AskAgentControllerSnapshot,
  type AskAgentControllerTurn,
} from "../../../src/browser-gateway/helper/AskAgentController.js";
import {
  SseHub,
  type SsePublication,
} from "../../../src/browser-gateway/SseHub.js";
import { agentMessagesToChatMessages } from "../../../src/shared/chatProjection.js";
import type { AssistantServerAuth } from "./assistantServer.js";
import { writeFileAtomic } from "./atomicFile.js";
import { HttpError, readJsonBody, sendJson } from "./httpJson.js";
import type { AssistantServerModelChoice } from "./serverConfig.js";
import type {
  SequencedSessionEvent,
  SessionEventHub,
} from "./SessionEventHub.js";
import type { AssistantSessionOperations } from "./workspaceRoutes.js";

/**
 * Serves the shared Ask Agent browser UI's `/api/ask-agent/*` contract from
 * one project's workspace sessions. The gateway's session store and
 * controller hold the UI projection, unchanged; this bridge maps each UI
 * session to a durable workspace session, runs turns through the same
 * session operations as the HTTP API, and projects their events (text,
 * tools, approvals, completion) into the store.
 */

const MAX_SEND_BODY_BYTES = 512 * 1024;
const MAX_TITLE_LENGTH = 200;
const MAX_APPROVAL_DETAIL_LENGTH = 4_000;
const MAX_TOOL_RESULT_LENGTH = 20_000;
const SSE_REVALIDATE_MS = 60_000;
const CREDENTIAL_STATUS: BrowserGatewayModelCredentialStatus = {
  state: "not_required",
  providerId: "agentlink-server",
};
const ALLOW_DECISIONS = new Set(["accept", "accept-session"]);

/** Routes the UI calls that this server does not implement yet. */
const EMPTY_GET_RESPONSES: Readonly<Record<string, unknown>> = {
  "/api/ask-agent/slash-commands": { commands: [] },
  "/api/ask-agent/read-grants": { grants: [] },
  "/api/ask-agent/project-handoff/targets": { targets: [] },
  // Polled by the shared UI: no updates to offer.
  "/api/ask-agent/product-updates": {},
};
/** Gateway-wide routes the shared UI polls; this server has no VS Code windows. */
const GATEWAY_GET_RESPONSES: Readonly<Record<string, unknown>> = {
  "/api/instances": {
    currentInstanceId: "",
    dataPlaneMode: "off",
    instances: [],
  },
  "/api/modes": { modes: [] },
};
const UNAVAILABLE_GET_ROUTES = new Set([
  "/api/ask-agent/mcp-config",
  "/api/ask-agent/mcp-status",
  "/api/ask-agent/mcp-manager-operation",
  "/api/ask-agent/memory",
  "/api/ask-agent/autonomous-memory/health",
  "/api/ask-agent/autonomous-memory/activity",
]);

export interface AskAgentBridgeOptions {
  readonly projectId: string;
  readonly operations: AssistantSessionOperations;
  readonly events: SessionEventHub;
  readonly models: {
    readonly available: readonly AssistantServerModelChoice[];
    readonly defaultModel: AgentModelReference;
  };
  /** Where UI-only session metadata (aliases, titles, hidden) is kept. */
  readonly stateFile: string;
  readonly theme?: BrowserGatewayThemeSnapshot;
  readonly now?: () => number;
}

export interface AskAgentBridge {
  /** Handles `/api/ask-agent/*`; false for any other path. */
  handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
    auth: AssistantServerAuth,
  ): Promise<boolean>;
  readonly theme: BrowserGatewayThemeSnapshot;
  close(): Promise<void>;
}

interface BridgeState {
  /** UI (client-minted) session ID to workspace session ID. */
  aliases: Record<string, string>;
  titles: Record<string, string>;
  hidden: string[];
}

interface PendingInteraction {
  readonly workspaceSessionId: string;
  readonly interactionId: string;
  readonly interactionRevision: string;
}

export function modelKey(model: AgentModelReference): string {
  return `${model.providerId}/${model.modelId}`;
}

export async function createAskAgentBridge(
  options: AskAgentBridgeOptions,
): Promise<AskAgentBridge> {
  const now = options.now ?? Date.now;
  const theme = options.theme ?? BAKED_BROWSER_GATEWAY_THEME;
  const { operations, projectId } = options;
  const modelsByKey = new Map(
    options.models.available.map((model) => [modelKey(model), model]),
  );
  const state = await readState(options.stateFile);
  /** Last known model of each workspace session. */
  const sessionModels = new Map<string, AgentModelReference>();

  const sse = new SseHub<AskAgentControllerSnapshot>({
    serialize: (snapshot) => JSON.stringify(snapshot),
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "x-accel-buffering": "no",
    },
  });
  const toPublication = (
    publication: AskAgentControllerPublication,
  ): SsePublication<AskAgentControllerSnapshot> => ({
    revision: publication.revision,
    value: publication.snapshot,
    serialized: publication.serialized,
    bytes: publication.bytes,
  });
  const controller = new AskAgentController({
    ownerRegistry: new BrowserGatewayCoreOwnerRegistry({
      heartbeatTtlMs: 60_000,
    }),
    coalesceMs: 20,
    serialize: (snapshot) => JSON.stringify(snapshot),
    byteLength: (serialized) => Buffer.byteLength(serialized),
    publish: (publication) => {
      sse.broadcast(toPublication(publication));
    },
  });
  const store = controller.sessionStore;
  store.updateAvailableModels(
    options.models.available.map((model) => ({
      id: modelKey(model),
      displayName: model.displayName ?? model.modelId,
      provider: model.providerId,
      ...(model.providerDisplayName
        ? { providerDisplayName: model.providerDisplayName }
        : {}),
      contextWindow: 200_000,
      supportsToolUse: true,
      authenticated: true,
    })),
  );
  store.setModel(modelKey(options.models.defaultModel));

  let pendingInteraction: PendingInteraction | undefined;
  let loaded: Promise<void> | undefined;
  let closed = false;
  /** Serializes turns: queued sends wait here for the previous one. */
  let turnChain: Promise<void> = Promise.resolve();
  let stateWrite: Promise<void> = Promise.resolve();

  const saveState = () => {
    const snapshot = JSON.stringify({ version: 1, ...state }, null, 2);
    stateWrite = stateWrite
      .catch(() => undefined)
      .then(async () => {
        await fs.mkdir(path.dirname(options.stateFile), {
          recursive: true,
          mode: 0o700,
        });
        await writeFileAtomic(options.stateFile, snapshot);
      });
    return stateWrite;
  };

  const project = () =>
    controller.projectState({
      now: now(),
      theme,
      modelCredentialStatus: CREDENTIAL_STATUS,
      approval: controller.getPendingApproval(),
      memoryCandidateNudge: null,
    });
  const snapshotResponse = () => ({ ok: true as const, ...project() });
  const publishNow = () => controller.publishSnapshot(project().snapshot);
  const schedule = () => {
    void controller
      .scheduleProjectedSnapshot(() => project().snapshot)
      .catch(() => undefined);
  };

  /** Load every visible workspace session into the store, once. */
  const ensureLoaded = (auth: AssistantServerAuth) => {
    loaded ??= (async () => {
      const reverse = new Map(
        Object.entries(state.aliases).map(([alias, id]) => [id, alias]),
      );
      const hidden = new Set(state.hidden);
      const summaries = await operations.listSessions(auth, projectId);
      const sessions: BrowserGatewayAskAgentPersistedSession[] = [];
      for (const summary of summaries) {
        if (hidden.has(summary.sessionId)) continue;
        let read;
        try {
          read = await operations.readSession(
            auth,
            projectId,
            summary.sessionId,
          );
        } catch {
          continue;
        }
        sessionModels.set(summary.sessionId, read.model);
        const messages = agentMessagesToChatMessages([...read.messages], {
          baseIndex: 0,
        });
        if (messages.length === 0) continue;
        const firstPrompt = messages.find((message) => message.role === "user");
        sessions.push({
          id: reverse.get(summary.sessionId) ?? summary.sessionId,
          title:
            state.titles[summary.sessionId] ??
            deriveTitle(firstPrompt?.content ?? ""),
          createdAt: read.createdAt,
          lastActiveAt: read.updatedAt,
          messages,
          nextMessageSequence: 1,
        });
      }
      sessions.sort((left, right) => right.lastActiveAt - left.lastActiveAt);
      store.loadHistory({ sessions });
    })().catch((error: unknown) => {
      loaded = undefined;
      throw error;
    });
    return loaded;
  };

  const workspaceSessionFor = (storeSessionId: string) =>
    state.aliases[storeSessionId] ??
    (sessionModels.has(storeSessionId) ? storeSessionId : undefined);

  const selectedModel = (): AgentModelReference => {
    const choice = modelsByKey.get(store.getModel());
    return choice
      ? { providerId: choice.providerId, modelId: choice.modelId }
      : options.models.defaultModel;
  };

  /** The workspace session behind the active UI session, created on demand. */
  const ensureWorkspaceSession = async (
    auth: AssistantServerAuth,
  ): Promise<string> => {
    const storeSessionId = store.getActiveSessionId();
    const existing = workspaceSessionFor(storeSessionId);
    const model = selectedModel();
    if (existing) {
      const current = sessionModels.get(existing);
      if (!current || modelKey(current) !== modelKey(model)) {
        await operations.setModel(auth, projectId, existing, model);
        sessionModels.set(existing, model);
      }
      return existing;
    }
    const { sessionId } = await operations.createSession(
      auth,
      projectId,
      model,
    );
    sessionModels.set(sessionId, model);
    state.aliases[storeSessionId] = sessionId;
    await saveState();
    return sessionId;
  };

  const approvalFor = (
    event: Extract<EmbeddedAgentTurnEvent, { type: "interaction.required" }>,
  ): ApprovalRequest => {
    const { interaction } = event;
    const input =
      interaction.displayInput === undefined
        ? ""
        : truncate(
            stringify(interaction.displayInput),
            MAX_APPROVAL_DETAIL_LENGTH,
          );
    return {
      kind: "write",
      id: interaction.interactionId,
      filePath: truncate(
        interaction.summary || `Allow ${interaction.toolName}?`,
        MAX_TITLE_LENGTH,
      ),
      writeOperation: "modify",
      detail: [`Tool: ${interaction.toolName}`, input]
        .filter(Boolean)
        .join("\n\n"),
      writeChoices: [
        { label: "Allow", value: "accept", isPrimary: true },
        { label: "Deny", value: "reject", isDanger: true },
      ],
    };
  };

  /**
   * Run one turn and project its events until it settles, including any
   * approval pauses (each resume is a new task on the same session).
   */
  const runTurn = async (params: {
    readonly auth: AssistantServerAuth;
    readonly workspaceSessionId: string;
    readonly messageId: string;
    readonly turn: AskAgentControllerTurn;
    readonly text: string;
  }): Promise<void> => {
    const { messageId, turn, workspaceSessionId } = params;
    const key = operations.sessionKey(projectId, workspaceSessionId);
    const toolStarts = new Map<string, number>();
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    let finished = false;
    const finish = () => {
      finished = true;
      settle();
    };

    const onTurnEvent = (event: EmbeddedAgentTurnEvent) => {
      switch (event.type) {
        case "text.delta":
          controller.appendAssistantDelta(messageId, event.text);
          schedule();
          return;
        case "tool.requested":
        case "tool.started":
          if (!toolStarts.has(event.toolCallId)) {
            toolStarts.set(event.toolCallId, event.emittedAt);
          }
          controller.startAssistantToolCall({
            messageId,
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            input: event.displayInput ?? {},
          });
          schedule();
          return;
        case "tool.completed":
        case "tool.failed":
          controller.completeAssistantToolCall({
            messageId,
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            input: {},
            result:
              event.type === "tool.failed"
                ? `Error: ${event.error.message}`
                : event.displayContent === undefined
                  ? ""
                  : truncate(
                      stringify(event.displayContent),
                      MAX_TOOL_RESULT_LENGTH,
                    ),
            durationMs: Math.max(
              0,
              event.emittedAt -
                (toolStarts.get(event.toolCallId) ?? event.emittedAt),
            ),
          });
          schedule();
          return;
        case "interaction.required": {
          pendingInteraction = {
            workspaceSessionId,
            interactionId: event.interaction.interactionId,
            interactionRevision: event.interactionRevision,
          };
          controller
            .requestApproval(approvalFor(event), turn.signal)
            .catch(() => undefined);
          void publishNow();
          return;
        }
        case "turn.completed":
          controller.finishAssistantSuccess({
            messageId,
            text: event.result.text ?? "",
          });
          return;
        case "turn.failed":
          if (!controller.isTurnStopped(turn)) {
            controller.finishAssistantError({
              messageId,
              text: event.result.error?.message ?? "The turn failed.",
              code: event.result.error?.code ?? "turn_failed",
              retryable: false,
            });
          }
          return;
        case "turn.cancelled":
          if (!controller.isTurnStopped(turn)) {
            controller.finishAssistantError({
              messageId,
              text: "Stopped.",
              code: "model_stopped",
              retryable: false,
            });
          }
          return;
        default:
          return;
      }
    };

    const onEvent = ({ event }: SequencedSessionEvent) => {
      if (finished) return;
      if (event.kind === "turn") {
        onTurnEvent(event.event);
        return;
      }
      if (event.kind !== "task" || event.state === "started") return;
      if (event.state === "failed") {
        if (!controller.isTurnStopped(turn)) {
          controller.finishAssistantError({
            messageId,
            text: "The assistant stopped unexpectedly.",
            code: event.error,
            retryable: false,
          });
        }
        finish();
        return;
      }
      // A suspended task waits for the owner; the resume is a new task.
      if (event.status === "suspended" && pendingInteraction) return;
      if (event.status === "suspended") {
        controller.finishAssistantSuccess({ messageId, text: "" });
      }
      finish();
    };

    const subscription = options.events.subscribe(
      key,
      options.events.latestSequence(key),
      onEvent,
    );
    const onAbort = () => {
      // Stopped while waiting for an approval: no task is running.
      if (pendingInteraction?.workspaceSessionId === workspaceSessionId) {
        pendingInteraction = undefined;
        finish();
      }
    };
    turn.signal.addEventListener("abort", onAbort, { once: true });
    try {
      await operations.startTurn(
        params.auth,
        projectId,
        workspaceSessionId,
        params.text,
      );
      await settled;
    } catch (error) {
      if (!controller.isTurnStopped(turn)) {
        controller.finishAssistantError({
          messageId,
          text: describeError(error),
          code: error instanceof HttpError ? error.code : "turn_failed",
          retryable: false,
        });
      }
    } finally {
      turn.signal.removeEventListener("abort", onAbort);
      subscription.unsubscribe();
      if (pendingInteraction?.workspaceSessionId === workspaceSessionId) {
        pendingInteraction = undefined;
      }
    }
  };

  const handleSend = async (
    request: IncomingMessage,
    response: ServerResponse,
    auth: AssistantServerAuth,
  ) => {
    const body = await readJsonBody(request, MAX_SEND_BODY_BYTES, auth.signal);
    const text = typeof body.text === "string" ? body.text : "";
    if (hasItems(body.images) || hasItems(body.documents)) {
      throw new HttpError(400, "ask_agent_media_unavailable");
    }
    if (hasItems(body.attachments)) {
      throw new HttpError(400, "ask_agent_path_attachments_unavailable");
    }
    if (!text.trim()) throw new HttpError(400, "invalid_request");
    const id =
      typeof body.id === "string" && body.id.trim() ? body.id : undefined;
    const requestedSessionId =
      typeof body.sessionId === "string" ? body.sessionId.trim() : "";
    if (closed) throw new HttpError(503, "server_closing");
    if (
      requestedSessionId &&
      !store.hasSession(requestedSessionId) &&
      !isBrowserGatewayAskAgentSessionId(requestedSessionId)
    ) {
      throw new HttpError(404, "ask_agent_session_not_found");
    }
    if (
      (id && store.hasActiveUserMessageId(id)) ||
      (id && store.hasQueuedMessageId(id))
    ) {
      sendJson(response, 200, { ok: true, snapshot: project().snapshot });
      return;
    }

    const busy = controller.hasActiveTurn();
    if (
      busy &&
      requestedSessionId &&
      requestedSessionId !== store.getActiveSessionId()
    ) {
      throw new HttpError(409, "ask_agent_turn_in_progress");
    }
    const queueId = id ?? `ask-agent-queued-${now()}-${Math.random()}`;
    if (busy) {
      if (!store.enqueueMessage({ id: queueId, text, source: "browser" })) {
        throw new HttpError(409, "queue_full");
      }
      void publishNow();
    }
    const previous = turnChain;
    let release!: () => void;
    turnChain = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await previous;
      if (busy) {
        // FIFO: this message is first in the queue now.
        store.dequeueMessage();
        if (auth.signal.aborted || closed) {
          void publishNow();
          return;
        }
      }
      if (
        requestedSessionId &&
        requestedSessionId !== store.getActiveSessionId()
      ) {
        store.targetSession(requestedSessionId, now());
      }
      const workspaceSessionId = await ensureWorkspaceSession(auth);
      store.appendUserMessage({ ...(id ? { id } : {}), text, now: now() });
      const assistant = store.startAssistantMessage({ now: now() });
      const turn = controller.beginTurn(assistant.id);
      if (!turn) throw new HttpError(409, "ask_agent_turn_in_progress");
      try {
        await publishNow();
        await runTurn({
          auth,
          workspaceSessionId,
          messageId: assistant.id,
          turn,
          text,
        });
      } finally {
        controller.completeTurn(turn);
      }
      const publication = await publishNow();
      if (!response.writableEnded && !response.destroyed) {
        sendJson(response, 200, { ok: true, snapshot: publication.snapshot });
      }
    } finally {
      release();
    }
  };

  const handleApproval = async (
    request: IncomingMessage,
    response: ServerResponse,
    auth: AssistantServerAuth,
  ) => {
    const body = await readJsonBody(request, undefined, auth.signal);
    if (typeof body.id !== "string" || typeof body.decision !== "string") {
      throw new HttpError(400, "invalid_request");
    }
    const pending = pendingInteraction;
    const approval = controller.getPendingApproval();
    if (!pending || !approval || approval.id !== body.id) {
      throw new HttpError(404, "approval_not_found");
    }
    await operations.answerInteraction(
      auth,
      projectId,
      pending.workspaceSessionId,
      {
        interactionId: pending.interactionId,
        interactionRevision: pending.interactionRevision,
        decision: ALLOW_DECISIONS.has(body.decision) ? "allow" : "deny",
      },
    );
    if (pendingInteraction === pending) pendingInteraction = undefined;
    controller.submitApproval({
      type: "decision",
      id: body.id,
      decision: body.decision,
    });
    const publication = await publishNow();
    sendJson(response, 200, { ok: true, snapshot: publication.snapshot });
  };

  const handleStop = async (
    response: ServerResponse,
    auth: AssistantServerAuth,
  ) => {
    const storeSessionId = store.getActiveSessionId();
    const publication = await controller.cancelActiveTurn(async (messageId) => {
      controller.finishAssistantError({
        messageId,
        text: "Stopped.",
        code: "model_stopped",
        retryable: false,
      });
      const workspaceSessionId = workspaceSessionFor(storeSessionId);
      if (workspaceSessionId) {
        await operations
          .cancel(auth, projectId, workspaceSessionId)
          .catch(() => undefined);
      }
      return publishNow();
    });
    sendJson(
      response,
      200,
      publication
        ? { ok: true, stopped: true, snapshot: publication.snapshot }
        : { ok: true, stopped: false },
    );
  };

  const readSessionId = async (
    request: IncomingMessage,
    auth: AssistantServerAuth,
  ) => {
    const body = await readJsonBody(request, undefined, auth.signal);
    const sessionId =
      typeof body.sessionId === "string" ? body.sessionId.trim() : "";
    return { body, sessionId };
  };

  const handleEvents = async (
    request: IncomingMessage,
    response: ServerResponse,
    auth: AssistantServerAuth,
  ) => {
    // A revocation during an earlier await has already fired the signal, and
    // a listener added now would never run.
    if (auth.signal.aborted) {
      throw new HttpError(401, "authentication_required");
    }
    const stop = () => sse.remove(response, "ended");
    auth.signal.addEventListener("abort", stop, { once: true });
    // Revocation is pushed through the signal; this also ends a stream
    // whose session expired while it stayed open.
    const timer = setInterval(() => {
      void auth.revalidate().then((current) => {
        if (!current.valid) stop();
      }, stop);
    }, SSE_REVALIDATE_MS);
    timer.unref?.();
    response.once("close", () => {
      clearInterval(timer);
      auth.signal.removeEventListener("abort", stop);
    });
    await sse.subscribe(request, response, async () =>
      toPublication(await publishNow()),
    );
    // Revoked while the first snapshot was being built.
    if (auth.signal.aborted) stop();
  };

  const handleRequest = async (
    request: IncomingMessage,
    response: ServerResponse,
    auth: AssistantServerAuth,
  ): Promise<boolean> => {
    const url = new URL(request.url ?? "/", "https://server.invalid");
    const pathname = url.pathname;
    const method = (request.method ?? "GET").toUpperCase();
    if (method === "GET" && pathname in GATEWAY_GET_RESPONSES) {
      sendJson(response, 200, GATEWAY_GET_RESPONSES[pathname]);
      return true;
    }
    if (!pathname.startsWith("/api/ask-agent/")) return false;
    await ensureLoaded(auth);

    if (method === "GET") {
      switch (pathname) {
        case "/api/ask-agent/session":
          sendJson(response, 200, snapshotResponse());
          return true;
        case "/api/ask-agent/sessions":
          sendJson(response, 200, { sessions: store.listSessions() });
          return true;
        case "/api/ask-agent/events":
          await handleEvents(request, response, auth);
          return true;
        case "/api/ask-agent/models":
          sendJson(response, 200, {
            models: store.getAvailableModels(),
            source: "cached",
          });
          return true;
      }
      if (pathname in EMPTY_GET_RESPONSES) {
        sendJson(response, 200, EMPTY_GET_RESPONSES[pathname]);
        return true;
      }
      if (UNAVAILABLE_GET_ROUTES.has(pathname)) {
        sendJson(response, 404, { error: "not_available" });
        return true;
      }
      throw new HttpError(404, "not_found");
    }
    if (method !== "POST") throw new HttpError(405, "method_not_allowed");

    switch (pathname) {
      case "/api/ask-agent/send":
        await handleSend(request, response, auth);
        return true;
      case "/api/ask-agent/approval":
        await handleApproval(request, response, auth);
        return true;
      case "/api/ask-agent/stop":
        await handleStop(response, auth);
        return true;
      case "/api/ask-agent/session/new": {
        const { sessionId } = await readSessionId(request, auth).catch(() => ({
          sessionId: "",
        }));
        if (sessionId && !isBrowserGatewayAskAgentSessionId(sessionId)) {
          throw new HttpError(400, "ask_agent_session_id_invalid");
        }
        store.createSession(now(), undefined, sessionId || undefined);
        const publication = await publishNow();
        sendJson(response, 200, { ok: true, snapshot: publication.snapshot });
        return true;
      }
      case "/api/ask-agent/session/load": {
        const { sessionId } = await readSessionId(request, auth);
        if (!sessionId || !store.loadSession(sessionId)) {
          throw new HttpError(404, "ask_agent_session_not_found");
        }
        const workspaceSessionId = workspaceSessionFor(sessionId);
        const model = workspaceSessionId
          ? sessionModels.get(workspaceSessionId)
          : undefined;
        if (model) store.setModel(modelKey(model));
        const publication = await publishNow();
        sendJson(response, 200, { ok: true, snapshot: publication.snapshot });
        return true;
      }
      case "/api/ask-agent/session/delete": {
        const { sessionId } = await readSessionId(request, auth);
        if (!sessionId || !store.hasSession(sessionId)) {
          throw new HttpError(404, "ask_agent_session_not_found");
        }
        if (
          controller.hasActiveTurn() &&
          sessionId === store.getActiveSessionId()
        ) {
          throw new HttpError(409, "ask_agent_turn_in_progress");
        }
        // Workspace sessions are durable; deleting hides it from the UI.
        const workspaceSessionId = workspaceSessionFor(sessionId);
        if (workspaceSessionId && !state.hidden.includes(workspaceSessionId)) {
          state.hidden.push(workspaceSessionId);
          await saveState();
        }
        store.deleteSession(sessionId, now());
        const publication = await publishNow();
        sendJson(response, 200, { ok: true, snapshot: publication.snapshot });
        return true;
      }
      case "/api/ask-agent/session/rename": {
        const { body, sessionId } = await readSessionId(request, auth);
        const title =
          typeof body.title === "string"
            ? body.title.trim().slice(0, MAX_TITLE_LENGTH)
            : "";
        if (!sessionId || !title || !store.renameSession(sessionId, title)) {
          throw new HttpError(400, "invalid_request");
        }
        const workspaceSessionId = workspaceSessionFor(sessionId);
        if (workspaceSessionId) {
          state.titles[workspaceSessionId] = title;
          await saveState();
        }
        const publication = await publishNow();
        sendJson(response, 200, { ok: true, snapshot: publication.snapshot });
        return true;
      }
      case "/api/ask-agent/session/copy-first-prompt": {
        const { sessionId } = await readSessionId(request, auth);
        const prompt = sessionId ? store.getFirstPrompt(sessionId) : null;
        if (!prompt) throw new HttpError(404, "ask_agent_prompt_not_found");
        sendJson(response, 200, { ok: true, prompt });
        return true;
      }
      case "/api/ask-agent/model": {
        const body = await readJsonBody(request, undefined, auth.signal);
        const model = typeof body.model === "string" ? body.model.trim() : "";
        if (!model || !store.setModel(model)) {
          throw new HttpError(400, "invalid_model");
        }
        const publication = await publishNow();
        sendJson(response, 200, { ok: true, snapshot: publication.snapshot });
        return true;
      }
      case "/api/ask-agent/thinking": {
        const body = await readJsonBody(request, undefined, auth.signal);
        const effort = typeof body.effort === "string" ? body.effort : "";
        if (!isReasoningEffort(effort) || !store.setReasoningEffort(effort)) {
          throw new HttpError(400, "invalid_reasoning_effort");
        }
        const publication = await publishNow();
        sendJson(response, 200, { ok: true, snapshot: publication.snapshot });
        return true;
      }
      case "/api/ask-agent/log":
        // Client diagnostics are not collected by this server.
        request.resume();
        sendJson(response, 200, { ok: true });
        return true;
    }
    request.resume();
    sendJson(response, 501, { error: "not_supported" });
    return true;
  };

  return {
    handleRequest,
    theme,
    async close() {
      closed = true;
      await controller.dispose();
      sse.dispose();
      await stateWrite.catch(() => undefined);
    },
  };
}

async function readState(file: string): Promise<BridgeState> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { aliases: {}, titles: {}, hidden: [] };
    }
    throw error;
  }
  const parsed = JSON.parse(raw) as Partial<BridgeState> & {
    version?: unknown;
  };
  if (parsed.version !== 1) {
    throw new Error(`Unsupported Ask Agent state file: ${file}`);
  }
  return {
    aliases: stringRecord(parsed.aliases),
    titles: stringRecord(parsed.titles),
    hidden: Array.isArray(parsed.hidden)
      ? parsed.hidden.filter((id): id is string => typeof id === "string")
      : [],
  };
}

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

const REASONING_EFFORTS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

function isReasoningEffort(
  value: string,
): value is (typeof REASONING_EFFORTS)[number] {
  return (REASONING_EFFORTS as readonly string[]).includes(value);
}

function hasItems(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

function deriveTitle(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return "Ask Agent";
  return normalized.length > 60 ? `${normalized.slice(0, 57)}…` : normalized;
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? "";
  } catch {
    return "";
  }
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function describeError(error: unknown): string {
  if (error instanceof HttpError) {
    switch (error.code) {
      case "session_busy":
        return "This chat is busy with another turn. Try again when it finishes.";
      case "interaction_pending":
        return "This chat is waiting for an approval.";
      case "authentication_required":
        return "Your sign-in expired. Reload the page and pair again.";
      default:
        return `The assistant could not start this turn (${error.code}).`;
    }
  }
  return "The assistant could not start this turn.";
}
