import {
  projectEmbeddedAgentSessionSnapshot,
  projectEmbeddedAgentTurnEvent,
  type AgentModelReference,
  type AgentTurnEvent,
  type AgentTurnResult,
} from "@agentlink/core";
import type { WorkspaceHost } from "@agentlink/workspace-host";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { AssistantServerAuth } from "./assistantServer.js";
import { HttpError, readJsonBody, sendJson, stringField } from "./httpJson.js";
import { singleHeader } from "./requestGuard.js";
import type { AssistantServerModelChoice } from "./serverConfig.js";
import type { ServerAccessStore } from "./ServerAccessStore.js";
import {
  SessionEventHub,
  type AssistantTaskOperation,
  type SequencedSessionEvent,
} from "./SessionEventHub.js";

const PROJECT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/u;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;
const MAX_TURN_TEXT_LENGTH = 100_000;
const MAX_TURN_BODY_BYTES = 512 * 1024;
const DEFAULT_HEARTBEAT_MS = 15_000;
/**
 * How long an event stream may stay backpressured before the server drops
 * it. The client reconnects with its cursor and resumes from the log.
 */
const DEFAULT_STREAM_STALL_TIMEOUT_MS = 30_000;
const ROUTE_PATTERN =
  /^\/api\/projects\/([^/]+)(?:\/sessions(?:\/([^/]+)(?:\/(turns|interaction|cancel|events|model))?)?)?$/u;
const MODELS_ROUTE_PATTERN = /^\/api\/projects\/([^/]+)\/models$/u;
const AGENTS_ROUTE_PATTERN =
  /^\/api\/projects\/([^/]+)\/sessions\/([^/]+)\/agents(?:\/([^/]+)\/(steer|stop|approval))?$/u;
const MAX_STEERING_BYTES = 64 * 1024;
const MAX_STOP_REASON_LENGTH = 4_096;
const MODEL_ROLE_PATTERN = /^[a-z][a-z0-9-]{0,31}$/u;

/**
 * The workspace host operations the server uses. The host acts as its own
 * project principal; the server principal never reaches it.
 */
export type AssistantWorkspaceHost = Pick<
  WorkspaceHost,
  | "createSession"
  | "listSessions"
  | "readSession"
  | "setSessionModel"
  | "runTurn"
  | "resumeInteraction"
  | "cancel"
  | "isBackgroundSession"
  | "listBackgroundAgents"
  | "steerBackgroundAgent"
  | "stopBackgroundAgent"
  | "respondToBackgroundApproval"
>;

export interface AssistantProjectMount {
  /** Stable URL identifier: lowercase letters, digits, and dashes. */
  readonly projectId: string;
  readonly label?: string;
  readonly host: AssistantWorkspaceHost;
}

/**
 * `read`: list, snapshot, events. `write`: create sessions, run and cancel
 * turns. `approve`: answer a pending tool approval.
 */
export type AssistantProjectAccess = "read" | "write" | "approve";

export type AuthorizeAssistantProject = (request: {
  readonly principal: AssistantServerAuth["principal"];
  readonly projectId: string;
  readonly access: AssistantProjectAccess;
}) => boolean | Promise<boolean>;

/**
 * The models a client may choose for a session. Choices are checked against
 * `available`; the engine itself stores any model reference it is given.
 */
export interface AssistantModelSelection {
  readonly available: readonly AssistantServerModelChoice[];
  readonly defaultModel: AgentModelReference;
  /** Named roles (for example `review`) mapped to one available model. */
  readonly roles?: Readonly<Record<string, AgentModelReference | undefined>>;
}

export interface CreateAssistantWorkspaceRoutesOptions {
  readonly projects: readonly AssistantProjectMount[];
  /** Required explicit mapping from the server principal to project access. */
  readonly authorizeProject: AuthorizeAssistantProject;
  readonly models: AssistantModelSelection;
  readonly maxRetainedEvents?: number;
  /** Event stream keepalive and session revalidation interval. */
  readonly heartbeatMs?: number;
  /** How long a backpressured event stream may stall before it is dropped. */
  readonly streamStallTimeoutMs?: number;
}

