import type {
  AgentInteractionRequest,
  AgentModelReference,
  AgentTurnAttachment,
  AgentTurnEvent,
  AgentTurnResult,
  CoreQualifiedModelCatalogEntry,
  CoreReasoningEffort,
} from "@agentlink/core";
import type {
  WorkspaceBackgroundRecord,
  WorkspaceCommandObservation,
  WorkspaceCommandRecord,
  WorkspaceCommandRule,
  WorkspaceHost,
  WorkspaceHostSession,
} from "@agentlink/workspace-host";

import {
  initialStandaloneSessionProjection,
  reduceStandaloneSessionProjection,
  type StandaloneBackgroundAgentProjection,
  type StandaloneCommandObservation,
  type StandaloneCommandProjection,
  type StandaloneMcpServerProjection,
  type StandaloneSessionProjection,
  type StandaloneSessionProjectionAction,
  type StandaloneSessionSummary,
  type StandaloneTranscriptAttachment,
} from "./sessionProjection.js";

export interface StandaloneSessionControllerOptions {
  readonly host: Omit<WorkspaceHost, "runTurn"> & {
    runTurn(
      sessionId: string,
      text: string,
      options?: {
        readonly attachments?: readonly AgentTurnAttachment[];
        readonly signal?: AbortSignal;
        readonly onEvent?: (event: AgentTurnEvent) => void;
      },
    ): Promise<AgentTurnResult>;
  };
  readonly requestedSession?: string;
  readonly onTurnEvent?: (event: AgentTurnEvent) => void;
}

export interface StandaloneSessionInitialization {
  readonly sessionId: string;
  readonly restored: boolean;
  readonly recovered: boolean;
  readonly pendingInteraction?: AgentInteractionRequest;
}

export interface StandaloneCommandRule {
  readonly command: string;
  readonly cwd: string;
  readonly mode: "foreground" | "background";
  readonly decision: "allow" | "prompt" | "forbidden";
}

export interface StandaloneSubmitAttachment {
  readonly display: StandaloneTranscriptAttachment;
  readonly model?: AgentTurnAttachment;
}

export interface StandaloneSessionController {
  getState(): StandaloneSessionProjection;
  subscribe(
    listener: (
      state: StandaloneSessionProjection,
      action: StandaloneSessionProjectionAction,
    ) => void,
  ): () => void;
  initialize(): Promise<StandaloneSessionInitialization>;
  submit(
    text: string,
    attachments?: readonly StandaloneSubmitAttachment[],
  ): Promise<AgentTurnResult>;
  resumeInteraction(decision: "allow" | "deny"): Promise<AgentTurnResult>;
  cancel(reason?: string): Promise<void>;
  newSession(): Promise<string>;
  listSessions(): Promise<readonly StandaloneSessionSummary[]>;
  selectSession(sessionId: string): Promise<string>;
  listModels(): Promise<readonly CoreQualifiedModelCatalogEntry[]>;
  setModel(model: AgentModelReference): Promise<void>;
  setReasoningEffort(reasoningEffort: CoreReasoningEffort): Promise<void>;
  refreshActivity(): StandaloneSessionProjection;
  refreshMcpState(): Promise<StandaloneSessionProjection>;
  observeCommand(
    commandId: string,
    options?: { readonly offset?: number; readonly limitBytes?: number },
  ): StandaloneCommandObservation;
  stopCommand(commandId: string): Promise<StandaloneCommandProjection>;
  steerBackgroundAgent(
    childSessionId: string,
    message: string,
  ): Promise<{ readonly status: "queued" | "already_pending" }>;
  stopBackgroundAgent(
    childSessionId: string,
    reason?: string,
  ): Promise<StandaloneBackgroundAgentProjection>;
  respondToBackgroundApproval(
    childSessionId: string,
    interactionId: string,
    decision: "allow" | "deny",
  ): Promise<void>;
  validatePendingInteraction(): Promise<
    { readonly ok: true } | { readonly ok: false; reason: string }
  >;
  acknowledgeBackgroundCommand(commandId: string): void;
  addCommandRule(rule: StandaloneCommandRule): Promise<void>;
  runPrompt<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T>;
  notifyBackgroundApproval(): void;
  cancelPrompts(reason?: string): void;
  close(): Promise<void>;
}

