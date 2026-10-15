import type { AgentModelReference } from "@agentlink/core";
import type { ApprovalRequest } from "@agentlink/protocol/approval-transport";
import { isBrowserGatewayAskAgentSessionId } from "@agentlink/protocol/browser-gateway-ask-agent-identity";

import { isJobChangeDisplay } from "./jobChangeDisplay.js";
import { isTaskStartDisplay } from "./taskStartDisplay.js";
import type {
  ChatSessionActivity,
  ChatSessionKind,
} from "@agentlink/protocol/chat-session-history";
import type { BrowserGatewayThemeSnapshot } from "@agentlink/protocol/browser-gateway-theme";
import {
  isCoreReasoningEffort,
  type CoreReasoningEffort,
  type EmbeddedAgentTurnEvent,
} from "@agentlink/protocol";
import { randomUUID } from "node:crypto";
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
import type { WorkspaceBackgroundRecord } from "@agentlink/workspace-host";
import type { AssistantServerAuth } from "./assistantServer.js";
import { writeFileAtomic } from "./atomicFile.js";
import {
  agentApprovalRequest,
  isActiveAgent,
  parseAgentApprovalId,
  toAgentCard,
} from "./backgroundAgentCards.js";
import {
  agentResultBlocks,
  formatAgentResultPrompt,
  isTerminalAgent,
  terminalChildIdsIn,
  toDeliveredResult,
  withAgentResultCards,
} from "./backgroundResultDelivery.js";
import {
  deliveredTaskResult,
  formatTaskResultPrompt,
  taskResultBlocks,
  taskResultNotice,
  withTaskResultNotices,
  type TaskDeliveryResult,
} from "./taskResultDelivery.js";
import type { TaskRun } from "./taskStore.js";
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
/**
 * How often running background agents are re-read while one is active:
 * their output preview changes without a lifecycle event.
 */
const AGENT_REFRESH_MS = 2_000;
const MAX_STEERING_BYTES = 64 * 1024;
const CREDENTIAL_STATUS: BrowserGatewayModelCredentialStatus = {
  state: "not_required",
  providerId: "agentlink-server",
};
const ALLOW_DECISIONS = new Set(["accept", "accept-session"]);

/** Routes the UI calls that this server does not implement yet. */
const EMPTY_GET_RESPONSES: Readonly<Record<string, unknown>> = {
  // The Agent Fleet hides once every agent has finished; `/fleet` reopens it.
  "/api/ask-agent/slash-commands": {
    commands: [
      {
        name: "fleet",
        description: "Show the Agent Fleet panel",
        source: "builtin",
        builtin: true,
      },
    ],
  },
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
  /**
   * The project's defaults for new chats, read each time one starts so
   * settings changes apply without recreating the bridge.
   */
  readonly defaults?: () => {
    readonly model?: AgentModelReference;
    readonly reasoningEffort?: CoreReasoningEffort;
  };
  /** Where UI-only session metadata (aliases, titles, hidden) is kept. */
  readonly stateFile: string;
  readonly theme?: BrowserGatewayThemeSnapshot;
  readonly now?: () => number;
  /** Background agent refresh interval while one is active (tests). */
  readonly agentRefreshMs?: number;
  /** The Assistant's inbox and jobs status, carried in every snapshot. */
  readonly assistantStatus?: () => {
    readonly inboxUnread: number;
    readonly revision: number;
  };
  /**
   * Stop the scheduled run working in this chat, when the owner presses
   * Stop while viewing it. Without it the chat's turn is cancelled.
   */
  readonly stopRun?: (workspaceSessionId: string) => Promise<void>;
  /**
   * The coding tasks started from (or continued in) this chat, newest
   * first, shown as live cards above the composer.
   */
  readonly chatTasks?: (workspaceSessionId: string) => readonly ChatTaskCard[];
  /**
   * A message the owner wrote in a linked chat (a coding task's). The task
   * runner takes it (steering a working task, continuing a finished one),
   * so the server's checks still run; the chat then follows its work.
   */
  readonly linkedMessage?: (
    workspaceSessionId: string,
    text: string,
  ) => Promise<void>;
}

/** What a chat is, for badges and filters in the chat list. */
export type ChatKind = ChatSessionKind;

/** A coding task as the chat that started it shows it. */
export interface ChatTaskCard {
  readonly id: string;
  readonly state: string;
  readonly objective: string;
  readonly repository: string;
  readonly pullRequest?: string;
  readonly updatedAt: number;
}

export interface AskAgentBridge {
  /** Handles `/api/ask-agent/*`; false for any other path. */
  handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
    auth: AssistantServerAuth,
  ): Promise<boolean>;
  readonly theme: BrowserGatewayThemeSnapshot;
  /** How many chats are running, waiting for an approval, or unread. */
  activity(): AskAgentBridgeActivity;
  /**
   * Show a chat started outside this UI (a scheduled job's run) in the
   * chat list, titled and unread, once its work has finished. Ends any
   * live following of it.
   */
  adoptSession(
    auth: AssistantServerAuth,
    workspaceSessionId: string,
    title: string,
  ): Promise<void>;
  /**
   * Show a scheduled run's chat while it works: its prompt, streamed text
   * and tool calls, and any approval it waits for (answered from the chat
   * like any other). `adoptSession` ends the following.
   */
  followSession(
    auth: AssistantServerAuth,
    workspaceSessionId: string,
    run: { readonly title: string; readonly prompt: string },
  ): void;
  /** Make a chat the open one, for links from the inbox or jobs. */
  openSession(auth: AssistantServerAuth, sessionId: string): Promise<boolean>;
  /**
   * Show another project's chat (a coding task's implementation chat) in
   * this chat list, as a chat the owner can open, read and write to.
   */
  linkSession(
    auth: AssistantServerAuth,
    workspaceSessionId: string,
    link: { readonly projectId: string; readonly title: string },
  ): Promise<void>;
  /** Remove a linked chat (its task was deleted). */
  unlinkSession(workspaceSessionId: string): Promise<void>;
  /**
   * Hand a coding task's outcome to the chat that started it: a notice in
   * the chat, then a turn so the assistant reports it. Runs after any turn
   * already running or queued there. `chat_missing` when the chat is gone.
   */
  deliverTaskResult(
    auth: AssistantServerAuth,
    workspaceSessionId: string,
    task: TaskRun,
  ): Promise<TaskDeliveryResult>;
  /** Republish the snapshot (the inbox or jobs changed). */
  refresh(): void;
  close(): Promise<void>;
}

export interface AskAgentBridgeActivity {
  readonly running: number;
  readonly needsYou: number;
  readonly unread: number;
}

