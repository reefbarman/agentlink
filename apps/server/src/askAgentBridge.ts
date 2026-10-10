import type { AgentModelReference } from "@agentlink/core";
import type { ApprovalRequest } from "@agentlink/protocol/approval-transport";
import { isBrowserGatewayAskAgentSessionId } from "@agentlink/protocol/browser-gateway-ask-agent-identity";
import type { ChatSessionActivity } from "@agentlink/protocol/chat-session-history";
import type { BrowserGatewayThemeSnapshot } from "@agentlink/protocol/browser-gateway-theme";
import {
  isCoreReasoningEffort,
  type CoreReasoningEffort,
  type EmbeddedAgentTurnEvent,
} from "@agentlink/protocol";
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
   * chat list, titled and unread, once its work has finished.
   */
  adoptSession(
    auth: AssistantServerAuth,
    workspaceSessionId: string,
    title: string,
  ): Promise<void>;
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
}

type ApprovalMode = "autonomous" | "ask";

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
  /** The UI session whose turn is running, if any. */
  let runningSession: string | undefined;
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
      // A chat's own approval first; then a background agent's.
      approval:
        controller.getPendingApproval() ??
        agentApprovalRequest(agentWatch.records),
      memoryCandidateNudge: null,
    });
    return {
      ...state,
      snapshot: {
        ...state.snapshot,
        background: agentWatch.records.map(toAgentCard),
        approvalMode: activeApprovalMode(),
      },
    };
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
      read = await operations.readSession(auth, projectId, sessionId);
    } catch {
      return undefined;
    }
    sessionModels.set(sessionId, read.model);
    sessionEfforts.set(sessionId, read.reasoningEffort);
    sessionApprovalModes.set(sessionId, read.approvalMode);
    const messages = withAgentResultCards(
      agentMessagesToChatMessages([...read.messages], { baseIndex: 0 }),
    );
    // Agents that ended before this server started are not reported
    // again; ones still running are, when they finish.
    try {
      const agents = await operations.listAgents(auth, projectId, sessionId);
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
      nextMessageSequence: 1,
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
          records = await operations.listAgents(auth, projectId, sessionId);
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
    const key = operations.sessionKey(projectId, sessionId);
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
    const key = operations.sessionKey(projectId, workspaceSessionId);
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
      agents = await operations.listAgents(auth, projectId, workspaceSessionId);
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
      projectId,
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
        await operations.setModel(auth, projectId, existing, model);
        sessionModels.set(existing, model);
      }
      if (effort && sessionEfforts.get(existing) !== effort) {
        await operations.setReasoningEffort(auth, projectId, existing, effort);
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
            projectId,
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
          projectId,
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
        projectId,
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
          projectId,
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
        await operations.stopAgent(auth, projectId, parent, childSessionId);
        // The owner stopped it: nothing to report back to the chat.
        delivery.handled.add(childSessionId);
        break;
      case "/api/ask-agent/background/steer": {
        const message = typeof body.message === "string" ? body.message : "";
        await operations.steerAgent(
          auth,
          projectId,
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
              return activity ? { ...session, activity } : session;
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
        if (
          !sessionId ||
          !store.loadSession(sessionId, {
            // Back to the chat whose turn is still running.
            streaming:
              runningSession === sessionId && controller.hasActiveTurn(),
          })
        ) {
          throw new HttpError(404, "ask_agent_session_not_found");
        }
        markRead(sessionId);
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
          (sessionId === runningSession ||
            sessionId === store.getActiveSessionId())
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
      state.titles[workspaceSessionId] = title.slice(0, MAX_TITLE_LENGTH);
      if (!state.unread.includes(workspaceSessionId)) {
        state.unread.push(workspaceSessionId);
      }
      await saveState().catch(() => undefined);
      // Not loaded yet: it loads with every other chat on the first visit.
      if (!loaded) return;
      // After any running or queued turn: replacing the history mid-turn
      // would drop that turn's live state.
      const previous = turnChain;
      let release!: () => void;
      turnChain = new Promise<void>((resolve) => {
        release = resolve;
      });
      try {
        await previous;
        await loaded;
        if (closed || storeSessionFor(workspaceSessionId)) return;
        const session = await readHistorySession(
          auth,
          workspaceSessionId,
          undefined,
        );
        if (!session || closed) return;
        const history = store.getHistorySnapshot();
        store.loadHistory({
          ...history,
          sessions: [session, ...history.sessions],
        });
        await publishNow();
      } catch {
        // It still appears, unread, the next time chats load.
      } finally {
        release();
      }
    },
    async close() {
      closed = true;
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
      return { aliases: {}, titles: {}, hidden: [], unread: [] };
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
  };
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