export interface AssistantWorkspaceRoutes {
  readonly handleRequest: (
    request: IncomingMessage,
    response: ServerResponse,
    auth: AssistantServerAuth,
  ) => Promise<boolean>;
  readonly events: SessionEventHub;
  /**
   * Tell clients of the parent session that a background child is waiting
   * for approval. Wire to the host's `background.onApprovalAvailable`.
   */
  notifyAgentApproval(request: {
    readonly projectId: string;
    readonly parentSessionId: string;
    readonly childSessionId: string;
  }): void;
  /** Resolves once no server-owned task is running for the session. */
  whenIdle(projectId: string, sessionId: string): Promise<void>;
  /** Abort running tasks and wait for them to settle. */
  close(): Promise<void>;
}

interface RunningTask {
  readonly taskId: string;
  readonly operation: AssistantTaskOperation;
  readonly controller: AbortController;
  readonly done: Promise<void>;
}

/**
 * Grants every access level to the server's single bootstrapped owner, and
 * nothing to any other principal. Only mounted projects are reachable.
 */
export function ownerProjectAccess(
  store: Pick<ServerAccessStore, "ownerId">,
): AuthorizeAssistantProject {
  return ({ principal }) =>
    principal.tenantId === "agentlink-server" &&
    store.ownerId !== undefined &&
    principal.subjectId === store.ownerId;
}

