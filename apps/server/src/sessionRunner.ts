import type {
  AgentModelReference,
  AgentTurnEvent,
  AgentTurnInterjection,
} from "@agentlink/core";
import type { CoreReasoningEffort } from "@agentlink/protocol";
import {
  createWorkspaceHost,
  type WorkspaceBackgroundChange,
  type WorkspaceHost,
} from "@agentlink/workspace-host";
import { randomUUID } from "node:crypto";
import path from "node:path";

import { StandaloneStructuralIndex } from "../../../src/indexer/standalone/StandaloneStructuralIndex.js";
import { createStructuralIndexTools } from "../../../src/indexer/standalone/structuralIndexTools.js";

import { HttpError } from "./httpJson.js";
import { remoteApprovalHostTools, remoteHostTools } from "./remoteHostTools.js";
import { openRemoteModelBackends } from "./remoteModels.js";
import {
  createRunnerHttpClient,
  sameToken,
  startRunnerHttpServer,
  type RunnerHttpServer,
  type RunnerRouteHandler,
} from "./runnerProtocol.js";
import type { SessionApprovalMode } from "./SessionApprovalModes.js";
import { describeTurnFailure } from "./turnFailures.js";

/**
 * A session runner: one coding task's agent loop, file tools and commands,
 * in a container that sees only the task's folder and its own data folder.
 * The control plane drives it over HTTP (`/call`, `/turns/*`, `/events`)
 * with the same operations it uses on an in-process workspace host; model
 * calls and web tools go back to the control plane, which holds every
 * sign-in. Its sessions live in the data folder, which the control plane
 * keeps, so a runner can be stopped and started again at any time.
 */

export const RUNNER_PORT = 7600;
export const RUNNER_DATA_ROOT = "/var/lib/agentlink-runner";
export const RUNNER_ENV = {
  token: "AGENTLINK_RUNNER_TOKEN",
  controlUrl: "AGENTLINK_RUNNER_CONTROL_URL",
  spec: "AGENTLINK_RUNNER_SPEC",
} as const;

/** What the control plane tells a runner to run (no secrets). */
export interface SessionRunnerSpec {
  readonly projectId: string;
  /** The task folder: the clone plus read-only references under refs/. */
  readonly projectRoot: string;
  /** Commands run only inside this folder (the clone). */
  readonly commandRoot: string;
  readonly shell: string;
  readonly defaultModel: AgentModelReference;
  readonly modelRoles?: Readonly<Record<string, AgentModelReference>>;
  readonly instructions: string;
  /** Command environment (proxy settings with the signed policy, CI=true…). */
  readonly commandEnvironment: Readonly<Record<string, string>>;
  readonly ripgrepPath?: string;
}

/** The workspace host operations a runner serves. */
export type RunnerHost = Pick<
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

/** A runner event the control plane receives on `/events`. */
export type RunnerEvent =
  | {
      readonly type: "agent_approval";
      readonly parentSessionId: string;
      readonly childSessionId: string;
    }
  | {
      readonly type: "agent_changed";
      readonly change: WorkspaceBackgroundChange;
    };

/**
 * The runner's session state, created before its host so the host's
 * callbacks (approval grants, background changes, turn failures) can use it.
 */
export function createRunnerSessionState() {
  const modes = new Map<string, SessionApprovalMode>();
  const queued = new Map<string, AgentTurnInterjection[]>();
  const turns = new Map<string, AbortController>();
  const failures = new Map<string, string>();
  const activeChildren = new Set<string>();
  const subscribers = new Set<(event: RunnerEvent) => void>();
  const publish = (event: RunnerEvent) => {
    for (const subscriber of subscribers) subscriber(event);
  };
  return {
    /** Sessions run without asking unless the owner set them to `ask`. */
    autonomous: (request: { readonly sessionId: string }) =>
      (modes.get(request.sessionId) ?? "autonomous") === "autonomous",
    setMode(sessionId: string, mode: unknown) {
      if (mode === "autonomous" || mode === "ask") modes.set(sessionId, mode);
    },
    onAgentApproval(request: {
      readonly parentSessionId: string;
      readonly childSessionId: string;
    }) {
      publish({ type: "agent_approval", ...request });
    },
    onAgentChanged(change: WorkspaceBackgroundChange) {
      if (
        change.lifecycle === "queued" ||
        change.lifecycle === "running" ||
        change.lifecycle === "awaiting_approval"
      ) {
        activeChildren.add(change.childSessionId);
      } else {
        activeChildren.delete(change.childSessionId);
      }
      publish({ type: "agent_changed", change });
    },
    onTurnError(sessionId: string, error: unknown) {
      const detail = describeTurnFailure(error);
      if (detail) failures.set(sessionId, detail);
    },
    takeFailure(sessionId: string) {
      const detail = failures.get(sessionId);
      failures.delete(sessionId);
      return detail;
    },
    queue(sessionId: string, interjections: readonly AgentTurnInterjection[]) {
      const list = queued.get(sessionId) ?? [];
      list.push(...interjections);
      queued.set(sessionId, list);
    },
    take(sessionId: string): readonly AgentTurnInterjection[] {
      const list = queued.get(sessionId) ?? [];
      queued.delete(sessionId);
      return list;
    },
    turns,
    subscribers,
    busy: () => turns.size > 0 || activeChildren.size > 0,
  };
}

