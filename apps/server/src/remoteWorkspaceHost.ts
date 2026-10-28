import type {
  AgentTurnEvent,
  AgentTurnInterjection,
  AgentTurnResult,
} from "@agentlink/core";
import type {
  WorkspaceBackgroundChange,
  WorkspaceHost,
} from "@agentlink/workspace-host";

import {
  RunnerUnreachableError,
  type RunnerHttpClient,
} from "./runnerProtocol.js";
import type { SessionApprovalMode } from "./SessionApprovalModes.js";
import type { RunnerEvent } from "./sessionRunner.js";
import type { AssistantWorkspaceHost } from "./workspaceRoutes.js";

/**
 * A workspace host in a session runner, behind the same interface as an
 * in-process one, so the routes, chat bridge, steering, approvals and Stop
 * work unchanged. The runner is started on first use and stopped once it
 * has been idle (no call, no running turn, no running background agent)
 * for `idleMs`; its sessions live on the control plane's disk, so starting
 * it again picks them up.
 *
 * Interjections: the routes hand them to a running turn through a pull
 * callback; the adapter pulls them every `interjectionPollMs` and passes
 * them to the runner, whose turn takes them at its next break. What a turn
 * ends without taking is dropped there, exactly as in process: the chat
 * still has it queued and sends it next.
 */

export interface RemoteWorkspaceHost extends AssistantWorkspaceHost {
  /** Stop the runner (if running) and stop using it. */
  close(): Promise<void>;
}

export interface RemoteWorkspaceHostOptions {
  readonly client: RunnerHttpClient;
  /** Start the runner (replacing any earlier one) and wait until it answers. */
  readonly start: () => Promise<void>;
  readonly stop: () => Promise<void>;
  /** The session's mode, sent with every turn. */
  readonly approvalMode: (sessionId: string) => SessionApprovalMode;
  /**
   * Whether the session is a read-only reviewer, sent with every turn: its
   * commands run only when VS Code's read-only check clears them.
   */
  readonly reviewer?: (sessionId: string) => boolean;
  readonly onAgentApproval?: (request: {
    readonly parentSessionId: string;
    readonly childSessionId: string;
  }) => void;
  readonly onAgentChanged?: (change: WorkspaceBackgroundChange) => void;
  /** Why a turn failed, beyond its public error. */
  readonly onTurnFailure?: (sessionId: string, detail: string) => void;
  readonly idleMs?: number;
  readonly interjectionPollMs?: number;
  readonly log?: (line: string) => void;
  /**
   * The last session list and transcripts read from the runner, kept by
   * the control plane, so showing a finished task's chat does not start
   * its runner. Anything that changes a session still starts it.
   */
  readonly cache?: RemoteSessionCache;
}

export interface RemoteSessionCache {
  read(key: string): Promise<unknown>;
  write(key: string, value: unknown): Promise<void>;
}

const SESSIONS_KEY = "sessions";
const sessionKey = (sessionId: string) => `session-${sessionId}`;
const MISSING = { missing: true } as const;
const isMissing = (copy: unknown) =>
  !!copy &&
  typeof copy === "object" &&
  (copy as { missing?: unknown }).missing === true &&
  Object.keys(copy).length === 1;
const sessionNotFound = () =>
  Object.assign(new Error("Session not found"), { code: "session_not_found" });
/** A session read mid-turn: only its runner can say how that ended. */
const isMidTurn = (hydration: unknown) => {
  const phase = (
    hydration as { record?: { runState?: { phase?: unknown } } } | undefined
  )?.record?.runState?.phase;
  return phase === "running" || phase === "resuming";
};

const DEFAULT_IDLE_MS = 10 * 60 * 1_000;
const DEFAULT_INTERJECTION_POLL_MS = 250;
const EVENTS_RETRY_MS = 1_000;

/** Calls safe to send again after the runner could not be reached. */
const RETRYABLE = new Set([
  "listSessions",
  "readSession",
  "setSessionModel",
  "setSessionReasoningEffort",
  "cancel",
  "listBackgroundAgents",
  "readBackgroundAgentSession",
]);