interface BridgeState {
  /** UI (client-minted) session ID to workspace session ID. */
  aliases: Record<string, string>;
  titles: Record<string, string>;
  hidden: string[];
  /** Workspace sessions that finished a turn nobody was viewing. */
  unread: string[];
  /** Workspace sessions started by scheduled jobs. */
  scheduled: string[];
  /** Other projects' chats shown here (coding tasks), by workspace session. */
  linked: Record<string, { projectId: string; kind: "task" }>;
}

type ApprovalMode = "autonomous" | "ask";

interface PendingInteraction {
  readonly workspaceSessionId: string;
  readonly interactionId: string;
  readonly interactionRevision: string;
}

/** A scheduled run's chat, shown live while the run works. */
interface FollowedRun {
  readonly workspaceSessionId: string;
  /** Held by the store too: its updates land here. */
  readonly session: BrowserGatewayAskAgentPersistedSession;
  /** Where streamed text goes; a new message after the owner writes. */
  messageId: string;
  readonly toolStarts: Map<string, number>;
  approval:
    | (PendingInteraction & { readonly request: ApprovalRequest })
    | undefined;
  subscription: { unsubscribe(): void } | undefined;
}

/** Approval IDs of followed runs: `run:<session>:<interaction>`. */
const RUN_APPROVAL_PREFIX = "run:";

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
  /** The project a workspace session belongs to: this one, or a link's. */
  const projectOf = (workspaceSessionId: string) =>
    state.linked[workspaceSessionId]?.projectId ?? projectId;
  const kindOf = (workspaceSessionId: string | undefined): ChatKind =>
    !workspaceSessionId
      ? "chat"
      : state.linked[workspaceSessionId]
        ? "task"
        : state.scheduled.includes(workspaceSessionId)
          ? "job_run"
          : "chat";
  /** Last known model of each workspace session. */
  const sessionModels = new Map<string, AgentModelReference>();
  /** Last known thinking level of each workspace session. */
  const sessionEfforts = new Map<string, CoreReasoningEffort | undefined>();
  /** Approval mode of each workspace session (absent: autonomous). */
  const sessionApprovalModes = new Map<string, ApprovalMode>();
  /** Modes picked for chats that have no workspace session yet. */
  const pendingApprovalModes = new Map<string, ApprovalMode>();

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
      contextWindow: model.contextWindow ?? 200_000,
      ...(model.maxInputTokens === undefined
        ? {}
        : { maxInputTokens: model.maxInputTokens }),
      supportsToolUse: true,
      ...(model.supportsImages === undefined
        ? {}
        : { supportsImages: model.supportsImages }),
      ...(model.reasoningEfforts?.length
        ? {
            reasoningEfforts: [...model.reasoningEfforts],
            ...(model.defaultReasoningEffort
              ? { defaultReasoningEffort: model.defaultReasoningEffort }
              : {}),
          }
        : {}),
      authenticated: true,
    })),
  );
  /** Select the project's default model and thinking level. */
  const applyDefaults = () => {
    const defaults = options.defaults?.();
    const model =
      defaults?.model && modelsByKey.has(modelKey(defaults.model))
        ? defaults.model
        : options.models.defaultModel;
    store.setModel(modelKey(model));
    if (defaults?.reasoningEffort) {
      store.setReasoningEffort(defaults.reasoningEffort);
    }
  };
  applyDefaults();

  let pendingInteraction: PendingInteraction | undefined;
  /** Scheduled runs' chats shown live, by workspace session. */
  const followed = new Map<string, FollowedRun>();
  /** Linked chats whose history is read before they are followed. */
  const pendingFollows = new Set<string>();
  /** The UI session whose turn is running, if any. */
  let runningSession: string | undefined;
  /** The workspace session of that turn, once it has started. */
  let runningWorkspaceSession: string | undefined;
  /**
   * Queued messages a running turn took in (VS Code's interjection): their
   * sends must not run them as turns of their own afterwards.
   */
  const admittedInterjections = new Set<string>();
  /** Interjections already in their chat (sent into a task's chat). */
  const shownInterjections = new Set<string>();
  /**
   * Messages handed to a working task's turn and not yet taken: given to the
   * task's runner instead if that turn ends first.
   */
  const pendingTaskInterjections = new Map<
    string,
    { readonly workspaceSessionId: string; readonly text: string }
  >();
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

  /**
   * Background agents of the open chat's workspace session. Only that chat
   * is watched: the Agent Fleet strip shows the chat on screen.
   */
  const agentWatch: {
    sessionId: string | undefined;
    subscription: { unsubscribe(): void } | undefined;
    auth: AssistantServerAuth | undefined;
    records: readonly WorkspaceBackgroundRecord[];
    refreshing: Promise<void> | undefined;
    again: boolean;
    timer: ReturnType<typeof setTimeout> | undefined;
  } = {
    sessionId: undefined,
    subscription: undefined,
    auth: undefined,
    records: [],
    refreshing: undefined,
    again: false,
    timer: undefined,
  };

  const project = () => {
    const state = controller.projectState({
      now: now(),
      theme,
      modelCredentialStatus: CREDENTIAL_STATUS,
      // A chat's own approval first (one of its own turns, or the
      // scheduled run working in it); then a background agent's.
      approval:
        controller.getPendingApproval() ??
        followed.get(store.getActiveSessionId())?.approval?.request ??
        agentApprovalRequest(agentWatch.records),
      memoryCandidateNudge: null,
    });
    return {
      ...state,
      snapshot: {
        ...state.snapshot,
        background: agentWatch.records.map(toAgentCard),
        approvalMode: activeApprovalMode(),
        tasks: activeChatTasks(),
        ...(options.assistantStatus
          ? { assistant: { ...options.assistantStatus() } }
          : {}),
      },
    };
  };
  const activeChatTasks = (): readonly ChatTaskCard[] => {
    const workspaceSessionId = workspaceSessionFor(store.getActiveSessionId());
    if (!workspaceSessionId || !options.chatTasks) return [];
    return options.chatTasks(workspaceSessionId);
  };
  const activeApprovalMode = (): ApprovalMode => {
    const storeSessionId = store.getActiveSessionId();
    const workspaceSessionId = workspaceSessionFor(storeSessionId);
    return (
      (workspaceSessionId
        ? sessionApprovalModes.get(workspaceSessionId)
        : pendingApprovalModes.get(storeSessionId)) ?? "autonomous"
    );
  };
  const snapshotResponse = () => ({ ok: true as const, ...project() });
  const publishNow = () => controller.publishSnapshot(project().snapshot);
  const schedule = () => {
    void controller
      .scheduleProjectedSnapshot(() => project().snapshot)
      .catch(() => undefined);
  };

  /**
   * One workspace session as a UI chat, or undefined when it cannot be read
   * or has no messages. Records its model, thinking level and approval mode,
   * and follows its background agents.
   */
  const readHistorySession = async (
    auth: AssistantServerAuth,
    sessionId: string,
    alias: string | undefined,
  ): Promise<BrowserGatewayAskAgentPersistedSession | undefined> => {
    let read;
    try {
      read = await operations.readSession(
        auth,
        projectOf(sessionId),
        sessionId,
      );
    } catch {
      return undefined;
    }
    sessionModels.set(sessionId, read.model);
    sessionEfforts.set(sessionId, read.reasoningEffort);
    sessionApprovalModes.set(sessionId, read.approvalMode);
    const messages = withTaskResultNotices(
      withAgentResultCards(
        agentMessagesToChatMessages([...read.messages], { baseIndex: 0 }),
      ),
    );
    // Agents that ended before this server started are not reported
    // again; ones still running are, when they finish.
    try {
      const agents = await operations.listAgents(
        auth,
        projectOf(sessionId),
        sessionId,
      );
      for (const agent of agents) {
        if (isTerminalAgent(agent)) {
          delivery.handled.add(agent.childSessionId);
        }
      }
      if (agents.some((agent) => !isTerminalAgent(agent))) {
        trackParent(sessionId);
      }
    } catch {
      // Without background agents enabled there is nothing to report.
    }
    if (messages.length === 0) return undefined;
    const firstPrompt = messages.find((message) => message.role === "user");
    return {
      id: alias ?? sessionId,
      title: state.titles[sessionId] ?? deriveTitle(firstPrompt?.content ?? ""),
      createdAt: read.createdAt,
      lastActiveAt: read.updatedAt,
      messages,
      // Past every ID in the history: new messages must not reuse one.
      nextMessageSequence: messages.length + 1,
    };
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
        const session = await readHistorySession(
          auth,
          summary.sessionId,
          reverse.get(summary.sessionId),
        );
        if (session) sessions.push(session);
      }
      // Other projects' chats linked here (coding tasks).
      for (const workspaceSessionId of Object.keys(state.linked)) {
        if (hidden.has(workspaceSessionId)) continue;
        const session = await readHistorySession(
          auth,
          workspaceSessionId,
          undefined,
        );
        if (session) sessions.push(session);
      }
      sessions.sort((left, right) => right.lastActiveAt - left.lastActiveAt);
      store.loadHistory({ sessions });
      // Runs working now keep their live chat over the partial history.
      for (const run of followed.values()) store.upsertSession(run.session);
    })().catch((error: unknown) => {
      loaded = undefined;
      throw error;
    });
    return loaded;
  };

  const workspaceSessionFor = (storeSessionId: string) =>
    state.aliases[storeSessionId] ??
    (sessionModels.has(storeSessionId) || followed.has(storeSessionId)
      ? storeSessionId
      : undefined);

  /** Re-read the watched chat's agents; overlapping calls coalesce. */
  const refreshAgents = (): Promise<void> => {
    if (agentWatch.refreshing) {
      agentWatch.again = true;
      return agentWatch.refreshing;
    }
    agentWatch.refreshing = (async () => {
      do {
        agentWatch.again = false;
        const sessionId = agentWatch.sessionId;
        const auth = agentWatch.auth;
        if (!sessionId || !auth || closed) return;
        let records: readonly WorkspaceBackgroundRecord[];
        try {
          records = await operations.listAgents(
            auth,
            projectOf(sessionId),
            sessionId,
          );
        } catch {
          // Keep the last known cards; a later event or request retries.
          return;
        }
        // The chat changed while reading: read the new one.
        if (agentWatch.sessionId !== sessionId) {
          agentWatch.again = true;
          continue;
        }
        agentWatch.records = records;
        schedule();
      } while (agentWatch.again);
    })().finally(() => {
      agentWatch.refreshing = undefined;
      if (agentWatch.timer) clearTimeout(agentWatch.timer);
      agentWatch.timer = undefined;
      if (!closed && agentWatch.records.some(isActiveAgent)) {
        agentWatch.timer = setTimeout(
          () => void refreshAgents(),
          options.agentRefreshMs ?? AGENT_REFRESH_MS,
        );
        agentWatch.timer.unref?.();
      }
    });
    return agentWatch.refreshing;
  };

  /** Follow the open chat's workspace session, if it has one. */
  const watchActiveAgents = (auth: AssistantServerAuth) => {
    // Detached: refreshes and wake-ups run after this request has closed,
    // and must still stop when the owner signs out or is revoked.
    agentWatch.auth = auth.detach();
    const sessionId = workspaceSessionFor(store.getActiveSessionId());
    if (sessionId === agentWatch.sessionId) return;
    agentWatch.subscription?.unsubscribe();
    agentWatch.subscription = undefined;
    agentWatch.sessionId = sessionId;
    agentWatch.records = [];
    if (!sessionId || closed) return;
    const key = operations.sessionKey(projectOf(sessionId), sessionId);
    agentWatch.subscription = options.events.subscribe(
      key,
      options.events.latestSequence(key),
      ({ event }) => {
        if (event.kind === "agent") void refreshAgents();
      },
    );
    void refreshAgents();
  };

  /**
   * Hands finished background agents back to the chat that started them:
   * a short turn shows the result card and lets the assistant report it.
   * Every chat that started agents is followed, not only the open one.
   */
  const delivery = {
    /** Parent workspace sessions followed for agent changes. */
    parents: new Map<string, { unsubscribe(): void }>(),
    /** Children already reported, collected by their parent, or old. */
    handled: new Set<string>(),
    /** Parents with a wake-up turn queued. */
    queued: new Set<string>(),
    /** Parents whose turn the owner stopped; cleared by their next message. */
    stopped: new Set<string>(),
  };

  const storeSessionFor = (workspaceSessionId: string) => {
    for (const [alias, id] of Object.entries(state.aliases)) {
      if (id === workspaceSessionId && store.hasSession(alias)) return alias;
    }
    return store.hasSession(workspaceSessionId)
      ? workspaceSessionId
      : undefined;
  };

  const trackParent = (workspaceSessionId: string) => {
    if (delivery.parents.has(workspaceSessionId) || closed) return;
    const key = operations.sessionKey(
      projectOf(workspaceSessionId),
      workspaceSessionId,
    );
    delivery.parents.set(
      workspaceSessionId,
      options.events.subscribe(
        key,
        options.events.latestSequence(key),
        ({ event }) => {
          if (event.kind === "agent") void checkParent(workspaceSessionId);
        },
      ),
    );
  };

  /** Queue a wake-up if a parent has finished agents not yet reported. */
  const checkParent = async (workspaceSessionId: string) => {
    const auth = agentWatch.auth;
    if (!auth || closed || delivery.queued.has(workspaceSessionId)) return;
    let agents: readonly WorkspaceBackgroundRecord[];
    try {
      agents = await operations.listAgents(
        auth,
        projectOf(workspaceSessionId),
        workspaceSessionId,
      );
    } catch {
      return;
    }
    if (
      agents.some(
        (agent) =>
          isTerminalAgent(agent) && !delivery.handled.has(agent.childSessionId),
      )
    ) {
      queueWake(workspaceSessionId);
    }
  };

  /** Run the wake-up turn after any turn already running or queued. */
  const queueWake = (workspaceSessionId: string) => {
    if (delivery.queued.has(workspaceSessionId)) return;
    delivery.queued.add(workspaceSessionId);
    const previous = turnChain;
    let release!: () => void;
    turnChain = new Promise<void>((resolve) => {
      release = resolve;
    });
    void (async () => {
      try {
        await previous;
        delivery.queued.delete(workspaceSessionId);
        if (closed || delivery.stopped.has(workspaceSessionId)) return;
        await wake(workspaceSessionId);
      } catch {
        // A failed wake-up leaves the result on the Agent Fleet card.
      } finally {
        delivery.queued.delete(workspaceSessionId);
        release();
      }
    })();
  };

  const wake = async (workspaceSessionId: string) => {
    const auth = agentWatch.auth;
    if (!auth || !(await auth.revalidate()).valid) return;
    const storeSessionId = storeSessionFor(workspaceSessionId);
    if (!storeSessionId) return;
    const agents = await operations.listAgents(
      auth,
      projectOf(workspaceSessionId),
      workspaceSessionId,
    );
    // Re-read now: the parent may have collected a result in its last turn.
    const results = agents
      .filter(
        (agent) =>
          isTerminalAgent(agent) && !delivery.handled.has(agent.childSessionId),
      )
      .map(toDeliveredResult);
    if (results.length === 0) return;
    for (const result of results) delivery.handled.add(result.childSessionId);
    const card = store.appendSessionMessage(storeSessionId, {
      role: "assistant",
      content: "",
      blocks: agentResultBlocks(results),
      now: now(),
    });
    if (!card) return;
    const assistant = store.startAssistantMessage({
      now: now(),
      sessionId: storeSessionId,
    });
    const turn = controller.beginTurn(assistant.id);
    if (!turn) return;
    runningSession = storeSessionId;
    try {
      await publishNow();
      await runTurn({
        auth,
        workspaceSessionId,
        messageId: assistant.id,
        turn,
        text: formatAgentResultPrompt(results),
      });
    } finally {
      controller.completeTurn(turn);
      runningSession = undefined;
      await flagUnread(storeSessionId, workspaceSessionId);
    }
    await publishNow();
  };

  /** Run a task's outcome turn in its chat, after any turn before it. */
  const deliverTaskResult = (
    auth: AssistantServerAuth,
    workspaceSessionId: string,
    task: TaskRun,
  ): Promise<TaskDeliveryResult> => {
    const previous = turnChain;
    let release!: () => void;
    turnChain = new Promise<void>((resolve) => {
      release = resolve;
    });
    return (async () => {
      try {
        await previous;
        return await runTaskResult(auth, workspaceSessionId, task);
      } finally {
        release();
      }
    })();
  };

  const runTaskResult = async (
    auth: AssistantServerAuth,
    workspaceSessionId: string,
    task: TaskRun,
  ): Promise<TaskDeliveryResult> => {
    if (closed || !(await auth.revalidate()).valid) return "unavailable";
    await ensureLoaded(auth);
    // A deleted chat is hidden, or no longer there at all.
    if (state.hidden.includes(workspaceSessionId)) return "chat_missing";
    const storeSessionId = storeSessionFor(workspaceSessionId);
    if (!storeSessionId) return "chat_missing";
    const result = deliveredTaskResult(task);
    const notice = store.appendSessionMessage(storeSessionId, {
      role: "assistant",
      content: taskResultNotice(result),
      blocks: taskResultBlocks(result),
      now: now(),
    });
    if (!notice) return "chat_missing";
    const assistant = store.startAssistantMessage({
      now: now(),
      sessionId: storeSessionId,
    });
    const turn = controller.beginTurn(assistant.id);
    // The notice is in the chat; the outcome counts as delivered from here.
    if (!turn) {
      await flagUnread(storeSessionId, workspaceSessionId);
      await publishNow();
      return "delivered";
    }
    runningSession = storeSessionId;
    try {
      await publishNow();
      await runTurn({
        auth,
        workspaceSessionId,
        messageId: assistant.id,
        turn,
        text: formatTaskResultPrompt(result),
      });
    } catch {
      // The notice stays; the owner can ask about it.
    } finally {
      controller.completeTurn(turn);
      runningSession = undefined;
      await flagUnread(storeSessionId, workspaceSessionId);
    }
    await publishNow();
    return "delivered";
  };

  /** Flag a chat that finished a turn nobody was viewing. */
  const flagUnread = async (
    storeSessionId: string,
    workspaceSessionId: string,
  ) => {
    if (
      (store.getActiveSessionId() !== storeSessionId || sse.size === 0) &&
      !state.unread.includes(workspaceSessionId)
    ) {
      state.unread.push(workspaceSessionId);
      await saveState().catch(() => undefined);
    }
  };

  /** The watched chat's agent with this ID, or a 404. */
  const watchedAgent = (childSessionId: string) => {
    const parent = agentWatch.sessionId;
    if (
      !parent ||
      !agentWatch.records.some(
        (record) => record.childSessionId === childSessionId,
      )
    ) {
      throw new HttpError(404, "agent_not_found");
    }
    return parent;
  };

  const activityOf = (
    storeSessionId: string,
  ): ChatSessionActivity | undefined => {
    const workspaceSessionId = workspaceSessionFor(storeSessionId);
    if (
      workspaceSessionId &&
      pendingInteraction?.workspaceSessionId === workspaceSessionId
    ) {
      return "needs-you";
    }
    const run = workspaceSessionId
      ? followed.get(workspaceSessionId)
      : undefined;
    if (run) return run.approval ? "needs-you" : "running";
    const watched =
      workspaceSessionId !== undefined &&
      workspaceSessionId === agentWatch.sessionId;
    if (
      watched &&
      agentWatch.records.some(
        (record) => record.lifecycle === "awaiting_approval",
      )
    ) {
      return "needs-you";
    }
    if (runningSession === storeSessionId && controller.hasActiveTurn()) {
      return "running";
    }
    if (watched && agentWatch.records.some(isActiveAgent)) {
      return "running";
    }
    if (workspaceSessionId && state.unread.includes(workspaceSessionId)) {
      return "unread";
    }
    return undefined;
  };

  /** The owner is looking at this chat now. */
  const markRead = (storeSessionId: string) => {
    const workspaceSessionId = workspaceSessionFor(storeSessionId);
    if (!workspaceSessionId) return;
    const index = state.unread.indexOf(workspaceSessionId);
    if (index < 0) return;
    state.unread.splice(index, 1);
    void saveState().catch(() => undefined);
  };

  const selectedModel = (): AgentModelReference => {
    const choice = modelsByKey.get(store.getModel());
    return choice
      ? { providerId: choice.providerId, modelId: choice.modelId }
      : options.models.defaultModel;
  };

  /** The thinking level picked in the UI, if the selected model has one. */
  const selectedEffort = (): CoreReasoningEffort | undefined => {
    const choice = modelsByKey.get(modelKey(selectedModel()));
    const effort = store.getReasoningEffort();
    return choice?.reasoningEfforts?.includes(effort) ? effort : undefined;
  };

  /** The workspace session behind the active UI session, created on demand. */
  const ensureWorkspaceSession = async (
    auth: AssistantServerAuth,
  ): Promise<string> => {
    const storeSessionId = store.getActiveSessionId();
    const existing = workspaceSessionFor(storeSessionId);
    const model = selectedModel();
    const effort = selectedEffort();
    if (existing) {
      const current = sessionModels.get(existing);
      if (!current || modelKey(current) !== modelKey(model)) {
        await operations.setModel(auth, projectOf(existing), existing, model);
        sessionModels.set(existing, model);
      }
      if (effort && sessionEfforts.get(existing) !== effort) {
        await operations.setReasoningEffort(
          auth,
          projectOf(existing),
          existing,
          effort,
        );
        sessionEfforts.set(existing, effort);
      }
      return existing;
    }
    const { sessionId } = await operations.createSession(
      auth,
      projectId,
      model,
      effort,
    );
    sessionModels.set(sessionId, model);
    sessionEfforts.set(sessionId, effort);
    state.aliases[storeSessionId] = sessionId;
    await saveState();
    // A mode picked before the chat's first message.
    const pendingMode = pendingApprovalModes.get(storeSessionId);
    pendingApprovalModes.delete(storeSessionId);
    sessionApprovalModes.set(
      sessionId,
      pendingMode
        ? await operations.setApprovalMode(
            auth,
            projectOf(sessionId),
            sessionId,
            pendingMode,
          )
        : "autonomous",
    );
    return sessionId;
  };

  const handleApprovalMode = async (
    request: IncomingMessage,
    response: ServerResponse,
    auth: AssistantServerAuth,
  ) => {
    const body = await readJsonBody(request, undefined, auth.signal);
    const mode = body.mode;
    if (mode !== "autonomous" && mode !== "ask") {
      throw new HttpError(400, "approval_mode_invalid");
    }
    const storeSessionId = store.getActiveSessionId();
    const workspaceSessionId = workspaceSessionFor(storeSessionId);
    if (workspaceSessionId) {
      sessionApprovalModes.set(
        workspaceSessionId,
        await operations.setApprovalMode(
          auth,
          projectOf(workspaceSessionId),
          workspaceSessionId,
          mode,
        ),
      );
    } else {
      pendingApprovalModes.set(storeSessionId, mode);
    }
    const publication = await publishNow();
    sendJson(response, 200, { ok: true, snapshot: publication.snapshot });
  };

  const approvalFor = (
    event: Extract<EmbeddedAgentTurnEvent, { type: "interaction.required" }>,
  ): ApprovalRequest => {
    const { interaction } = event;
    // A job change or new task describes itself in full: what it will do,
    // where, and with which instructions.
    if (
      isJobChangeDisplay(interaction.displayContent) ||
      isTaskStartDisplay(interaction.displayContent)
    ) {
      return {
        kind: "write",
        id: interaction.interactionId,
        filePath: truncate(
          interaction.summary || `Allow ${interaction.toolName}?`,
          MAX_TITLE_LENGTH,
        ),
        writeOperation:
          interaction.displayContent.action === "create" ? "create" : "modify",
        detail: truncate(
          interaction.displayContent.text,
          MAX_APPROVAL_DETAIL_LENGTH,
        ),
        writeChoices: [
          { label: "Allow", value: "accept", isPrimary: true },
          { label: "Deny", value: "reject", isDanger: true },
        ],
      };
    }
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
   * A message the user sent into a running turn was taken in: show it where
   * it landed (once), drop it from the queue, and return the message the
   * rest of the reply streams into, below it.
   */
  const admitInterjection = (
    storeSessionId: string,
    interjectionId: string,
    text: string,
  ): string => {
    store.removeQueuedMessage(interjectionId);
    // A task chat's message has no send waiting to skip it afterwards.
    if (!pendingTaskInterjections.delete(interjectionId)) {
      admittedInterjections.add(interjectionId);
    }
    const at = now();
    const active = store.getActiveSessionId() === storeSessionId;
    if (!shownInterjections.delete(interjectionId)) {
      if (active) {
        store.appendUserMessage({ id: interjectionId, text, now: at });
      } else {
        store.appendSessionMessage(storeSessionId, {
          role: "user",
          content: text,
          blocks: [{ type: "text", text }],
          now: at,
        });
      }
    }
    const reply = store.startAssistantMessage(
      active ? { now: at } : { now: at, sessionId: storeSessionId },
    );
    schedule();
    return reply.id;
  };

  /**
   * Project a turn's text and tool events into an assistant message, which
   * may be in any chat. False for other events.
   */
  const projectTurnContent = (
    messageId: string,
    toolStarts: Map<string, number>,
    event: EmbeddedAgentTurnEvent,
  ): boolean => {
    switch (event.type) {
      case "text.delta":
        controller.appendAssistantDelta(messageId, event.text);
        schedule();
        return true;
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
        return true;
      case "tool.completed":
      case "tool.failed":
        // The parent already saw how these agents ended: no wake-up.
        if (
          event.type === "tool.completed" &&
          (event.toolName === "get_background_result" ||
            event.toolName === "get_background_status")
        ) {
          for (const id of terminalChildIdsIn(event.displayContent)) {
            delivery.handled.add(id);
          }
        }
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
        return true;
      default:
        return false;
    }
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
    const { turn, workspaceSessionId } = params;
    // Moves below each message the user sends into the turn.
    let messageId = params.messageId;
    const storeSessionId = runningSession ?? store.getActiveSessionId();
    runningWorkspaceSession = workspaceSessionId;
    const key = operations.sessionKey(
      projectOf(workspaceSessionId),
      workspaceSessionId,
    );
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
      if (projectTurnContent(messageId, toolStarts, event)) return;
      switch (event.type) {
        case "user.interjected":
          messageId = admitInterjection(
            storeSessionId,
            event.interjectionId,
            event.text,
          );
          controller.retargetTurn(turn, messageId);
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
        projectOf(workspaceSessionId),
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
      if (runningWorkspaceSession === workspaceSessionId) {
        runningWorkspaceSession = undefined;
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
    const targetSessionId = requestedSessionId || store.getActiveSessionId();
    // A coding task's chat: its runner takes the message, so the server's
    // checks still run. Working, it reads it when its current step ends.
    const linkedSessionId = workspaceSessionFor(targetSessionId);
    if (linkedSessionId && state.linked[linkedSessionId]) {
      if (!options.linkedMessage) {
        throw new HttpError(409, "ask_agent_turn_in_progress");
      }
      if (!(await auth.revalidate()).valid) {
        throw new HttpError(401, "authentication_required");
      }
      const run = followed.get(linkedSessionId);
      // Working: its running turn takes the message in at its next break,
      // like a queued message in VS Code. Otherwise its runner gets it.
      const interjectionId =
        id ?? `ask-agent-interjection-${now()}-${randomSuffix()}`;
      const queued = run
        ? await operations
            .interject(auth, projectOf(linkedSessionId), linkedSessionId, {
              id: interjectionId,
              text,
            })
            .then((result) => result.queued)
            .catch(() => false)
        : false;
      if (queued) {
        shownInterjections.add(interjectionId);
        pendingTaskInterjections.set(interjectionId, {
          workspaceSessionId: linkedSessionId,
          text,
        });
      } else {
        await options.linkedMessage(linkedSessionId, text);
      }
      // Shown now; the chat's record replaces it once the work is read.
      store.appendSessionMessage(targetSessionId, {
        role: "user",
        content: text,
        blocks: [{ type: "text", text }],
        now: now(),
      });
      if (run && !queued) {
        // Its streamed reply goes on below the message.
        run.messageId = store.startAssistantMessage({
          now: now(),
          sessionId: linkedSessionId,
        }).id;
      }
      markRead(targetSessionId);
      const publication = await publishNow();
      sendJson(response, 200, { ok: true, snapshot: publication.snapshot });
      return;
    }
    // A scheduled run is working in that chat: write once it has finished.
    if (followed.has(targetSessionId)) {
      throw new HttpError(409, "ask_agent_turn_in_progress");
    }
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
    const queueId = id ?? `ask-agent-queued-${now()}-${randomSuffix()}`;
    if (busy) {
      if (!store.enqueueMessage({ id: queueId, text, source: "browser" })) {
        throw new HttpError(409, "queue_full");
      }
      void publishNow();
      // Also offered to the running turn, which takes it in at its next
      // break (VS Code's interjection); if it ends first, the message runs
      // as the next turn from the queue, as before.
      const running = runningWorkspaceSession;
      if (running) {
        void operations
          .interject(auth, projectOf(running), running, { id: queueId, text })
          .catch(() => undefined);
      }
    }
    const previous = turnChain;
    let release!: () => void;
    turnChain = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await previous;
      if (busy) {
        // Taken in by the turn it waited for: already answered there.
        if (admittedInterjections.delete(queueId)) {
          const publication = await publishNow();
          if (!response.writableEnded && !response.destroyed) {
            sendJson(response, 200, {
              ok: true,
              snapshot: publication.snapshot,
            });
          }
          return;
        }
        store.removeQueuedMessage(queueId);
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
      const storeSessionId = store.getActiveSessionId();
      // A new chat's session exists now: watch it for agents it starts.
      watchActiveAgents(auth);
      trackParent(workspaceSessionId);
      delivery.stopped.delete(workspaceSessionId);
      markRead(storeSessionId);
      store.appendUserMessage({ ...(id ? { id } : {}), text, now: now() });
      const assistant = store.startAssistantMessage({ now: now() });
      const turn = controller.beginTurn(assistant.id);
      if (!turn) throw new HttpError(409, "ask_agent_turn_in_progress");
      runningSession = storeSessionId;
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
        runningSession = undefined;
        // Finished while the owner was in another chat, or had no window
        // open: flag it until they look.
        await flagUnread(storeSessionId, workspaceSessionId);
      }
      // Agents that finished during the turn and were not collected by it.
      void checkParent(workspaceSessionId);
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
    const agentApproval = parseAgentApprovalId(body.id);
    if (agentApproval) {
      const shown = agentApprovalRequest(agentWatch.records);
      if (!shown || shown.id !== body.id) {
        throw new HttpError(404, "approval_not_found");
      }
      await operations.answerAgentApproval(
        auth,
        projectOf(agentWatch.sessionId ?? ""),
        watchedAgent(agentApproval.childSessionId),
        agentApproval.childSessionId,
        {
          interactionId: agentApproval.interactionId,
          decision: ALLOW_DECISIONS.has(body.decision) ? "allow" : "deny",
        },
      );
      await refreshAgents();
      const publication = await publishNow();
      sendJson(response, 200, { ok: true, snapshot: publication.snapshot });
      return;
    }
    if (body.id.startsWith(RUN_APPROVAL_PREFIX)) {
      const run = [...followed.values()].find(
        (candidate) => candidate.approval?.request.id === body.id,
      );
      const waiting = run?.approval;
      if (!run || !waiting) throw new HttpError(404, "approval_not_found");
      await operations.answerInteraction(
        auth,
        projectOf(run.workspaceSessionId),
        run.workspaceSessionId,
        {
          interactionId: waiting.interactionId,
          interactionRevision: waiting.interactionRevision,
          decision: ALLOW_DECISIONS.has(body.decision) ? "allow" : "deny",
        },
      );
      if (run.approval === waiting) run.approval = undefined;
      const publication = await publishNow();
      sendJson(response, 200, { ok: true, snapshot: publication.snapshot });
      return;
    }
    const pending = pendingInteraction;
    const approval = controller.getPendingApproval();
    if (!pending || !approval || approval.id !== body.id) {
      throw new HttpError(404, "approval_not_found");
    }
    await operations.answerInteraction(
      auth,
      projectOf(pending.workspaceSessionId),
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
    // Stop pressed in a chat a scheduled run is working in: stop the run.
    const run = followed.get(store.getActiveSessionId());
    if (run) {
      if (options.stopRun) await options.stopRun(run.workspaceSessionId);
      else {
        await operations
          .cancel(
            auth,
            projectOf(run.workspaceSessionId),
            run.workspaceSessionId,
          )
          .catch(() => undefined);
      }
      const publication = await publishNow();
      sendJson(response, 200, {
        ok: true,
        stopped: true,
        snapshot: publication.snapshot,
      });
      return;
    }
    // The running turn may be in another chat (a background result).
    const storeSessionId = runningSession ?? store.getActiveSessionId();
    const stoppedSessionId = workspaceSessionFor(storeSessionId);
    // No wake-ups for this chat until the owner writes to it again.
    if (stoppedSessionId) delivery.stopped.add(stoppedSessionId);
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
          .cancel(auth, projectOf(workspaceSessionId), workspaceSessionId)
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

  /** Open a chat, resuming its live state if a turn or run works in it. */
  const loadChat = (sessionId: string): boolean => {
    if (
      !store.loadSession(sessionId, {
        streaming:
          followed.has(sessionId) ||
          (runningSession === sessionId && controller.hasActiveTurn()),
      })
    ) {
      return false;
    }
    markRead(sessionId);
    const workspaceSessionId = workspaceSessionFor(sessionId);
    const model = workspaceSessionId
      ? sessionModels.get(workspaceSessionId)
      : undefined;
    if (model) store.setModel(modelKey(model));
    return true;
  };

  /**
   * Follow a chat something else works in (a scheduled run, a coding task):
   * project its events as they happen, below its history when it has one.
   */
  const followRun = (
    workspaceSessionId: string,
    run: {
      readonly title: string;
      readonly prompt: string;
      readonly history?: BrowserGatewayAskAgentPersistedSession;
    },
  ) => {
    const at = now();
    const session: BrowserGatewayAskAgentPersistedSession = run.history
      ? { ...run.history, title: run.title, lastActiveAt: at }
      : {
          id: workspaceSessionId,
          title: run.title,
          createdAt: at,
          lastActiveAt: at,
          messages: run.prompt
            ? [
                {
                  id: `${workspaceSessionId}-prompt`,
                  role: "user",
                  content: run.prompt,
                  timestamp: at,
                  blocks: [{ type: "text", text: run.prompt }],
                },
              ]
            : [],
          nextMessageSequence: 1,
        };
    store.upsertSession(session);
    const message = store.startAssistantMessage({
      now: at,
      sessionId: workspaceSessionId,
    });
    const entry: FollowedRun = {
      workspaceSessionId,
      session,
      messageId: message.id,
      toolStarts: new Map(),
      approval: undefined,
      subscription: undefined,
    };
    followed.set(workspaceSessionId, entry);

    const onEvent = ({ event }: SequencedSessionEvent) => {
      if (followed.get(workspaceSessionId) !== entry) return;
      if (event.kind === "task") {
        // Answered (here or on another device): the run goes on.
        if (event.state === "started" && entry.approval) {
          entry.approval = undefined;
          void publishNow();
        }
        if (event.state !== "started")
          handOverInterjections(workspaceSessionId);
        return;
      }
      if (event.kind !== "turn") return;
      const turnEvent = event.event;
      if (turnEvent.type === "user.interjected") {
        entry.messageId = admitInterjection(
          workspaceSessionId,
          turnEvent.interjectionId,
          turnEvent.text,
        );
        return;
      }
      if (projectTurnContent(entry.messageId, entry.toolStarts, turnEvent)) {
        return;
      }
      if (turnEvent.type === "interaction.required") {
        const request = approvalFor(turnEvent);
        entry.approval = {
          workspaceSessionId,
          interactionId: turnEvent.interaction.interactionId,
          interactionRevision: turnEvent.interactionRevision,
          request: {
            ...request,
            id: `${RUN_APPROVAL_PREFIX}${workspaceSessionId}:${turnEvent.interaction.interactionId}`,
          },
        };
        void publishNow();
      }
    };
    const key = operations.sessionKey(
      projectOf(workspaceSessionId),
      workspaceSessionId,
    );
    // From the start: events before this call belong to the run too.
    const subscription = options.events.subscribe(key, 0, onEvent);
    entry.subscription = subscription;
    if (!subscription.reset) {
      for (const event of subscription.replay) onEvent(event);
    }
    void publishNow();
  };

  /**
   * A task's turn ended without taking messages sent into it: its runner
   * gets them, so it reads them in its next step.
   */
  const handOverInterjections = (workspaceSessionId: string) => {
    for (const [id, pending] of pendingTaskInterjections) {
      if (pending.workspaceSessionId !== workspaceSessionId) continue;
      pendingTaskInterjections.delete(id);
      shownInterjections.delete(id);
      void options
        .linkedMessage?.(workspaceSessionId, pending.text)
        ?.catch(() => undefined);
    }
  };

  /** Stop following a run; its chat stays. */
  const unfollowRun = (workspaceSessionId: string) => {
    handOverInterjections(workspaceSessionId);
    pendingFollows.delete(workspaceSessionId);
    const entry = followed.get(workspaceSessionId);
    if (!entry) return;
    entry.subscription?.unsubscribe();
    followed.delete(workspaceSessionId);
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

  /** The open chat's background agents: transcript, stop, and steer. */
  const handleBackground = async (
    pathname: string,
    request: IncomingMessage,
    response: ServerResponse,
    auth: AssistantServerAuth,
  ) => {
    const body = await readJsonBody(
      request,
      MAX_STEERING_BYTES * 2,
      auth.signal,
    );
    const childSessionId =
      typeof body.sessionId === "string" ? body.sessionId.trim() : "";
    // Through the open chat only, as in the VS Code fleet.
    if (!childSessionId) throw new HttpError(400, "invalid_request");
    const parent = watchedAgent(childSessionId);
    switch (pathname) {
      case "/api/ask-agent/background/transcript": {
        const transcript = await operations.readAgentTranscript(
          auth,
          projectOf(parent),
          parent,
          childSessionId,
        );
        sendJson(response, 200, {
          ok: true,
          transcript: { sessionId: childSessionId, ...transcript },
        });
        return;
      }
      case "/api/ask-agent/background/stop":
        await operations.stopAgent(
          auth,
          projectOf(parent),
          parent,
          childSessionId,
        );
        // The owner stopped it: nothing to report back to the chat.
        delivery.handled.add(childSessionId);
        break;
      case "/api/ask-agent/background/steer": {
        const message = typeof body.message === "string" ? body.message : "";
        await operations.steerAgent(
          auth,
          projectOf(parent),
          parent,
          childSessionId,
          message,
        );
        break;
      }
      default:
        throw new HttpError(404, "not_found");
    }
    await refreshAgents();
    await publishNow();
    sendJson(response, 200, { ok: true });
  };

  const handleRequest = async (
    request: IncomingMessage,
    response: ServerResponse,
    auth: AssistantServerAuth,
  ): Promise<boolean> => {
    try {
      return await routeRequest(request, response, auth);
    } finally {
      // Follow chat switches, new chats, and deletions.
      if (!closed) watchActiveAgents(auth);
    }
  };

  const routeRequest = async (
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
          markRead(store.getActiveSessionId());
          sendJson(response, 200, snapshotResponse());
          return true;
        case "/api/ask-agent/sessions":
          sendJson(response, 200, {
            sessions: store.listSessions().map((session) => {
              const activity = activityOf(session.id);
              const workspaceSessionId = workspaceSessionFor(session.id);
              const kind = kindOf(workspaceSessionId);
              return {
                ...session,
                ...(activity ? { activity } : {}),
                ...(kind === "job_run" ? { scheduled: true } : {}),
                kind,
              };
            }),
          });
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

    if (pathname.startsWith("/api/ask-agent/background/")) {
      await handleBackground(pathname, request, response, auth);
      return true;
    }

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
      case "/api/ask-agent/approval-mode":
        await handleApprovalMode(request, response, auth);
        return true;
      case "/api/ask-agent/session/new": {
        const { sessionId } = await readSessionId(request, auth).catch(() => ({
          sessionId: "",
        }));
        if (sessionId && !isBrowserGatewayAskAgentSessionId(sessionId)) {
          throw new HttpError(400, "ask_agent_session_id_invalid");
        }
        store.createSession(now(), undefined, sessionId || undefined);
        applyDefaults();
        const publication = await publishNow();
        sendJson(response, 200, { ok: true, snapshot: publication.snapshot });
        return true;
      }
      case "/api/ask-agent/session/load": {
        const { sessionId } = await readSessionId(request, auth);
        if (!sessionId || !loadChat(sessionId)) {
          throw new HttpError(404, "ask_agent_session_not_found");
        }
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
          followed.has(sessionId) ||
          (controller.hasActiveTurn() &&
            (sessionId === runningSession ||
              sessionId === store.getActiveSessionId()))
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
    activity() {
      let running = 0;
      let needsYou = 0;
      let unread = 0;
      for (const session of store.listSessions()) {
        const activity = activityOf(session.id);
        if (activity === "running") running += 1;
        else if (activity === "needs-you") needsYou += 1;
        else if (activity === "unread") unread += 1;
      }
      return { running, needsYou, unread };
    },
    async adoptSession(auth, workspaceSessionId, title) {
      if (closed) return;
      unfollowRun(workspaceSessionId);
      state.titles[workspaceSessionId] = title.slice(0, MAX_TITLE_LENGTH);
      if (
        !state.linked[workspaceSessionId] &&
        !state.scheduled.includes(workspaceSessionId)
      ) {
        state.scheduled.push(workspaceSessionId);
      }
      // Unread unless the owner is watching it finish.
      const watching =
        store.getActiveSessionId() === workspaceSessionId && sse.size > 0;
      if (!watching && !state.unread.includes(workspaceSessionId)) {
        state.unread.push(workspaceSessionId);
      }
      await saveState().catch(() => undefined);
      // Not loaded yet: it loads with every other chat on the first visit.
      if (!loaded) return;
      try {
        await loaded;
        if (closed) return;
        // The run's own record replaces what was streamed live.
        const session = await readHistorySession(
          auth,
          workspaceSessionId,
          undefined,
        );
        if (!session || closed) return;
        session.title = state.titles[workspaceSessionId] ?? session.title;
        store.upsertSession(session);
        // Watching it: its live state ends with the run.
        if (
          store.getActiveSessionId() === workspaceSessionId &&
          !controller.hasActiveTurn()
        ) {
          store.loadSession(workspaceSessionId);
        }
        await publishNow();
      } catch {
        // It still appears, unread, the next time chats load.
      }
    },
    deliverTaskResult,
    followSession(auth, workspaceSessionId, run) {
      if (
        closed ||
        followed.has(workspaceSessionId) ||
        pendingFollows.has(workspaceSessionId)
      ) {
        return;
      }
      state.titles[workspaceSessionId] = run.title.slice(0, MAX_TITLE_LENGTH);
      const linked = state.linked[workspaceSessionId] !== undefined;
      if (!linked && !state.scheduled.includes(workspaceSessionId)) {
        state.scheduled.push(workspaceSessionId);
      }
      void saveState().catch(() => undefined);
      if (!linked) {
        followRun(workspaceSessionId, {
          title: state.titles[workspaceSessionId]!,
          prompt: run.prompt,
        });
        return;
      }
      // A task's chat: its history stays, and its new work streams below.
      pendingFollows.add(workspaceSessionId);
      void (async () => {
        const history = await readHistorySession(
          auth,
          workspaceSessionId,
          undefined,
        ).catch(() => undefined);
        // Ended (adopted) while its history was read: nothing to follow.
        if (!pendingFollows.delete(workspaceSessionId) || closed) return;
        followRun(workspaceSessionId, {
          title: state.titles[workspaceSessionId]!,
          prompt: history ? "" : run.prompt,
          ...(history ? { history } : {}),
        });
      })();
    },
    async linkSession(auth, workspaceSessionId, link) {
      if (closed) return;
      const known = state.linked[workspaceSessionId];
      if (known?.projectId === link.projectId) return;
      state.linked[workspaceSessionId] = {
        projectId: link.projectId,
        kind: "task",
      };
      state.titles[workspaceSessionId] = link.title.slice(0, MAX_TITLE_LENGTH);
      await saveState().catch(() => undefined);
      // Not loaded yet: it loads with every other chat on the first visit.
      if (!loaded) return;
      await loaded.catch(() => undefined);
      if (closed || followed.has(workspaceSessionId)) return;
      const session = await readHistorySession(
        auth,
        workspaceSessionId,
        undefined,
      );
      if (!session || closed) return;
      store.upsertSession(session);
      await publishNow();
    },
    async unlinkSession(workspaceSessionId) {
      if (!state.linked[workspaceSessionId]) return;
      unfollowRun(workspaceSessionId);
      delete state.linked[workspaceSessionId];
      delete state.titles[workspaceSessionId];
      state.unread = state.unread.filter((id) => id !== workspaceSessionId);
      await saveState().catch(() => undefined);
      if (store.hasSession(workspaceSessionId)) {
        store.deleteSession(workspaceSessionId, now());
        await publishNow().catch(() => undefined);
      }
    },
    async openSession(auth, sessionId) {
      if (closed) return false;
      await ensureLoaded(auth);
      if (!loadChat(sessionId)) return false;
      watchActiveAgents(auth);
      await publishNow();
      return true;
    },
    refresh() {
      if (closed || sse.size === 0) return;
      void publishNow().catch(() => undefined);
    },
    async close() {
      closed = true;
      for (const id of followed.keys()) unfollowRun(id);
      agentWatch.subscription?.unsubscribe();
      for (const subscription of delivery.parents.values()) {
        subscription.unsubscribe();
      }
      delivery.parents.clear();
      if (agentWatch.timer) clearTimeout(agentWatch.timer);
      await agentWatch.refreshing;
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
      return {
        aliases: {},
        titles: {},
        hidden: [],
        unread: [],
        scheduled: [],
        linked: {},
      };
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
    hidden: stringList(parsed.hidden),
    unread: stringList(parsed.unread),
    scheduled: stringList(parsed.scheduled),
    linked: linkedRecord(parsed.linked),
  };
}

function linkedRecord(value: unknown): BridgeState["linked"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const linked: BridgeState["linked"] = {};
  for (const [sessionId, link] of Object.entries(value)) {
    const projectId = (link as { projectId?: unknown } | null)?.projectId;
    if (typeof projectId === "string") {
      linked[sessionId] = { projectId, kind: "task" };
    }
  }
  return linked;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((id): id is string => typeof id === "string")
    : [];
}

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function isReasoningEffort(value: string): value is CoreReasoningEffort {
  return isCoreReasoningEffort(value);
}

function hasItems(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

function randomSuffix(): string {
  return randomUUID().slice(0, 8);
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