export type RunnerSessionState = ReturnType<typeof createRunnerSessionState>;

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value) {
    throw new HttpError(400, `${name}_required`);
  }
  return value;
}

/** The runner's HTTP routes over its host. */
export function runnerHostRoutes(
  host: RunnerHost,
  state: RunnerSessionState,
): Record<string, RunnerRouteHandler> {
  const calls: Record<string, (args: readonly unknown[]) => Promise<unknown>> =
    {
      listSessions: async () =>
        (await host.listSessions()).map((session) => ({
          ...session,
          background: host.isBackgroundSession(session.sessionId),
        })),
      createSession: async ([options]) =>
        await host.createSession(
          (options ?? {}) as Parameters<RunnerHost["createSession"]>[0],
        ),
      readSession: async ([sessionId]) =>
        await host.readSession(text(sessionId, "session_id")),
      setSessionModel: async ([sessionId, model]) =>
        await host.setSessionModel(
          text(sessionId, "session_id"),
          model as AgentModelReference,
        ),
      setSessionReasoningEffort: async ([sessionId, effort]) =>
        await host.setSessionReasoningEffort(
          text(sessionId, "session_id"),
          effort as CoreReasoningEffort,
        ),
      setApprovalMode: async ([sessionId, mode]) => {
        state.setMode(text(sessionId, "session_id"), mode);
      },
      cancel: async ([sessionId, reason]) =>
        await host.cancel(
          text(sessionId, "session_id"),
          typeof reason === "string" ? reason : undefined,
        ),
      listBackgroundAgents: async ([sessionId]) =>
        host.listBackgroundAgents(text(sessionId, "session_id")),
      readBackgroundAgentSession: async ([sessionId, childSessionId]) =>
        await host.readBackgroundAgentSession(
          text(sessionId, "session_id"),
          text(childSessionId, "child_session_id"),
        ),
      steerBackgroundAgent: async ([request]) =>
        await host.steerBackgroundAgent(
          request as Parameters<RunnerHost["steerBackgroundAgent"]>[0],
        ),
      stopBackgroundAgent: async ([request]) =>
        await host.stopBackgroundAgent(
          request as Parameters<RunnerHost["stopBackgroundAgent"]>[0],
        ),
      respondToBackgroundApproval: async ([request]) =>
        await host.respondToBackgroundApproval(
          request as Parameters<RunnerHost["respondToBackgroundApproval"]>[0],
        ),
    };
  /** Run one turn (or resume), streaming its events, then its result. */
  const turn =
    (
      run: (
        sessionId: string,
        body: Record<string, unknown>,
        options: {
          readonly signal: AbortSignal;
          readonly onEvent: (event: AgentTurnEvent) => void;
          readonly takeInterjections: () => readonly AgentTurnInterjection[];
        },
      ) => Promise<unknown>,
    ): RunnerRouteHandler =>
    async (body, { signal, stream }) => {
      const sessionId = text(body.sessionId, "session_id");
      state.setMode(sessionId, body.approvalMode);
      if (state.turns.has(sessionId)) {
        throw Object.assign(new Error("turn_in_progress"), {
          code: "turn_in_progress",
        });
      }
      // Stopped by the control plane's abort, or by it going away.
      const controller = new AbortController();
      const onAbort = () => controller.abort(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      state.turns.set(sessionId, controller);
      const write = stream();
      try {
        const result = await run(sessionId, body, {
          signal: controller.signal,
          onEvent: (event) => write({ type: "event", event }),
          takeInterjections: () => state.take(sessionId),
        });
        const failureDetail = state.takeFailure(sessionId);
        write({
          type: "result",
          result,
          ...(failureDetail ? { failureDetail } : {}),
        });
      } finally {
        signal.removeEventListener("abort", onAbort);
        state.turns.delete(sessionId);
        state.take(sessionId);
      }
      return undefined;
    };
  return {
    "/call": async (body) => {
      const method = typeof body.method === "string" ? body.method : "";
      const call = Object.hasOwn(calls, method) ? calls[method] : undefined;
      if (!call) throw new HttpError(404, "method_not_found");
      return await call(Array.isArray(body.args) ? body.args : []);
    },
    "/turns/run": turn(
      async (sessionId, body, options) =>
        await host.runTurn(sessionId, text(body.text, "text"), options),
    ),
    "/turns/resume": turn(async (sessionId, body, options) => {
      const expected = body.expected as
        | { interactionId?: unknown; interactionRevision?: unknown }
        | undefined;
      return await host.resumeInteraction(
        sessionId,
        body.decision === "allow" ? "allow" : "deny",
        {
          ...options,
          ...(expected &&
          typeof expected.interactionId === "string" &&
          typeof expected.interactionRevision === "string"
            ? {
                expected: {
                  interactionId: expected.interactionId,
                  interactionRevision: expected.interactionRevision,
                },
              }
            : {}),
        },
      );
    }),
    "/turns/interject": async (body) => {
      const sessionId = text(body.sessionId, "session_id");
      const interjections = Array.isArray(body.interjections)
        ? body.interjections.filter(
            (item): item is AgentTurnInterjection =>
              !!item &&
              typeof (item as AgentTurnInterjection).id === "string" &&
              typeof (item as AgentTurnInterjection).text === "string",
          )
        : [];
      // Only a running turn takes them; otherwise the sender runs them next.
      if (!state.turns.has(sessionId)) return { queued: false };
      state.queue(sessionId, interjections);
      return { queued: true };
    },
    "/turns/abort": async (body) => {
      const sessionId = text(body.sessionId, "session_id");
      state.turns
        .get(sessionId)
        ?.abort(typeof body.reason === "string" ? body.reason : undefined);
      return { aborted: true };
    },
    "/events": async (_body, { signal, stream }) => {
      const write = stream();
      write({ type: "ready" });
      const subscriber = (event: RunnerEvent) => write(event);
      state.subscribers.add(subscriber);
      try {
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      } finally {
        state.subscribers.delete(subscriber);
      }
      return undefined;
    },
  };
}

export interface SessionRunner {
  readonly port: number;
  close(): Promise<void>;
}

/**
 * Start a runner: describe the control plane's models, open the workspace
 * host in `dataRoot`, recover sessions a previous runner left running, and
 * serve the control plane (which presents the same token).
 */
export async function startSessionRunner(options: {
  readonly spec: SessionRunnerSpec;
  readonly token: string;
  readonly controlUrl: string;
  readonly dataRoot: string;
  readonly host?: string;
  readonly port?: number;
  readonly log: (line: string) => void;
  /** Tests: build the host differently. */
  readonly createHost?: typeof createWorkspaceHost;
}): Promise<SessionRunner> {
  const { spec, log } = options;
  const control = createRunnerHttpClient({
    baseUrl: options.controlUrl,
    token: options.token,
  });
  const backends = await openRemoteModelBackends(control);
  // The control plane's approval tools (MCP calls), if it offers any.
  const approvalHostTools = await remoteApprovalHostTools(control);
  const state = createRunnerSessionState();
  const host = await (options.createHost ?? createWorkspaceHost)({
    projectRoot: spec.projectRoot,
    dataRoot: options.dataRoot,
    // By project ID, not by folder identity: a recreated runner container
    // can see the same folder with another device number, which would
    // lose the task's chat.
    storageKey: spec.projectId,
    ownerId: `agentlink-runner-${process.pid}-${randomUUID()}`,
    providers: backends.map((backend) => ({ type: "backend", backend })),
    defaultModel: spec.defaultModel,
    promptIdentity: { role: "a personal assistant" },
    // VS Code's guidance for the tools the task's chat has, as the
    // Assistant's coding-task chats.
    sharedPromptGuidance: true,
    // No limits: a task runs until it is done or stopped, like a VS Code
    // chat with Auto Continue (the control plane watches for runaways).
    turnLimits: {
      maxModelCalls: 0,
      maxToolCalls: 0,
      maxElapsedMs: 0,
      maxToolResultBytes: 0,
    },
    // Todos and VS Code's set_task_status, as the Assistant's own chats.
    sessionInteractions: { finalStatus: true },
    instructions: spec.instructions,
    // The task repository's AGENTS.md, rules and skills, as VS Code reads
    // them. Never the runner's home folder: the persona and memory stand in
    // for the owner's global instructions.
    agentInstructions: { enabled: true, homeDir: null },
    // VS Code's search_session_history and read_session_excerpt.
    sessionRecall: { enabled: true },
    condense: { enabled: true },
    commands: {
      enabled: true,
      shellExecutable: spec.shell,
      root: spec.commandRoot,
      // Exactly this environment: never the runner's own (its token).
      resolveEnvironment: () => ({ ...spec.commandEnvironment }),
      // A call's env adds variables; it never replaces the task's own.
      environmentOverrides: "add_only",
      hasSessionGrant: (_proposal, request) => state.autonomous(request),
    },
    hostTools: remoteHostTools(control),
    // The task's own index under its data root: tasks never share one.
    structuralIndex: ({ projectRoot, resolveScopes }) =>
      createStructuralIndexTools({
        index: new StandaloneStructuralIndex({
          projectRoot,
          indexRoot: path.join(options.dataRoot, "code-index"),
        }),
        resolveScopes: async (request) => await resolveScopes(request),
      }),
    ...(approvalHostTools ? { approvalHostTools } : {}),
    onTurnError: ({ sessionId, error }) => state.onTurnError(sessionId, error),
    files: {
      enabled: true,
      // Protected paths always ask, whatever this says.
      approvalPolicy: {
        hasSessionGrant: (_proposal, request) => state.autonomous(request),
      },
      ...(spec.ripgrepPath ? { ripgrepExecutable: spec.ripgrepPath } : {}),
    },
    background: {
      enabled: true,
      inheritSessionGrants: true,
      ...(spec.modelRoles ? { modelRoles: spec.modelRoles } : {}),
      onApprovalAvailable: (request) => state.onAgentApproval(request),
      onAgentChanged: (change) => state.onAgentChanged(change),
    },
  });
  await recoverRunnerSessions(host, log);
  let server: RunnerHttpServer;
  try {
    const routes = runnerHostRoutes(host, state);
    server = await startRunnerHttpServer({
      host: options.host ?? "0.0.0.0",
      port: options.port ?? RUNNER_PORT,
      authorize: (presented) =>
        sameToken(options.token, presented) ? true : undefined,
      routes: () => routes,
      health: () => ({ busy: state.busy() }),
      log,
    });
  } catch (error) {
    await host.close();
    throw error;
  }
  log(
    `AgentLink session runner for ${spec.projectId} listening on port ${server.port}`,
  );
  return {
    port: server.port,
    async close() {
      for (const controller of state.turns.values()) {
        controller.abort("runner_stopping");
      }
      await server.close();
      await host.close();
    },
  };
}

/** A session a previous runner left mid-turn is recorded interrupted. */
async function recoverRunnerSessions(
  host: Pick<
    WorkspaceHost,
    | "listSessions"
    | "readSession"
    | "recoverInterrupted"
    | "isBackgroundSession"
  >,
  log: (line: string) => void,
): Promise<void> {
  for (const session of await host.listSessions()) {
    if (host.isBackgroundSession(session.sessionId)) continue;
    try {
      const phase = (await host.readSession(session.sessionId)).record.runState
        .phase;
      if (phase !== "running" && phase !== "resuming") continue;
      await host.recoverInterrupted(session.sessionId);
      log(`Recovered interrupted session ${session.sessionId}`);
    } catch (error) {
      // Still leased by the runner that crashed: its lease expires and the
      // next turn takes over the session.
      log(
        `Could not recover session ${session.sessionId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
