import {
  projectEmbeddedAgentSessionSnapshot,
  projectEmbeddedAgentTurnEvent,
  type AgentModelReference,
  type AgentTurnEvent,
  type AgentTurnResult,
} from "@agentlink/core";
import type { CoreReasoningEffort } from "@agentlink/protocol";
import type {
  WorkspaceBackgroundChange,
  WorkspaceBackgroundRecord,
  WorkspaceHost,
} from "@agentlink/workspace-host";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { AssistantServerAuth } from "./assistantServer.js";
import { HttpError, readJsonBody, sendJson, stringField } from "./httpJson.js";
import { singleHeader } from "./requestGuard.js";
import type { AssistantServerModelChoice } from "./serverConfig.js";
import type { SessionEventLog } from "./FileSessionEventLog.js";
import type { ServerAccessStore } from "./ServerAccessStore.js";
import {
  SESSION_APPROVAL_MODES,
  type SessionApprovalMode,
  type SessionApprovalModes,
} from "./SessionApprovalModes.js";
import {
  MAX_TRANSCRIPT_TEXT_LENGTH,
  projectSessionTranscript,
} from "./sessionTranscript.js";
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
  /^\/api\/projects\/([^/]+)(?:\/sessions(?:\/([^/]+)(?:\/(turns|interaction|cancel|events|model|approval-mode))?)?)?$/u;
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
  | "setSessionReasoningEffort"
  | "runTurn"
  | "resumeInteraction"
  | "cancel"
  | "isBackgroundSession"
  | "listBackgroundAgents"
  | "readBackgroundAgentSession"
  | "steerBackgroundAgent"
  | "stopBackgroundAgent"
  | "respondToBackgroundApproval"
>;

export interface AssistantProjectMount {
  /** Stable URL identifier: lowercase letters, digits, and dashes. */
  readonly projectId: string;
  readonly label?: string;
  readonly host: AssistantWorkspaceHost;
  /**
   * Not listed in `GET /api/projects` (a coding task's own clone). Its
   * sessions are still reachable by ID, with the same authorization.
   */
  readonly hidden?: boolean;
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
  /**
   * Keeps session events across restarts. The caller owns it and closes it
   * after these routes and the hosts have stopped. In memory when absent.
   */
  readonly eventLog?: SessionEventLog;
  /** Event stream keepalive and session revalidation interval. */
  readonly heartbeatMs?: number;
  /** How long a backpressured event stream may stall before it is dropped. */
  readonly streamStallTimeoutMs?: number;
  /**
   * Per-session approval modes, which the hosts also consult. Without it
   * every session reports `ask`, matching hosts given no grant.
   */
  readonly approvalModes?: SessionApprovalModes;
}

/**
 * Programmatic session operations with the same authorization, state checks,
 * and event publication as the HTTP routes, for in-process surfaces such as
 * the shared Ask Agent UI. Failures are `HttpError`s.
 */