export function createRemoteWorkspaceHost(
  options: RemoteWorkspaceHostOptions,
): RemoteWorkspaceHost {
  const { client } = options;
  const log = options.log ?? (() => undefined);
  const idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
  const background = new Set<string>();
  let running: Promise<void> | undefined;
  let events: AbortController | undefined;
  let active = 0;
  let lastUse = Date.now();
  let closed = false;
  let idleTimer: ReturnType<typeof setInterval> | undefined;

  const follow = (controller: AbortController) => {
    void (async () => {
      while (!controller.signal.aborted) {
        try {
          for await (const line of client.stream(
            "/events",
            {},
            controller.signal,
          )) {
            const event = line as unknown as RunnerEvent | { type: string };
            if (event.type === "agent_approval") {
              const approval = event as Extract<
                RunnerEvent,
                { type: "agent_approval" }
              >;
              background.add(approval.childSessionId);
              options.onAgentApproval?.({
                parentSessionId: approval.parentSessionId,
                childSessionId: approval.childSessionId,
              });
            } else if (event.type === "agent_changed") {
              const { change } = event as Extract<
                RunnerEvent,
                { type: "agent_changed" }
              >;
              background.add(change.childSessionId);
              options.onAgentChanged?.(change);
            }
          }
        } catch (error) {
          if (controller.signal.aborted) return;
          log(`Runner events dropped: ${describe(error)}`);
        }
        await new Promise((resolve) => setTimeout(resolve, EVENTS_RETRY_MS));
      }
    })();
  };

  /** `reason`: the call that needs the runner, for the log. */
  const ready = async (reason: string) => {
    if (closed) {
      throw Object.assign(new Error("runner_closed"), {
        code: "runner_closed",
      });
    }
    running ??= (async () => {
      log(`Starting the runner for ${reason}`);
      await options.start();
      events?.abort();
      events = new AbortController();
      follow(events);
      // Learn which sessions are background children before anyone asks.
      const sessions = await client.call<
        Array<{ sessionId: string; background?: boolean }>
      >("/call", { method: "listSessions", args: [] });
      for (const session of sessions) {
        if (session.background) background.add(session.sessionId);
      }
    })().catch((error: unknown) => {
      running = undefined;
      throw error;
    });
    await running;
  };

  /** The runner went away: start it again on the next use. */
  const lost = () => {
    running = undefined;
    events?.abort();
    events = undefined;
  };

  const stopIfIdle = async () => {
    if (!running || active > 0 || Date.now() - lastUse < idleMs) return;
    try {
      const health = await client.health();
      if (health.busy === true) {
        lastUse = Date.now();
        return;
      }
    } catch {
      // Not answering: stopping it is still right.
    }
    if (active > 0 || Date.now() - lastUse < idleMs) return;
    lost();
    await options.stop().catch((error: unknown) => {
      log(`Could not stop an idle runner: ${describe(error)}`);
    });
  };
  idleTimer = setInterval(
    () => void stopIfIdle(),
    Math.max(1_000, Math.min(idleMs, 60_000)),
  );
  idleTimer.unref();

  const use = async <T>(run: () => Promise<T>): Promise<T> => {
    active += 1;
    lastUse = Date.now();
    try {
      return await run();
    } finally {
      active -= 1;
      lastUse = Date.now();
    }
  };

  const remember = (key: string, value: unknown) => {
    void options.cache?.write(key, value).catch((error: unknown) => {
      log(`Could not keep a copy of ${key}: ${describe(error)}`);
    });
  };
  /** From the copy while the runner is stopped, otherwise from the runner. */
  const cached = async <T>(
    key: string,
    load: () => Promise<T>,
    usable: (value: unknown) => boolean = () => true,
  ): Promise<T> => {
    if (!running && options.cache) {
      const copy = await options.cache.read(key).catch(() => undefined);
      if (isMissing(copy)) throw sessionNotFound();
      if (copy !== undefined && usable(copy)) return copy as T;
    }
    let value: T;
    try {
      value = await load();
    } catch (error) {
      // A session the runner does not have never appears later.
      if ((error as { code?: unknown }).code === "session_not_found") {
        remember(key, MISSING);
      }
      throw error;
    }
    remember(key, value);
    return value;
  };
  /** After a turn: keep the session's new state for later reads. */
  const refreshCopy = (sessionId: string) => {
    if (!options.cache) return;
    void client
      .call("/call", { method: "readSession", args: [sessionId] })
      .then((value) => remember(sessionKey(sessionId), value))
      .catch(() => undefined);
  };

  const call = <T>(method: string, args: readonly unknown[]): Promise<T> =>
    use(async () => {
      await ready(method);
      try {
        return await client.call<T>("/call", { method, args });
      } catch (error) {
        if (!(error instanceof RunnerUnreachableError)) throw error;
        lost();
        if (!RETRYABLE.has(method)) throw error;
        await ready(method);
        return await client.call<T>("/call", { method, args });
      }
    });

  const turn = (
    path: "/turns/run" | "/turns/resume",
    sessionId: string,
    body: Record<string, unknown>,
    options_: {
      readonly signal?: AbortSignal;
      readonly onEvent?: (event: AgentTurnEvent) => void;
      readonly takeInterjections?: () => readonly AgentTurnInterjection[];
    },
  ): Promise<AgentTurnResult> =>
    use(async () => {
      await ready(path === "/turns/run" ? "a turn" : "an approval");
      const { signal, onEvent, takeInterjections } = options_;
      // Stop asks the runner to cancel, so the turn still reports its
      // cancelled result; dropping the connection is the last resort.
      const connection = new AbortController();
      const onAbort = () => {
        void client
          .call("/turns/abort", {
            sessionId,
            ...(typeof signal?.reason === "string"
              ? { reason: signal.reason }
              : {}),
          })
          .catch(() => connection.abort(signal?.reason));
      };
      if (signal?.aborted) onAbort();
      signal?.addEventListener("abort", onAbort, { once: true });
      const poll = takeInterjections
        ? setInterval(() => {
            const taken = takeInterjections();
            if (taken.length === 0) return;
            void client
              .call("/turns/interject", { sessionId, interjections: taken })
              .catch((error: unknown) => {
                log(
                  `Could not pass a message to the runner: ${describe(error)}`,
                );
              });
          }, options.interjectionPollMs ?? DEFAULT_INTERJECTION_POLL_MS)
        : undefined;
      let result: AgentTurnResult | undefined;
      try {
        for await (const line of client.stream(
          path,
          {
            sessionId,
            approvalMode: options.approvalMode(sessionId),
            ...(options.reviewer?.(sessionId) ? { reviewer: true } : {}),
            ...body,
          },
          connection.signal,
        )) {
          if (line.type === "event") {
            onEvent?.(line.event as AgentTurnEvent);
          } else if (line.type === "result") {
            if (typeof line.failureDetail === "string") {
              options.onTurnFailure?.(sessionId, line.failureDetail);
            }
            result = line.result as AgentTurnResult;
          }
        }
      } catch (error) {
        if (error instanceof RunnerUnreachableError) lost();
        throw error;
      } finally {
        if (poll) clearInterval(poll);
        signal?.removeEventListener("abort", onAbort);
        refreshCopy(sessionId);
      }
      if (!result) {
        // The runner stopped mid-turn; its next start records the session
        // interrupted.
        lost();
        throw Object.assign(new Error("runner_lost"), { code: "runner_lost" });
      }
      return result;
    });

  return {
    isBackgroundSession: (sessionId) => background.has(sessionId),
    createSession: async (createOptions) => {
      const created = await call<{ sessionId: string }>("createSession", [
        createOptions ?? {},
      ]);
      // The list kept for a stopped runner must include it.
      if (options.cache) {
        void client
          .call("/call", { method: "listSessions", args: [] })
          .then((value) => remember(SESSIONS_KEY, value))
          .catch(() => undefined);
      }
      return created;
    },
    listSessions: async () => {
      const sessions = await cached(SESSIONS_KEY, () =>
        call<
          Array<
            Awaited<ReturnType<WorkspaceHost["listSessions"]>>[number] & {
              background?: boolean;
            }
          >
        >("listSessions", []),
      );
      return sessions.map(({ background: isBackground, ...session }) => {
        if (isBackground) background.add(session.sessionId);
        return session;
      });
    },
    readSession: async (sessionId) =>
      await cached(
        sessionKey(sessionId),
        () => call("readSession", [sessionId]),
        (copy) => !isMidTurn(copy),
      ),
    setSessionModel: async (sessionId, model) =>
      await call("setSessionModel", [sessionId, model]),
    setSessionReasoningEffort: async (sessionId, effort) =>
      await call("setSessionReasoningEffort", [sessionId, effort]),
    cancel: async (sessionId, reason) =>
      await call("cancel", [sessionId, reason]),
    listBackgroundAgents: async (sessionId) => {
      const agents = await call<
        ReturnType<WorkspaceHost["listBackgroundAgents"]>
      >("listBackgroundAgents", [sessionId]);
      for (const agent of agents) background.add(agent.childSessionId);
      return agents;
    },
    readBackgroundAgentSession: async (sessionId, childSessionId) =>
      await call("readBackgroundAgentSession", [sessionId, childSessionId]),
    steerBackgroundAgent: async (request) =>
      await call("steerBackgroundAgent", [request]),
    stopBackgroundAgent: async (request) =>
      await call("stopBackgroundAgent", [request]),
    respondToBackgroundApproval: async (request) =>
      await call("respondToBackgroundApproval", [request]),
    runTurn: async (sessionId, text, runOptions = {}) =>
      await turn("/turns/run", sessionId, { text }, runOptions),
    resumeInteraction: async (sessionId, decision, resumeOptions = {}) =>
      await turn(
        "/turns/resume",
        sessionId,
        {
          decision,
          ...(resumeOptions.expected
            ? { expected: resumeOptions.expected }
            : {}),
        },
        resumeOptions,
      ),
    async close() {
      if (closed) return;
      closed = true;
      if (idleTimer) clearInterval(idleTimer);
      idleTimer = undefined;
      const wasRunning = running !== undefined;
      lost();
      if (wasRunning) await options.stop();
    },
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