export function createStandaloneSessionController(
  options: StandaloneSessionControllerOptions,
): StandaloneSessionController {
  const listeners = new Set<
    (
      state: StandaloneSessionProjection,
      action: StandaloneSessionProjectionAction,
    ) => void
  >();
  let state = initialStandaloneSessionProjection(options.host.project.root);
  let sessionId: string | undefined;
  let activeController: AbortController | undefined;
  let activeTurn: Promise<AgentTurnResult> | undefined;
  let initialization: StandaloneSessionInitialization | undefined;
  let closed = false;
  let promptTail: Promise<void> = Promise.resolve();
  const promptController = new AbortController();

  const dispatch = (action: StandaloneSessionProjectionAction) => {
    if (closed && action.type !== "controller.closed") return;
    state = reduceStandaloneSessionProjection(state, action);
    for (const listener of listeners) listener(state, action);
  };
  const requireSession = (): string => {
    if (closed) throw new Error("Session controller is closed");
    if (!initialization || !sessionId) {
      throw new Error("Standalone session controller is not initialized");
    }
    return sessionId;
  };
  const captureEvent = (expectedSessionId: string, event: AgentTurnEvent) => {
    if (
      closed ||
      sessionId !== expectedSessionId ||
      event.sessionId !== expectedSessionId
    ) {
      return;
    }
    dispatch({ type: "turn.event", event });
    options.onTurnEvent?.(event);
  };
  const refreshActivity = (): StandaloneSessionProjection => {
    if (!sessionId || closed) return state;
    const commands = options.host
      .listCommands({ sessionId })
      .map(projectCommandRecord);
    const backgroundAgents = options.host
      .listBackgroundAgents(sessionId)
      .map(projectBackgroundRecord);
    const backgroundApprovals = options.host
      .listBackgroundApprovals(sessionId)
      .map(projectBackgroundRecord);
    const todos = options.host.readSessionInteractions(sessionId).todos;
    if (
      sameValue(state.commands, commands) &&
      sameValue(state.backgroundAgents, backgroundAgents) &&
      sameValue(state.backgroundApprovals, backgroundApprovals) &&
      sameValue(state.todos, todos)
    ) {
      return state;
    }
    dispatch({
      type: "activity.refreshed",
      commands,
      backgroundAgents,
      backgroundApprovals,
    });
    if (!sameValue(state.todos, todos)) {
      dispatch({ type: "todos.refreshed", todos });
    }
    return state;
  };
  const refreshMcpState = async (): Promise<StandaloneSessionProjection> => {
    if (!sessionId || closed) return state;
    const configuration = await options.host.readMcpConfiguration();
    const servers: readonly StandaloneMcpServerProjection[] =
      configuration?.servers.map(({ id, source, transport }) => ({
        id,
        source,
        transport,
      })) ?? [];
    if (sameValue(state.mcpServers, servers)) return state;
    dispatch({ type: "mcp.refreshed", servers });
    return state;
  };
  const runPrompt = <T>(
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> => {
    if (closed || promptController.signal.aborted) {
      return Promise.reject(new Error("Session controller is closed"));
    }
    const execute = () => {
      if (promptController.signal.aborted) {
        throw new Error("Session prompts are cancelled");
      }
      return operation(promptController.signal);
    };
    const result = promptTail.then(execute, execute);
    promptTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  const stopChildren = async (reason: string): Promise<void> => {
    if (!sessionId) return;
    await Promise.all(
      options.host
        .listBackgroundAgents(sessionId)
        .filter((record) =>
          ["queued", "running", "awaiting_approval"].includes(record.lifecycle),
        )
        .map((record) =>
          options.host.stopBackgroundAgent({
            callerSessionId: sessionId!,
            childSessionId: record.childSessionId,
            reason,
          }),
        ),
    );
  };
  const selectExistingSession = async (
    nextSessionId: string,
  ): Promise<StandaloneSessionInitialization> => {
    const hydration = await options.host.readSession(nextSessionId);
    sessionId = nextSessionId;
    dispatch({
      type: "session.selected",
      sessionId: nextSessionId,
      messages: hydration.record.messages,
      activeTurnId:
        hydration.record.runState.phase === "suspended"
          ? hydration.record.runState.turnId
          : undefined,
      model: hydration.record.selectedModel,
      reasoningEffort: hydration.record.reasoningEffort,
      todos: options.host.readSessionInteractions(nextSessionId).todos,
      usage: hydration.record.usage,
    });
    let recovered = false;
    if (hydration.record.runState.phase === "suspended") {
      const interaction = hydration.pendingInteraction?.request;
      if (!interaction) {
        const reason = "Restored session has no pending interaction";
        await options.host.cancel(nextSessionId, reason);
        dispatch({ type: "controller.failed", error: reason });
      } else {
        dispatch({ type: "interaction.restored", interaction });
      }
    } else if (
      hydration.record.runState.phase === "running" ||
      hydration.record.runState.phase === "resuming"
    ) {
      await options.host.recoverInterrupted(nextSessionId);
      recovered = true;
      dispatch({ type: "session.recovered" });
    }
    refreshActivity();
    return {
      sessionId: nextSessionId,
      restored: true,
      recovered,
      pendingInteraction: state.pendingInteraction,
    };
  };

  const runActiveTurn = async (
    start: (
      signal: AbortSignal,
      onEvent: (event: AgentTurnEvent) => void,
    ) => Promise<AgentTurnResult>,
  ): Promise<AgentTurnResult> => {
    const expectedSessionId = requireSession();
    if (activeTurn) throw new Error("A session turn is already active");
    const controller = new AbortController();
    activeController = controller;
    const running = Promise.resolve(
      start(controller.signal, (event) =>
        captureEvent(expectedSessionId, event),
      ),
    );
    activeTurn = running;
    try {
      const result = await running;
      if (!closed && sessionId === expectedSessionId) {
        dispatch({ type: "turn.result", result });
      }
      return result;
    } catch (error) {
      if (!closed && sessionId === expectedSessionId) {
        dispatch({
          type: "controller.failed",
          error: error instanceof Error ? error.message : String(error),
        });
      }
      throw error;
    } finally {
      if (activeController === controller) activeController = undefined;
      if (activeTurn === running) activeTurn = undefined;
      refreshActivity();
    }
  };

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async initialize() {
      if (initialization) return initialization;
      if (closed) throw new Error("Session controller is closed");
      const sessions = await options.host.listSessions();
      sessionId = options.requestedSession ?? sessions[0]?.sessionId;
      let restored = false;
      let recovered = false;
      if (sessionId) {
        restored = true;
        const selected = await selectExistingSession(sessionId);
        recovered = selected.recovered;
      } else {
        sessionId = (await options.host.createSession()).sessionId;
        dispatch({ type: "session.new", sessionId });
      }
      initialization = {
        sessionId,
        restored,
        recovered,
        pendingInteraction: state.pendingInteraction,
      };
      refreshActivity();
      await refreshMcpState();
      return initialization;
    },
    async submit(text, attachments = []) {
      const currentSession = requireSession();
      if (activeTurn) throw new Error("A session turn is already active");
      const trimmed = text.trim();
      if (!trimmed && attachments.length === 0) {
        throw new Error("A session turn requires text or an attachment");
      }
      const prompt = trimmed || "Review the attached files.";
      dispatch({
        type: "user.submitted",
        text: prompt,
        attachments: attachments.map((attachment) => attachment.display),
      });
      return await runActiveTurn((signal, onEvent) =>
        options.host.runTurn(currentSession, prompt, {
          attachments: attachments.flatMap((attachment) =>
            attachment.model ? [attachment.model] : [],
          ),
          signal,
          onEvent,
        }),
      );
    },
    async resumeInteraction(decision) {
      const currentSession = requireSession();
      if (activeTurn) throw new Error("A session turn is already active");
      if (decision === "allow") {
        const current =
          await options.host.revalidatePendingInteraction(currentSession);
        if (!current.ok) {
          const reason = `Stale proposal rejected: ${current.reason}`;
          await options.host.cancel(currentSession, reason);
          dispatch({ type: "session.cancelled" });
          dispatch({ type: "controller.failed", error: reason });
          throw new Error(reason);
        }
      }
      return await runActiveTurn((signal, onEvent) =>
        options.host.resumeInteraction(currentSession, decision, {
          signal,
          onEvent,
        }),
      );
    },
    async cancel(reason = "Cancelled by user") {
      const currentSession = requireSession();
      const hasActiveState = Boolean(activeTurn || state.pendingInteraction);
      if (hasActiveState) dispatch({ type: "turn.cancelling" });
      activeController?.abort(reason);
      try {
        await options.host.cancel(currentSession, reason);
        if (hasActiveState && !closed) dispatch({ type: "session.cancelled" });
      } catch (error) {
        if (hasActiveState && !closed) dispatch({ type: "session.cancelled" });
        if (!closed) {
          dispatch({
            type: "controller.failed",
            error: error instanceof Error ? error.message : String(error),
          });
        }
        throw error;
      } finally {
        refreshActivity();
      }
    },
    async newSession() {
      requireSession();
      if (activeTurn)
        throw new Error("Cannot switch sessions during an active turn");
      await stopChildren("Parent started a new session");
      sessionId = (await options.host.createSession()).sessionId;
      initialization = {
        sessionId,
        restored: false,
        recovered: false,
        pendingInteraction: undefined,
      };
      dispatch({ type: "session.new", sessionId });
      refreshActivity();
      await refreshMcpState();
      return sessionId;
    },
    async listSessions() {
      return (await options.host.listSessions()).map(projectSessionSummary);
    },
    async selectSession(nextSessionId) {
      if (closed) throw new Error("Session controller is closed");
      if (activeTurn)
        throw new Error("Cannot switch sessions during an active turn");
      if (nextSessionId === sessionId) return nextSessionId;
      await stopChildren("Parent switched sessions");
      initialization = await selectExistingSession(nextSessionId);
      await refreshMcpState();
      return nextSessionId;
    },
    async listModels() {
      return (await options.host.listModels()).models;
    },
    async setModel(model) {
      const currentSession = requireSession();
      if (activeTurn)
        throw new Error("Cannot change model during an active turn");
      await options.host.setSessionModel(currentSession, model);
      dispatch({
        type: "session.settings",
        model,
        reasoningEffort: state.reasoningEffort,
      });
    },
    async setReasoningEffort(reasoningEffort) {
      const currentSession = requireSession();
      if (activeTurn)
        throw new Error("Cannot change reasoning during an active turn");
      await options.host.setSessionReasoningEffort(
        currentSession,
        reasoningEffort,
      );
      dispatch({
        type: "session.settings",
        model: state.model,
        reasoningEffort,
      });
    },
    refreshActivity,
    refreshMcpState,
    observeCommand(commandId, observationOptions) {
      return projectCommandObservation(
        options.host.observeCommand(
          commandId,
          { sessionId: requireSession() },
          observationOptions,
        ),
      );
    },
    async stopCommand(commandId) {
      return projectCommandRecord(
        await options.host.stopCommand(commandId, {
          sessionId: requireSession(),
        }),
      );
    },
    steerBackgroundAgent(childSessionId, message) {
      return options.host.steerBackgroundAgent({
        callerSessionId: requireSession(),
        childSessionId,
        message,
      });
    },
    async stopBackgroundAgent(
      childSessionId,
      reason = "Stopped from terminal",
    ) {
      return projectBackgroundRecord(
        await options.host.stopBackgroundAgent({
          callerSessionId: requireSession(),
          childSessionId,
          reason,
        }),
      );
    },
    async respondToBackgroundApproval(childSessionId, interactionId, decision) {
      await options.host.respondToBackgroundApproval({
        callerSessionId: requireSession(),
        childSessionId,
        interactionId,
        decision,
      });
      refreshActivity();
    },
    validatePendingInteraction() {
      return options.host.revalidatePendingInteraction(requireSession());
    },
    acknowledgeBackgroundCommand(commandId) {
      options.host.acknowledgeBackgroundCommand(commandId);
    },
    addCommandRule(rule) {
      const hostRule: WorkspaceCommandRule = {
        command: rule.command,
        cwd: rule.cwd,
        mode: rule.mode,
        decision: rule.decision,
      };
      return options.host.addCommandRule(hostRule);
    },
    runPrompt,
    notifyBackgroundApproval() {
      refreshActivity();
    },
    cancelPrompts(reason = "Session prompts cancelled") {
      if (!promptController.signal.aborted) promptController.abort(reason);
    },
    async close() {
      if (closed) return;
      closed = true;
      promptController.abort("Session controller closed");
      const running = activeTurn;
      if (running && sessionId) {
        activeController?.abort("Session controller closed");
        await options.host
          .cancel(sessionId, "Session controller closed")
          .catch(() => undefined);
        await running.catch(() => undefined);
      }
      await promptTail;
      try {
        await options.host.close();
      } finally {
        dispatch({ type: "controller.closed" });
        listeners.clear();
      }
    },
  };
}

function projectSessionSummary(
  session: WorkspaceHostSession,
): StandaloneSessionSummary {
  return {
    sessionId: session.sessionId,
    updatedAt: session.updatedAt,
    state: session.state,
    model: session.model,
    reasoningEffort: session.reasoningEffort,
  };
}

function projectCommandRecord(
  record: WorkspaceCommandRecord,
): StandaloneCommandProjection {
  return {
    commandId: record.commandId,
    command: record.command,
    mode: record.mode,
    state: record.state,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    exitCode: record.exitCode,
    signal: record.signal,
    outputDroppedBytes: record.outputDroppedBytes,
  };
}

function projectCommandObservation(
  observation: WorkspaceCommandObservation,
): StandaloneCommandObservation {
  return {
    record: projectCommandRecord(observation.record),
    requestedOffset: observation.requestedOffset,
    nextOffset: observation.nextOffset,
    truncatedBeforeOffset: observation.truncatedBeforeOffset,
    output: observation.output.map((chunk) => ({
      stream: chunk.stream,
      offset: chunk.offset,
      text: chunk.text,
    })),
  };
}

function projectBackgroundRecord(
  record: WorkspaceBackgroundRecord,
): StandaloneBackgroundAgentProjection {
  return {
    childSessionId: record.childSessionId,
    task: record.task,
    lifecycle: record.lifecycle,
    phase: record.phase,
    resultState: record.resultState,
    currentTool: record.currentTool,
    resultText: record.resultText,
    partialOutput: record.partialOutput,
    terminalReason: record.terminalReason,
    approval: record.approval
      ? {
          interactionId: record.approval.interactionId,
          toolName: record.approval.toolName,
          summary: record.approval.summary,
          displayContent: record.approval.displayContent,
        }
      : undefined,
    steeringQueued: record.steeringQueued,
  };
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