export interface AssistantSessionOperations {
  /** The event hub key for one project session. */
  sessionKey(projectId: string, sessionId: string): string;
  listSessions(
    auth: AssistantServerAuth,
    projectId: string,
  ): Promise<
    ReadonlyArray<{ readonly sessionId: string; readonly updatedAt: number }>
  >;
  readSession(
    auth: AssistantServerAuth,
    projectId: string,
    sessionId: string,
  ): Promise<{
    readonly messages: readonly unknown[];
    readonly model: AgentModelReference;
    readonly reasoningEffort: CoreReasoningEffort | undefined;
    readonly approvalMode: SessionApprovalMode;
    readonly createdAt: number;
    readonly updatedAt: number;
  }>;
  /** Whether the session works on its own or asks before every change. */
  setApprovalMode(
    auth: AssistantServerAuth,
    projectId: string,
    sessionId: string,
    mode: SessionApprovalMode,
  ): Promise<SessionApprovalMode>;
  createSession(
    auth: AssistantServerAuth,
    projectId: string,
    model?: AgentModelReference,
    reasoningEffort?: CoreReasoningEffort,
  ): Promise<{ readonly sessionId: string }>;
  setModel(
    auth: AssistantServerAuth,
    projectId: string,
    sessionId: string,
    model: AgentModelReference,
  ): Promise<void>;
  /** Change the session's thinking level between turns. */
  setReasoningEffort(
    auth: AssistantServerAuth,
    projectId: string,
    sessionId: string,
    reasoningEffort: CoreReasoningEffort,
  ): Promise<void>;
  startTurn(
    auth: AssistantServerAuth,
    projectId: string,
    sessionId: string,
    text: string,
  ): Promise<{ readonly taskId: string }>;
  answerInteraction(
    auth: AssistantServerAuth,
    projectId: string,
    sessionId: string,
    answer: {
      readonly interactionId: string;
      readonly interactionRevision: string;
      readonly decision: "allow" | "deny";
    },
  ): Promise<{ readonly taskId: string }>;
  cancel(
    auth: AssistantServerAuth,
    projectId: string,
    sessionId: string,
  ): Promise<void>;
  /**
   * Background children of one foreground session. The parent session is
   * the unit of access: a child is only reachable through the parent that
   * owns it, and the host re-checks that ownership.
   */
  listAgents(
    auth: AssistantServerAuth,
    projectId: string,
    sessionId: string,
  ): Promise<readonly WorkspaceBackgroundRecord[]>;
  /** A child's task and transcript, read through its parent. */
  readAgentTranscript(
    auth: AssistantServerAuth,
    projectId: string,
    sessionId: string,
    childSessionId: string,
  ): Promise<{ readonly task: string; readonly messages: readonly unknown[] }>;
  steerAgent(
    auth: AssistantServerAuth,
    projectId: string,
    sessionId: string,
    childSessionId: string,
    message: string,
  ): Promise<unknown>;
  stopAgent(
    auth: AssistantServerAuth,
    projectId: string,
    sessionId: string,
    childSessionId: string,
    reason?: string,
  ): Promise<WorkspaceBackgroundRecord>;
  answerAgentApproval(
    auth: AssistantServerAuth,
    projectId: string,
    sessionId: string,
    childSessionId: string,
    answer: {
      readonly interactionId: string;
      readonly decision: "allow" | "deny";
    },
  ): Promise<WorkspaceBackgroundRecord>;
}

export interface AssistantWorkspaceRoutes {
  readonly handleRequest: (
    request: IncomingMessage,
    response: ServerResponse,
    auth: AssistantServerAuth,
  ) => Promise<boolean>;
  readonly events: SessionEventHub;
  readonly operations: AssistantSessionOperations;
  /**
   * Tell clients of the parent session that a background child is waiting
   * for approval. Wire to the host's `background.onApprovalAvailable`.
   */
  notifyAgentApproval(request: {
    readonly projectId: string;
    readonly parentSessionId: string;
    readonly childSessionId: string;
  }): void;
  /**
   * Tell clients of the parent session that a background child's lifecycle,
   * phase, or current tool changed. Wire to `background.onAgentChanged`.
   */
  notifyAgentChange(
    request: WorkspaceBackgroundChange & { readonly projectId: string },
  ): void;
  /** Mount a project created while the server runs. */
  addProject(mount: AssistantProjectMount): void;
  /**
   * Unmount a project whose sessions are idle; the caller closes its host.
   * Returns whether it was mounted.
   */
  removeProject(projectId: string): boolean;
  /** Resolves once no server-owned task is running for the session. */
  whenIdle(projectId: string, sessionId: string): Promise<void>;
  /** Abort running tasks and wait for them to settle. */
  close(): Promise<void>;
}

interface RunningTask {
  readonly taskId: string;
  readonly operation: AssistantTaskOperation;
  /** Sequence of the task's `started` event, for replaying a live turn. */
  readonly startedSequence: number | undefined;
  /**
   * The turn's prompt for display (bounded): the transcript only has it once
   * the turn commits, so a client loading mid-turn would otherwise miss it.
   */
  readonly text: string | undefined;
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
  const mountProject = (mount: AssistantProjectMount) => {
    if (!PROJECT_ID_PATTERN.test(mount.projectId)) {
      throw new Error(`Invalid project ID: ${mount.projectId}`);
    }
    if (projects.has(mount.projectId)) {
      throw new Error(`Duplicate project ID: ${mount.projectId}`);
    }
    projects.set(mount.projectId, mount);
  };
  for (const mount of options.projects) mountProject(mount);
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
  const approvalMode = (
    projectId: string,
    sessionId: string,
  ): SessionApprovalMode =>
    options.approvalModes?.get(projectId, sessionId) ?? "ask";
  const effectiveModel = (selected: AgentModelReference | undefined) => {
    const model = selected ?? models.defaultModel;
    return { providerId: model.providerId, modelId: model.modelId };
  };