export function createAssistantWorkspaceRoutes(
  options: CreateAssistantWorkspaceRoutesOptions,
): AssistantWorkspaceRoutes {
  const projects = new Map<string, AssistantProjectMount>();
  for (const mount of options.projects) {
    if (!PROJECT_ID_PATTERN.test(mount.projectId)) {
      throw new Error(`Invalid project ID: ${mount.projectId}`);
    }
    if (projects.has(mount.projectId)) {
      throw new Error(`Duplicate project ID: ${mount.projectId}`);
    }
    projects.set(mount.projectId, mount);
  }
  const models = options.models;
  const isAvailable = (model: AgentModelReference) =>
    models.available.some(
      (choice) =>
        choice.providerId === model.providerId &&
        choice.modelId === model.modelId,
    );
  if (!isAvailable(models.defaultModel)) {
    throw new Error("The default model must be one of the available models");
  }
  const roles = new Map<string, AgentModelReference>();
  for (const [role, model] of Object.entries(models.roles ?? {})) {
    if (!model) continue;
    if (!MODEL_ROLE_PATTERN.test(role)) {
      throw new Error(`Invalid model role: ${role}`);
    }
    if (!isAvailable(model)) {
      throw new Error(`Model role "${role}" must use an available model`);
    }
    roles.set(role, { providerId: model.providerId, modelId: model.modelId });
  }
  /**
   * `{ model: { providerId, modelId } }` or `{ role: "review" }`, never both.
   * Undefined when the body names neither.
   */
  const requestedModel = (
    body: Record<string, unknown>,
  ): AgentModelReference | undefined => {
    const { model, role } = body;
    if (model !== undefined && role !== undefined) {
      throw new HttpError(400, "model_selection_invalid");
    }
    if (role !== undefined) {
      const selected = typeof role === "string" ? roles.get(role) : undefined;
      if (!selected) throw new HttpError(400, "model_role_not_configured");
      return { ...selected };
    }
    if (model === undefined) return undefined;
    if (
      !model ||
      typeof model !== "object" ||
      Array.isArray(model) ||
      Object.keys(model).some(
        (key) => key !== "providerId" && key !== "modelId",
      )
    ) {
      throw new HttpError(400, "model_invalid");
    }
    const { providerId, modelId } = model as Record<string, unknown>;
    if (typeof providerId !== "string" || typeof modelId !== "string") {
      throw new HttpError(400, "model_invalid");
    }
    const reference = { providerId, modelId };
    if (!isAvailable(reference)) {
      throw new HttpError(400, "model_not_available");
    }
    return reference;
  };
  const effectiveModel = (selected: AgentModelReference | undefined) => {
    const model = selected ?? models.defaultModel;
    return { providerId: model.providerId, modelId: model.modelId };
  };

  const hub = new SessionEventHub(options.maxRetainedEvents);
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const streamStallTimeoutMs =
    options.streamStallTimeoutMs ?? DEFAULT_STREAM_STALL_TIMEOUT_MS;
  const tasks = new Map<string, RunningTask>();
  let closing = false;

  const authorize = async (
    auth: AssistantServerAuth,
    projectId: string,
    access: AssistantProjectAccess,
  ): Promise<AssistantProjectMount> => {
    const mount = projects.get(projectId);
    if (!mount) throw new HttpError(404, "project_not_found");
    if (
      !(await options.authorizeProject({
        principal: auth.principal,
        projectId,
        access,
      }))
    ) {
      throw new HttpError(403, "project_access_denied");
    }
    return mount;
  };

  const readSnapshot = async (
    mount: AssistantProjectMount,
    sessionId: string,
  ) => {
    // Background children are reached only through their parent's agents.
    if (mount.host.isBackgroundSession(sessionId)) {
      throw new HttpError(404, "session_not_found");
    }
    try {
      return await mount.host.readSession(sessionId);
    } catch (error) {
      if (errorCode(error) === "session_not_found") {
        throw new HttpError(404, "session_not_found");
      }
      throw error;
    }
  };

  const startTask = (
    projectId: string,
    sessionId: string,
    operation: AssistantTaskOperation,
    auth: AssistantServerAuth,
    run: (
      signal: AbortSignal,
      onEvent: (event: AgentTurnEvent) => void,
    ) => Promise<AgentTurnResult>,
  ): string => {
    const key = sessionKey(projectId, sessionId);
    const taskId = randomUUID();
    // Deliberately not `auth.signal`: closing the browser must not stop work.
    const controller = new AbortController();
    hub.publish(key, {
      kind: "task",
      state: "started",
      taskId,
      operation,
      actor: {
        subjectId: auth.principal.subjectId,
        deviceId: auth.session.deviceId,
      },
    });
    const done = (async () => {
      try {
        const result = await run(controller.signal, (event) => {
          hub.publish(key, {
            kind: "turn",
            event: projectEmbeddedAgentTurnEvent(event),
          });
        });
        hub.publish(key, {
          kind: "task",
          state: "finished",
          taskId,
          status: result.status,
        });
      } catch (error) {
        hub.publish(key, {
          kind: "task",
          state: "failed",
          taskId,
          error: errorCode(error) ?? "task_failed",
        });
      } finally {
        tasks.delete(key);
      }
    })();
    tasks.set(key, { taskId, operation, controller, done });
    return taskId;
  };

  const assertStartable = (key: string) => {
    if (closing) throw new HttpError(503, "server_closing");
    if (tasks.has(key)) throw new HttpError(409, "session_busy");
  };

  /**
   * Final server-side check immediately before a mutation takes effect. The
   * request-time auth snapshot can be stale after a slow body or snapshot
   * read: the session may since have been revoked, or (for approvals) the
   * reauthentication window may have lapsed.
   */
  const assertStillAuthorized = async (
    auth: AssistantServerAuth,
    requireRecent: boolean,
  ) => {
    const current = await auth.revalidate();
    if (!current.valid) throw new HttpError(401, "authentication_required");
    if (requireRecent && !current.recentlyAuthenticated) {
      throw new HttpError(401, "reauthentication_required");
    }
  };

  const handleRequest = async (
    request: IncomingMessage,
    response: ServerResponse,
    auth: AssistantServerAuth,
  ): Promise<boolean> => {
    const url = new URL(request.url ?? "/", "https://server.invalid");
    const method = (request.method ?? "GET").toUpperCase();

    if (url.pathname === "/api/projects" && method === "GET") {
      const visible = [];
      for (const mount of projects.values()) {
        if (
          await options.authorizeProject({
            principal: auth.principal,
            projectId: mount.projectId,
            access: "read",
          })
        ) {
          visible.push({ projectId: mount.projectId, label: mount.label });
        }
      }
      sendJson(response, 200, { projects: visible });
      return true;
    }

    const modelsMatch = MODELS_ROUTE_PATTERN.exec(url.pathname);
    if (modelsMatch) {
      if (method !== "GET") throw new HttpError(405, "method_not_allowed");
      await authorize(auth, decodeURIComponent(modelsMatch[1]!), "read");
      sendJson(response, 200, {
        models: models.available,
        defaultModel: effectiveModel(undefined),
        roles: Object.fromEntries(roles),
      });
      return true;
    }

    const agentsMatch = AGENTS_ROUTE_PATTERN.exec(url.pathname);
    if (agentsMatch) {
      await handleAgents(
        request,
        response,
        auth,
        method,
        decodeURIComponent(agentsMatch[1]!),
        agentsMatch[2]!,
        agentsMatch[3],
        agentsMatch[4] as "steer" | "stop" | "approval" | undefined,
      );
      return true;
    }

    const match = ROUTE_PATTERN.exec(url.pathname);
    if (!match) return false;
    const projectId = decodeURIComponent(match[1]!);
    const rawSessionId = match[2];
    const operation = match[3];
    const isSessionsCollection =
      rawSessionId === undefined && url.pathname.endsWith("/sessions");

    if (rawSessionId === undefined && !isSessionsCollection) {
      if (method !== "GET") throw new HttpError(405, "method_not_allowed");
      const mount = await authorize(auth, projectId, "read");
      sendJson(response, 200, {
        projectId: mount.projectId,
        label: mount.label,
      });
      return true;
    }

    if (isSessionsCollection) {
      if (method === "GET") {
        const mount = await authorize(auth, projectId, "read");
        const sessions = await mount.host.listSessions();
        sendJson(response, 200, {
          sessions: sessions.map((session) => ({
            sessionId: session.sessionId,
            updatedAt: session.updatedAt,
            state: session.state,
            model: effectiveModel(session.model),
            background: mount.host.isBackgroundSession(session.sessionId),
          })),
        });
        return true;
      }
      if (method === "POST") {
        const mount = await authorize(auth, projectId, "write");
        // The body is optional: no body creates a default-model session.
        const model = hasRequestBody(request)
          ? requestedModel(await readJsonBody(request, undefined, auth.signal))
          : undefined;
        if (closing) throw new HttpError(503, "server_closing");
        await assertStillAuthorized(auth, false);
        const created = await mount.host.createSession(
          model ? { model } : undefined,
        );
        sendJson(response, 201, {
          sessionId: created.sessionId,
          model: effectiveModel(model),
        });
        return true;
      }
      throw new HttpError(405, "method_not_allowed");
    }

    const sessionId = rawSessionId!;
    if (!SESSION_ID_PATTERN.test(sessionId)) {
      throw new HttpError(404, "session_not_found");
    }
    const key = sessionKey(projectId, sessionId);

    if (operation === undefined) {
      if (method !== "GET") throw new HttpError(405, "method_not_allowed");
      const mount = await authorize(auth, projectId, "read");
      // Read the cursor first: events after it may already be in the
      // snapshot, but none can be missed.
      const sequence = hub.latestSequence(key);
      const hydration = await readSnapshot(mount, sessionId);
      const task = tasks.get(key);
      sendJson(response, 200, {
        projectId,
        session: projectEmbeddedAgentSessionSnapshot(hydration),
        model: effectiveModel(hydration.record.selectedModel),
        background: mount.host.isBackgroundSession(sessionId),
        task: task ? { taskId: task.taskId, operation: task.operation } : null,
        events: { epoch: hub.epoch, sequence },
      });
      return true;
    }

    if (operation === "events") {
      if (method !== "GET") throw new HttpError(405, "method_not_allowed");
      const mount = await authorize(auth, projectId, "read");
      await readSnapshot(mount, sessionId);
      streamEvents(request, response, auth, key, url);
      return true;
    }

    if (method !== "POST") throw new HttpError(405, "method_not_allowed");

    if (operation === "turns") {
      const mount = await authorize(auth, projectId, "write");
      const body = await readJsonBody(
        request,
        MAX_TURN_BODY_BYTES,
        auth.signal,
      );
      const text = stringField(body, "text");
      if (!text.trim() || text.length > MAX_TURN_TEXT_LENGTH) {
        throw new HttpError(400, "text_invalid");
      }
      assertStartable(key);
      if (mount.host.isBackgroundSession(sessionId)) {
        throw new HttpError(404, "session_not_found");
      }
      const snapshot = projectEmbeddedAgentSessionSnapshot(
        await readSnapshot(mount, sessionId),
      );
      if (snapshot.pendingInteraction) {
        throw new HttpError(409, "interaction_pending");
      }
      // Matches the engine: an interrupted (cancelled, failed, or recovered)
      // turn leaves the session runnable.
      if (snapshot.phase !== "idle" && snapshot.phase !== "interrupted") {
        throw new HttpError(409, "session_busy");
      }
      await assertStillAuthorized(auth, false);
      assertStartable(key);
      const taskId = startTask(
        projectId,
        sessionId,
        "turn",
        auth,
        (signal, onEvent) =>
          mount.host.runTurn(sessionId, text, { signal, onEvent }),
      );
      sendJson(response, 202, { taskId });
      return true;
    }

    if (operation === "interaction") {
      const mount = await authorize(auth, projectId, "approve");
      if (!auth.recentlyAuthenticated) {
        throw new HttpError(401, "reauthentication_required");
      }
      const body = await readJsonBody(request, undefined, auth.signal);
      const interactionId = stringField(body, "interactionId");
      const interactionRevision = stringField(body, "interactionRevision");
      const decision = stringField(body, "decision");
      if (decision !== "allow" && decision !== "deny") {
        throw new HttpError(400, "decision_invalid");
      }
      assertStartable(key);
      const pending = (await readSnapshot(mount, sessionId)).pendingInteraction;
      // Bind the decision to the exact request the owner saw.
      if (
        !pending ||
        pending.request.interactionId !== interactionId ||
        pending.interactionRevision !== interactionRevision
      ) {
        throw new HttpError(409, "stale_interaction");
      }
      await assertStillAuthorized(auth, true);
      assertStartable(key);
      const taskId = startTask(
        projectId,
        sessionId,
        "resume",
        auth,
        (signal, onEvent) =>
          // The host re-checks this binding and passes it to the engine's
          // atomic resume, so the decision cannot reach a replacement.
          mount.host.resumeInteraction(sessionId, decision, {
            signal,
            onEvent,
            expected: { interactionId, interactionRevision },
          }),
      );
      sendJson(response, 202, { taskId });
      return true;
    }

    if (operation === "model") {
      const mount = await authorize(auth, projectId, "write");
      const body = await readJsonBody(request, undefined, auth.signal);
      const model = requestedModel(body);
      if (!model) throw new HttpError(400, "model_required");
      assertStartable(key);
      if (mount.host.isBackgroundSession(sessionId)) {
        throw new HttpError(404, "session_not_found");
      }
      const snapshot = projectEmbeddedAgentSessionSnapshot(
        await readSnapshot(mount, sessionId),
      );
      if (snapshot.pendingInteraction) {
        throw new HttpError(409, "interaction_pending");
      }
      if (snapshot.phase !== "idle" && snapshot.phase !== "interrupted") {
        throw new HttpError(409, "session_busy");
      }
      await assertStillAuthorized(auth, false);
      assertStartable(key);
      try {
        await mount.host.setSessionModel(sessionId, model);
      } catch (error) {
        const code = errorCode(error);
        if (code === "session_not_found") {
          throw new HttpError(404, "session_not_found");
        }
        if (
          code === "session_busy" ||
          code === "turn_lease_held" ||
          code === "turn_lease_lost" ||
          code === "session_revision_conflict"
        ) {
          throw new HttpError(409, "session_busy");
        }
        throw error;
      }
      sendJson(response, 200, { model: effectiveModel(model) });
      return true;
    }

    // operation === "cancel"
    const mount = await authorize(auth, projectId, "write");
    await assertStillAuthorized(auth, false);
    const task = tasks.get(key);
    if (task) {
      task.controller.abort(new Error("cancelled_by_owner"));
    } else {
      await readSnapshot(mount, sessionId);
      await mount.host.cancel(sessionId, "cancelled_by_owner");
    }
    sendJson(response, 202, { cancelled: true });
    return true;
  };

  /**
   * Background children of one foreground session. The parent session is
   * the unit of access: a child is only reachable through the parent that
   * owns it, and the host re-checks that ownership.
   */
  const handleAgents = async (
    request: IncomingMessage,
    response: ServerResponse,
    auth: AssistantServerAuth,
    method: string,
    projectId: string,
    sessionId: string,
    childSessionId: string | undefined,
    operation: "steer" | "stop" | "approval" | undefined,
  ) => {
    if (!SESSION_ID_PATTERN.test(sessionId)) {
      throw new HttpError(404, "session_not_found");
    }
    if (
      childSessionId !== undefined &&
      !SESSION_ID_PATTERN.test(childSessionId)
    ) {
      throw new HttpError(404, "agent_not_found");
    }
    const key = sessionKey(projectId, sessionId);
    const actor = {
      subjectId: auth.principal.subjectId,
      deviceId: auth.session.deviceId,
    };
    const callAgent = async <T>(run: () => Promise<T>): Promise<T> => {
      try {
        return await run();
      } catch (error) {
        throw agentError(error);
      }
    };

    if (operation === undefined) {
      if (method !== "GET") throw new HttpError(405, "method_not_allowed");
      const mount = await authorize(auth, projectId, "read");
      await readSnapshot(mount, sessionId);
      const agents = await callAgent(async () =>
        mount.host.listBackgroundAgents(sessionId),
      );
      sendJson(response, 200, { agents });
      return;
    }
    if (method !== "POST") throw new HttpError(405, "method_not_allowed");
    const target = {
      callerSessionId: sessionId,
      childSessionId: childSessionId!,
    };

    if (operation === "steer") {
      const mount = await authorize(auth, projectId, "write");
      const body = await readJsonBody(request, 128 * 1024, auth.signal);
      const message = stringField(body, "message");
      // The supervisor bounds steering by UTF-8 bytes.
      if (
        !message.trim() ||
        Buffer.byteLength(message, "utf8") > MAX_STEERING_BYTES
      ) {
        throw new HttpError(400, "message_invalid");
      }
      if (closing) throw new HttpError(503, "server_closing");
      await readSnapshot(mount, sessionId);
      await assertStillAuthorized(auth, false);
      const result = await callAgent(() =>
        mount.host.steerBackgroundAgent({ ...target, message }),
      );
      hub.publish(key, {
        kind: "agent",
        state: "steered",
        childSessionId: target.childSessionId,
        actor,
      });
      sendJson(response, 202, result);
      return;
    }

    if (operation === "stop") {
      const mount = await authorize(auth, projectId, "write");
      let reason: string | undefined;
      if (hasRequestBody(request)) {
        const body = await readJsonBody(request, undefined, auth.signal);
        const value = body.reason;
        if (value !== undefined) {
          if (
            typeof value !== "string" ||
            !value.trim() ||
            value.length > MAX_STOP_REASON_LENGTH
          ) {
            throw new HttpError(400, "reason_invalid");
          }
          reason = value;
        }
      }
      await readSnapshot(mount, sessionId);
      await assertStillAuthorized(auth, false);
      const agent = await callAgent(() =>
        mount.host.stopBackgroundAgent({
          ...target,
          reason: reason ?? "cancelled_by_owner",
        }),
      );
      hub.publish(key, {
        kind: "agent",
        state: "stopped",
        childSessionId: target.childSessionId,
        actor,
      });
      sendJson(response, 200, { agent });
      return;
    }

    // operation === "approval": same bar as a foreground approval.
    const mount = await authorize(auth, projectId, "approve");
    if (!auth.recentlyAuthenticated) {
      throw new HttpError(401, "reauthentication_required");
    }
    const body = await readJsonBody(request, undefined, auth.signal);
    const interactionId = stringField(body, "interactionId");
    const decision = stringField(body, "decision");
    if (decision !== "allow" && decision !== "deny") {
      throw new HttpError(400, "decision_invalid");
    }
    if (closing) throw new HttpError(503, "server_closing");
    await readSnapshot(mount, sessionId);
    await assertStillAuthorized(auth, true);
    // The supervisor binds the decision to this exact pending interaction.
    const agent = await callAgent(() =>
      mount.host.respondToBackgroundApproval({
        ...target,
        interactionId,
        decision,
      }),
    );
    hub.publish(key, {
      kind: "agent",
      state: "approval_answered",
      childSessionId: target.childSessionId,
      actor,
    });
    sendJson(response, 200, { agent });
  };

  const streamEvents = (
    request: IncomingMessage,
    response: ServerResponse,
    auth: AssistantServerAuth,
    key: string,
    url: URL,
  ) => {
    const cursor = readCursor(
      url,
      singleHeader(request.headers["last-event-id"]),
    );
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "x-accel-buffering": "no",
    });
    let open = true;
    let subscription: ReturnType<SessionEventHub["subscribe"]> | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let stallTimer: ReturnType<typeof setTimeout> | undefined;
    // Backpressure: once a write is buffered, stop writing until `drain`,
    // then catch up from the hub's retained log. Per-stream memory stays at
    // one event beyond the socket buffer regardless of how fast events
    // arrive. A reader that stays stalled is dropped and can reconnect.
    let lagging = false;
    let lastSent = 0;
    const finish = () => {
      if (!open) return;
      open = false;
      if (heartbeat) clearInterval(heartbeat);
      if (stallTimer) clearTimeout(stallTimer);
      subscription?.unsubscribe();
      auth.signal.removeEventListener("abort", finish);
      response.off("drain", catchUp);
      response.end();
    };
    const write = (chunk: string) => {
      if (!open || lagging) return;
      if (response.write(chunk)) return;
      lagging = true;
      response.once("drain", catchUp);
      stallTimer = setTimeout(() => {
        finish();
        response.destroy();
      }, streamStallTimeoutMs);
      stallTimer.unref?.();
    };
    const send = (event: SequencedSessionEvent) => {
      if (!open || lagging || event.sequence <= lastSent) return;
      lastSent = event.sequence;
      write(
        `id: ${hub.epoch}:${event.sequence}\nevent: session\ndata: ${JSON.stringify(event)}\n\n`,
      );
    };
    const sendControl = (name: string, data: unknown) =>
      write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
    function catchUp() {
      if (!open) return;
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = undefined;
      lagging = false;
      const missed = hub.read(key, lastSent);
      if (missed.reset) {
        lastSent = missed.sequence;
        sendControl("reset", {
          reason: "cursor_unavailable",
          epoch: hub.epoch,
          sequence: missed.sequence,
        });
        return;
      }
      for (const event of missed.events) {
        if (lagging) return;
        send(event);
      }
    }
    if (cursor === undefined) {
      // No cursor: live delivery only, after the client reads a snapshot.
      lastSent = hub.latestSequence(key);
      subscription = hub.subscribe(key, lastSent, send);
    } else if (cursor.epoch !== hub.epoch) {
      lastSent = hub.latestSequence(key);
      subscription = hub.subscribe(key, lastSent, send);
      sendControl("reset", {
        reason: "epoch_changed",
        epoch: hub.epoch,
        sequence: lastSent,
      });
    } else {
      subscription = hub.subscribe(key, cursor.after, send);
      lastSent = subscription.reset ? subscription.sequence : cursor.after;
    }
    sendControl("ready", {
      epoch: hub.epoch,
      sequence: hub.latestSequence(key),
    });
    if (subscription.reset) {
      sendControl("reset", {
        reason: "cursor_unavailable",
        epoch: hub.epoch,
        sequence: subscription.sequence,
      });
    } else {
      for (const event of subscription.replay) {
        if (lagging) break;
        send(event);
      }
    }

    // Check-only: an unattended stream must not extend the session's idle
    // window, so the session still expires while a tab is left open.
    heartbeat = setInterval(() => {
      void auth
        .revalidate()
        .then(
          (current) => (current.valid ? write(": keepalive\n\n") : finish()),
          finish,
        );
    }, heartbeatMs);
    heartbeat.unref?.();
    // Revocation (or the connection closing) ends only this subscription.
    auth.signal.addEventListener("abort", finish, { once: true });
    if (auth.signal.aborted) finish();
    response.once("close", finish);
  };

  return {
    handleRequest,
    events: hub,
    notifyAgentApproval({ projectId, parentSessionId, childSessionId }) {
      if (!projects.has(projectId)) return;
      hub.publish(sessionKey(projectId, parentSessionId), {
        kind: "agent",
        state: "approval_required",
        childSessionId,
      });
    },
    async whenIdle(projectId, sessionId) {
      await tasks.get(sessionKey(projectId, sessionId))?.done;
    },
    async close() {
      closing = true;
      const running = [...tasks.values()];
      for (const task of running) {
        task.controller.abort(new Error("server_closing"));
      }
      await Promise.all(running.map((task) => task.done));
    },
  };
}