  const hub = new SessionEventHub(options.maxRetainedEvents, options.eventLog);
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
    text?: string,
  ): string => {
    const key = sessionKey(projectId, sessionId);
    const taskId = randomUUID();
    // Deliberately not `auth.signal`: closing the browser must not stop work.
    const controller = new AbortController();
    const started = hub.publish(key, {
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
    tasks.set(key, {
      taskId,
      operation,
      startedSequence: started?.sequence,
      text: text?.slice(0, MAX_TRANSCRIPT_TEXT_LENGTH),
      controller,
      done,
    });
    return taskId;
  };

  const assertStartable = (key: string) => {
    if (closing) throw new HttpError(503, "server_closing");
    if (tasks.has(key)) throw new HttpError(409, "session_busy");
  };

  /**
   * Final server-side check immediately before a mutation takes effect. The
   * request-time auth snapshot can be stale after a slow body or snapshot
   * read: the session or its device may since have been revoked.
   */
  const assertStillAuthorized = async (auth: AssistantServerAuth) => {
    const current = await auth.revalidate();
    if (!current.valid) throw new HttpError(401, "authentication_required");
  };

  /** A foreground session that is idle and has no pending approval. */
  const assertRunnable = async (
    mount: AssistantProjectMount,
    sessionId: string,
  ) => {
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
  };

  const assertSessionId = (sessionId: string) => {
    if (!SESSION_ID_PATTERN.test(sessionId)) {
      throw new HttpError(404, "session_not_found");
    }
  };

  const assertAvailableModel = (model: AgentModelReference) => {
    if (!isAvailable(model)) throw new HttpError(400, "model_not_available");
  };

  /** The level must be one the model declares; no list means no control. */
  const assertSupportedEffort = (
    model: AgentModelReference,
    reasoningEffort: CoreReasoningEffort,
  ) => {
    const choice = models.available.find(
      (candidate) =>
        candidate.providerId === model.providerId &&
        candidate.modelId === model.modelId,
    );
    if (!choice?.reasoningEfforts?.includes(reasoningEffort)) {
      throw new HttpError(400, "reasoning_effort_not_available");
    }
  };

  const operations: AssistantSessionOperations = {
    sessionKey,
    async listSessions(auth, projectId) {
      const mount = await authorize(auth, projectId, "read");
      return (await mount.host.listSessions())
        .filter((session) => !mount.host.isBackgroundSession(session.sessionId))
        .map((session) => ({
          sessionId: session.sessionId,
          updatedAt: session.updatedAt,
        }));
    },
    async readSession(auth, projectId, sessionId) {
      assertSessionId(sessionId);
      const mount = await authorize(auth, projectId, "read");
      const { record } = await readSnapshot(mount, sessionId);
      return {
        messages: record.messages,
        model: effectiveModel(record.selectedModel),
        reasoningEffort: record.reasoningEffort,
        approvalMode: approvalMode(projectId, sessionId),
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      };
    },
    async setApprovalMode(auth, projectId, sessionId, mode) {
      assertSessionId(sessionId);
      const mount = await authorize(auth, projectId, "approve");
      if (!SESSION_APPROVAL_MODES.includes(mode)) {
        throw new HttpError(400, "approval_mode_invalid");
      }
      if (!options.approvalModes) {
        throw new HttpError(409, "approval_mode_unavailable");
      }
      if (mount.host.isBackgroundSession(sessionId)) {
        throw new HttpError(404, "session_not_found");
      }
      await readSnapshot(mount, sessionId);
      await assertStillAuthorized(auth);
      await options.approvalModes.set(projectId, sessionId, mode);
      return approvalMode(projectId, sessionId);
    },
    async createSession(auth, projectId, model, reasoningEffort) {
      const mount = await authorize(auth, projectId, "write");
      if (model) assertAvailableModel(model);
      if (reasoningEffort !== undefined) {
        assertSupportedEffort(model ?? models.defaultModel, reasoningEffort);
      }
      if (closing) throw new HttpError(503, "server_closing");
      await assertStillAuthorized(auth);
      const created = await mount.host.createSession(
        model || reasoningEffort
          ? {
              ...(model ? { model: { ...model } } : {}),
              ...(reasoningEffort ? { reasoningEffort } : {}),
            }
          : undefined,
      );
      return { sessionId: created.sessionId };
    },
    async setReasoningEffort(auth, projectId, sessionId, reasoningEffort) {
      assertSessionId(sessionId);
      const mount = await authorize(auth, projectId, "write");
      const key = sessionKey(projectId, sessionId);
      assertStartable(key);
      await assertRunnable(mount, sessionId);
      const { record } = await readSnapshot(mount, sessionId);
      assertSupportedEffort(
        effectiveModel(record.selectedModel),
        reasoningEffort,
      );
      await assertStillAuthorized(auth);
      assertStartable(key);
      try {
        await mount.host.setSessionReasoningEffort(sessionId, reasoningEffort);
      } catch (error) {
        throw mapSessionUpdateError(error);
      }
    },
    async setModel(auth, projectId, sessionId, model) {
      assertSessionId(sessionId);
      const mount = await authorize(auth, projectId, "write");
      assertAvailableModel(model);
      const key = sessionKey(projectId, sessionId);
      assertStartable(key);
      await assertRunnable(mount, sessionId);
      await assertStillAuthorized(auth);
      assertStartable(key);
      try {
        await mount.host.setSessionModel(sessionId, {
          providerId: model.providerId,
          modelId: model.modelId,
        });
      } catch (error) {
        throw mapSessionUpdateError(error);
      }
    },
    async startTurn(auth, projectId, sessionId, text) {
      assertSessionId(sessionId);
      const mount = await authorize(auth, projectId, "write");
      if (!text.trim() || text.length > MAX_TURN_TEXT_LENGTH) {
        throw new HttpError(400, "text_invalid");
      }
      const key = sessionKey(projectId, sessionId);
      assertStartable(key);
      await assertRunnable(mount, sessionId);
      await assertStillAuthorized(auth);
      assertStartable(key);
      const taskId = startTask(
        projectId,
        sessionId,
        "turn",
        auth,
        (signal, onEvent) =>
          mount.host.runTurn(sessionId, text, { signal, onEvent }),
        text,
      );
      return { taskId };
    },
    async answerInteraction(auth, projectId, sessionId, answer) {
      assertSessionId(sessionId);
      const mount = await authorize(auth, projectId, "approve");
      const { interactionId, interactionRevision, decision } = answer;
      if (decision !== "allow" && decision !== "deny") {
        throw new HttpError(400, "decision_invalid");
      }
      const key = sessionKey(projectId, sessionId);
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
      await assertStillAuthorized(auth);
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
      return { taskId };
    },
    async cancel(auth, projectId, sessionId) {
      assertSessionId(sessionId);
      const mount = await authorize(auth, projectId, "write");
      await assertStillAuthorized(auth);
      const task = tasks.get(sessionKey(projectId, sessionId));
      if (task) {
        task.controller.abort(new Error("cancelled_by_owner"));
      } else {
        await readSnapshot(mount, sessionId);
        await mount.host.cancel(sessionId, "cancelled_by_owner");
      }
    },
    async listAgents(auth, projectId, sessionId) {
      assertSessionId(sessionId);
      const mount = await authorize(auth, projectId, "read");
      await readSnapshot(mount, sessionId);
      return callAgent(async () => mount.host.listBackgroundAgents(sessionId));
    },
    async readAgentTranscript(auth, projectId, sessionId, childSessionId) {
      assertSessionId(sessionId);
      assertAgentId(childSessionId);
      const mount = await authorize(auth, projectId, "read");
      await readSnapshot(mount, sessionId);
      // Ownership: only a child of this parent is readable through it.
      const agent = (
        await callAgent(async () => mount.host.listBackgroundAgents(sessionId))
      ).find((candidate) => candidate.childSessionId === childSessionId);
      if (!agent) throw new HttpError(404, "agent_not_found");
      const { record } = await callAgent(async () =>
        mount.host.readBackgroundAgentSession(sessionId, childSessionId),
      );
      return { task: agent.task, messages: record.messages };
    },
    async steerAgent(auth, projectId, sessionId, childSessionId, message) {
      assertSessionId(sessionId);
      assertAgentId(childSessionId);
      const mount = await authorize(auth, projectId, "write");
      // The supervisor bounds steering by UTF-8 bytes.
      if (
        !message.trim() ||
        Buffer.byteLength(message, "utf8") > MAX_STEERING_BYTES
      ) {
        throw new HttpError(400, "message_invalid");
      }
      if (closing) throw new HttpError(503, "server_closing");
      await readSnapshot(mount, sessionId);
      await assertStillAuthorized(auth);
      const result = await callAgent(() =>
        mount.host.steerBackgroundAgent({
          callerSessionId: sessionId,
          childSessionId,
          message,
        }),
      );
      hub.publish(sessionKey(projectId, sessionId), {
        kind: "agent",
        state: "steered",
        childSessionId,
        actor: actorOf(auth),
      });
      return result;
    },
    async stopAgent(auth, projectId, sessionId, childSessionId, reason) {
      assertSessionId(sessionId);
      assertAgentId(childSessionId);
      const mount = await authorize(auth, projectId, "write");
      if (
        reason !== undefined &&
        (!reason.trim() || reason.length > MAX_STOP_REASON_LENGTH)
      ) {
        throw new HttpError(400, "reason_invalid");
      }
      await readSnapshot(mount, sessionId);
      await assertStillAuthorized(auth);
      const agent = await callAgent(() =>
        mount.host.stopBackgroundAgent({
          callerSessionId: sessionId,
          childSessionId,
          reason: reason ?? "cancelled_by_owner",
        }),
      );
      hub.publish(sessionKey(projectId, sessionId), {
        kind: "agent",
        state: "stopped",
        childSessionId,
        actor: actorOf(auth),
      });
      return agent;
    },
    async answerAgentApproval(
      auth,
      projectId,
      sessionId,
      childSessionId,
      { interactionId, decision },
    ) {
      assertSessionId(sessionId);
      assertAgentId(childSessionId);
      // Same bar as a foreground approval.
      const mount = await authorize(auth, projectId, "approve");
      if (decision !== "allow" && decision !== "deny") {
        throw new HttpError(400, "decision_invalid");
      }
      if (closing) throw new HttpError(503, "server_closing");
      await readSnapshot(mount, sessionId);
      await assertStillAuthorized(auth);
      // The supervisor binds the decision to this exact pending interaction.
      const agent = await callAgent(() =>
        mount.host.respondToBackgroundApproval({
          callerSessionId: sessionId,
          childSessionId,
          interactionId,
          decision,
        }),
      );
      hub.publish(sessionKey(projectId, sessionId), {
        kind: "agent",
        state: "approval_answered",
        childSessionId,
        actor: actorOf(auth),
      });
      return agent;
    },
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
        if (mount.hidden) continue;
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
            approvalMode: approvalMode(projectId, session.sessionId),
            background: mount.host.isBackgroundSession(session.sessionId),
          })),
        });
        return true;
      }
      if (method === "POST") {
        await authorize(auth, projectId, "write");
        // The body is optional: no body creates a default-model session.
        const model = hasRequestBody(request)
          ? requestedModel(await readJsonBody(request, undefined, auth.signal))
          : undefined;
        const created = await operations.createSession(auth, projectId, model);
        sendJson(response, 201, {
          sessionId: created.sessionId,
          model: effectiveModel(model),
          approvalMode: approvalMode(projectId, created.sessionId),
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
        transcript: projectSessionTranscript(hydration.record.messages),
        model: effectiveModel(hydration.record.selectedModel),
        approvalMode: approvalMode(projectId, sessionId),
        background: mount.host.isBackgroundSession(sessionId),
        task: task
          ? {
              taskId: task.taskId,
              operation: task.operation,
              ...(task.startedSequence !== undefined
                ? { startedSequence: task.startedSequence }
                : {}),
              ...(task.text !== undefined ? { text: task.text } : {}),
            }
          : null,
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
      await authorize(auth, projectId, "write");
      const body = await readJsonBody(
        request,
        MAX_TURN_BODY_BYTES,
        auth.signal,
      );
      const text = stringField(body, "text");
      const { taskId } = await operations.startTurn(
        auth,
        projectId,
        sessionId,
        text,
      );
      sendJson(response, 202, { taskId });
      return true;
    }

    if (operation === "interaction") {
      await authorize(auth, projectId, "approve");
      const body = await readJsonBody(request, undefined, auth.signal);
      const interactionId = stringField(body, "interactionId");
      const interactionRevision = stringField(body, "interactionRevision");
      const decision = stringField(body, "decision");
      if (decision !== "allow" && decision !== "deny") {
        throw new HttpError(400, "decision_invalid");
      }
      await assertStillAuthorized(auth);
      const { taskId } = await operations.answerInteraction(
        auth,
        projectId,
        sessionId,
        { interactionId, interactionRevision, decision },
      );
      sendJson(response, 202, { taskId });
      return true;
    }

    if (operation === "model") {
      await authorize(auth, projectId, "write");
      const body = await readJsonBody(request, undefined, auth.signal);
      const model = requestedModel(body);
      if (!model) throw new HttpError(400, "model_required");
      await operations.setModel(auth, projectId, sessionId, model);
      sendJson(response, 200, { model: effectiveModel(model) });
      return true;
    }

    if (operation === "approval-mode") {
      await authorize(auth, projectId, "approve");
      const body = await readJsonBody(request, undefined, auth.signal);
      const mode = body.mode;
      if (
        typeof mode !== "string" ||
        !SESSION_APPROVAL_MODES.includes(mode as SessionApprovalMode)
      ) {
        throw new HttpError(400, "approval_mode_invalid");
      }
      sendJson(response, 200, {
        approvalMode: await operations.setApprovalMode(
          auth,
          projectId,
          sessionId,
          mode as SessionApprovalMode,
        ),
      });
      return true;
    }

    // operation === "cancel"
    await operations.cancel(auth, projectId, sessionId);
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
    if (childSessionId !== undefined) assertAgentId(childSessionId);

    if (operation === undefined) {
      if (method !== "GET") throw new HttpError(405, "method_not_allowed");
      const agents = await operations.listAgents(auth, projectId, sessionId);
      sendJson(response, 200, { agents });
      return;
    }
    if (method !== "POST") throw new HttpError(405, "method_not_allowed");
    const child = childSessionId!;

    if (operation === "steer") {
      await authorize(auth, projectId, "write");
      const body = await readJsonBody(request, 128 * 1024, auth.signal);
      const result = await operations.steerAgent(
        auth,
        projectId,
        sessionId,
        child,
        stringField(body, "message"),
      );
      sendJson(response, 202, result);
      return;
    }

    if (operation === "stop") {
      await authorize(auth, projectId, "write");
      let reason: string | undefined;
      if (hasRequestBody(request)) {
        const body = await readJsonBody(request, undefined, auth.signal);
        const value = body.reason;
        if (value !== undefined) {
          if (typeof value !== "string") {
            throw new HttpError(400, "reason_invalid");
          }
          reason = value;
        }
      }
      const agent = await operations.stopAgent(
        auth,
        projectId,
        sessionId,
        child,
        reason,
      );
      sendJson(response, 200, { agent });
      return;
    }

    // operation === "approval"
    await authorize(auth, projectId, "approve");
    const body = await readJsonBody(request, undefined, auth.signal);
    const decision = stringField(body, "decision");
    if (decision !== "allow" && decision !== "deny") {
      throw new HttpError(400, "decision_invalid");
    }
    const agent = await operations.answerAgentApproval(
      auth,
      projectId,
      sessionId,
      child,
      { interactionId: stringField(body, "interactionId"), decision },
    );
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
    operations,
    addProject: mountProject,
    removeProject: (projectId) => projects.delete(projectId),
    notifyAgentApproval({ projectId, parentSessionId, childSessionId }) {
      if (!projects.has(projectId)) return;
      hub.publish(sessionKey(projectId, parentSessionId), {
        kind: "agent",
        state: "approval_required",
        childSessionId,
      });
    },
    notifyAgentChange({
      projectId,
      parentSessionId,
      childSessionId,
      lifecycle,
      phase,
      currentTool,
    }) {
      if (!projects.has(projectId)) return;
      hub.publish(sessionKey(projectId, parentSessionId), {
        kind: "agent",
        state: "updated",
        childSessionId,
        lifecycle,
        phase,
        ...(currentTool ? { currentTool } : {}),
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

/** Run a background supervisor call, mapping its failures to HTTP errors. */
async function callAgent<T>(run: () => T | Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw agentError(error);
  }
}

function assertAgentId(childSessionId: string): void {
  if (!SESSION_ID_PATTERN.test(childSessionId)) {
    throw new HttpError(404, "agent_not_found");
  }
}

function actorOf(auth: AssistantServerAuth) {
  return {
    subjectId: auth.principal.subjectId,
    deviceId: auth.session.deviceId,
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

/** Map a host failure while changing a session's settings between turns. */
function mapSessionUpdateError(error: unknown): unknown {
  const code = errorCode(error);
  if (code === "session_not_found") {
    return new HttpError(404, "session_not_found");
  }
  if (
    code === "session_busy" ||
    code === "turn_lease_held" ||
    code === "turn_lease_lost" ||
    code === "session_revision_conflict"
  ) {
    return new HttpError(409, "session_busy");
  }
  return error;
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