/**
 * Map a background supervisor failure to a public error. The supervisor
 * reports failures as `background_*` messages, not error codes.
 */
function agentError(error: unknown): unknown {
  const message = error instanceof Error ? error.message : undefined;
  switch (message) {
    case "background_child_not_found":
    case "background_child_not_owned":
      return new HttpError(404, "agent_not_found");
    case "background_child_not_running":
      return new HttpError(409, "agent_not_running");
    case "background_approval_not_current":
      return new HttpError(409, "stale_interaction");
    case "background_steering_queue_full":
      return new HttpError(409, "steering_queue_full");
    case "background_grandchildren_not_supported":
    case "background_child_requires_supervisor_control":
      return new HttpError(404, "session_not_found");
    case "Background writers are not enabled":
      return new HttpError(404, "agents_not_enabled");
    default:
      return error;
  }
}

/** True when the request declares a body (non-zero length or chunked). */
function hasRequestBody(request: IncomingMessage): boolean {
  if (request.headers["transfer-encoding"] !== undefined) return true;
  const length = singleHeader(request.headers["content-length"]);
  return length !== undefined && length !== "0";
}

function sessionKey(projectId: string, sessionId: string): string {
  return `${projectId}\u0000${sessionId}`;
}

function readCursor(
  url: URL,
  lastEventId: string | undefined,
): { readonly epoch: string; readonly after: number } | undefined {
  const epoch = url.searchParams.get("epoch");
  const after = url.searchParams.get("after");
  if (epoch !== null && after !== null) {
    return { epoch, after: parseSequence(after) };
  }
  if (lastEventId) {
    const separator = lastEventId.lastIndexOf(":");
    if (separator > 0) {
      return {
        epoch: lastEventId.slice(0, separator),
        after: parseSequence(lastEventId.slice(separator + 1)),
      };
    }
  }
  return undefined;
}

function parseSequence(value: string): number {
  return /^\d{1,15}$/u.test(value) ? Number(value) : -1;
}

/** Public error code only; never a message that could carry private detail. */
function errorCode(error: unknown): string | undefined {
  const code =
    error && typeof error === "object" && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
  return typeof code === "string" && /^[a-z0-9_:.-]{1,100}$/iu.test(code)
    ? code
    : undefined;
}
