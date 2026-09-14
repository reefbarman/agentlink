import type {
  AgentInteractionRequest,
  AgentModelReference,
  AgentTurnEvent,
  AgentTurnResult,
  CoreModelMessage,
  CoreReasoningEffort,
} from "@agentlink/core";

import type { TodoItem } from "@agentlink/protocol/chat-transcript";

export type StandaloneSessionPhase =
  | "initializing"
  | "idle"
  | "running"
  | "cancelling"
  | "awaiting_approval"
  | "failed"
  | "closed";

export interface StandaloneTranscriptAttachment {
  readonly name: string;
  readonly kind: "image" | "document" | "file";
  readonly mimeType?: string;
  readonly base64?: string;
}

export interface StandaloneTranscriptMessage {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly turnId?: string;
  readonly streaming: boolean;
  readonly attachments?: readonly StandaloneTranscriptAttachment[];
}

export interface StandaloneThinkingActivity {
  readonly thinkingId: string;
  readonly turnId: string;
  readonly sequence: number;
  readonly text: string;
  readonly status: "running" | "completed";
}

export interface StandaloneToolActivity {
  readonly toolCallId: string;
  readonly turnId?: string;
  readonly sequence: number;
  readonly toolName: string;
  readonly effect: "read" | "write" | "external" | "unknown";
  readonly status: "requested" | "running" | "completed" | "failed";
  readonly displayInput?: unknown;
  readonly displayContent?: unknown;
  readonly error?: string;
}

export interface StandaloneSessionSummary {
  readonly sessionId: string;
  readonly updatedAt: number;
  readonly state: string;
  readonly model?: AgentModelReference;
  readonly reasoningEffort?: string;
}

export interface StandaloneCommandProjection {
  readonly commandId: string;
  readonly command: string;
  readonly mode: "foreground" | "background";
  readonly state: string;
  readonly startedAt: number;
  readonly finishedAt?: number;
  readonly exitCode?: number;
  readonly signal?: string;
  readonly outputDroppedBytes: number;
}

export interface StandaloneCommandOutputChunk {
  readonly stream: "stdout" | "stderr";
  readonly offset: number;
  readonly text: string;
}

export interface StandaloneCommandObservation {
  readonly record: StandaloneCommandProjection;
  readonly requestedOffset: number;
  readonly nextOffset: number;
  readonly truncatedBeforeOffset: boolean;
  readonly output: readonly StandaloneCommandOutputChunk[];
}

export interface StandaloneBackgroundApprovalProjection {
  readonly interactionId: string;
  readonly toolName: string;
  readonly summary: string;
  readonly displayContent?: unknown;
}

export interface StandaloneBackgroundAgentProjection {
  readonly childSessionId: string;
  readonly task: string;
  readonly lifecycle: string;
  readonly phase: string;
  readonly resultState: string;
  readonly currentTool?: string;
  readonly resultText?: string;
  readonly partialOutput?: string;
  readonly terminalReason?: string;
  readonly approval?: StandaloneBackgroundApprovalProjection;
  readonly steeringQueued: number;
}

export interface StandaloneMcpServerProjection {
  readonly id: string;
  readonly source: "global" | "project";
  readonly transport: "stdio" | "streamable-http";
}

export interface StandaloneSessionProjection {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly projectRoot: string;
  readonly sessionId?: string;
  readonly phase: StandaloneSessionPhase;
  readonly mode: "code";
  readonly writePolicy: "prompt";
  readonly transcript: readonly StandaloneTranscriptMessage[];
  readonly thinking: readonly StandaloneThinkingActivity[];
  readonly tools: readonly StandaloneToolActivity[];
  readonly pendingInteraction?: AgentInteractionRequest;
  readonly model?: AgentModelReference;
  readonly reasoningEffort?: CoreReasoningEffort;
  readonly todos: readonly TodoItem[];
  readonly queuedMessages: readonly string[];
  readonly activeQuestion?: string;
  readonly usage?: Extract<AgentTurnEvent, { type: "usage.updated" }>["usage"];
  readonly execution?: Extract<
    AgentTurnEvent,
    { type: "execution.updated" }
  >["event"]["snapshot"];
  readonly commands: readonly StandaloneCommandProjection[];
  readonly backgroundAgents: readonly StandaloneBackgroundAgentProjection[];
  readonly backgroundApprovals: readonly StandaloneBackgroundAgentProjection[];
  readonly mcpServers: readonly StandaloneMcpServerProjection[];
  readonly lastResult?: AgentTurnResult;
  readonly error?: string;
}

export type StandaloneSessionProjectionAction =
  | {
      readonly type: "session.selected";
      readonly sessionId: string;
      readonly messages?: readonly CoreModelMessage[];
      readonly activeTurnId?: string;
      readonly model?: AgentModelReference;
      readonly reasoningEffort?: CoreReasoningEffort;
      readonly todos?: readonly TodoItem[];
      readonly usage?: StandaloneSessionProjection["usage"];
    }
  | { readonly type: "session.new"; readonly sessionId: string }
  | { readonly type: "session.recovered" }
  | {
      readonly type: "user.submitted";
      readonly text: string;
      readonly attachments?: readonly StandaloneTranscriptAttachment[];
    }
  | { readonly type: "turn.event"; readonly event: AgentTurnEvent }
  | { readonly type: "turn.result"; readonly result: AgentTurnResult }
  | { readonly type: "turn.cancelling" }
  | { readonly type: "session.cancelled" }
  | {
      readonly type: "interaction.restored";
      readonly interaction: AgentInteractionRequest;
    }
  | {
      readonly type: "activity.refreshed";
      readonly commands: readonly StandaloneCommandProjection[];
      readonly backgroundAgents: readonly StandaloneBackgroundAgentProjection[];
      readonly backgroundApprovals: readonly StandaloneBackgroundAgentProjection[];
    }
  | {
      readonly type: "mcp.refreshed";
      readonly servers: readonly StandaloneMcpServerProjection[];
    }
  | {
      readonly type: "session.settings";
      readonly model?: AgentModelReference;
      readonly reasoningEffort?: CoreReasoningEffort;
    }
  | { readonly type: "todos.refreshed"; readonly todos: readonly TodoItem[] }
  | { readonly type: "controller.failed"; readonly error: string }
  | { readonly type: "controller.closed" };

export function initialStandaloneSessionProjection(
  projectRoot: string,
): StandaloneSessionProjection {
  return {
    schemaVersion: 1,
    revision: 0,
    projectRoot,
    phase: "initializing",
    mode: "code",
    writePolicy: "prompt",
    transcript: [],
    thinking: [],
    tools: [],
    todos: [],
    queuedMessages: [],
    commands: [],
    backgroundAgents: [],
    backgroundApprovals: [],
    mcpServers: [],
  };
}

export function reduceStandaloneSessionProjection(
  state: StandaloneSessionProjection,
  action: StandaloneSessionProjectionAction,
): StandaloneSessionProjection {
  const nextRevision = state.revision + 1;
  switch (action.type) {
    case "session.selected":
      return {
        ...initialStandaloneSessionProjection(state.projectRoot),
        revision: nextRevision,
        sessionId: action.sessionId,
        phase: "idle",
        transcript: action.messages
          ? projectHydratedTranscript(
              action.sessionId,
              action.messages,
              action.activeTurnId,
            )
          : [],
        model: action.model,
        reasoningEffort: action.reasoningEffort,
        todos: action.todos ? [...action.todos] : [],
        usage: action.usage,
        pendingInteraction: undefined,
        error: undefined,
      };
    case "session.new":
      return {
        ...initialStandaloneSessionProjection(state.projectRoot),
        revision: nextRevision,
        sessionId: action.sessionId,
        phase: "idle",
      };
    case "session.recovered":
      return {
        ...state,
        revision: nextRevision,
        phase: "idle",
        pendingInteraction: undefined,
      };
    case "user.submitted":
      return {
        ...state,
        revision: nextRevision,
        phase: "running",
        error: undefined,
        lastResult: undefined,
        transcript: [
          ...state.transcript.map((message) =>
            message.streaming ? { ...message, streaming: false } : message,
          ),
          {
            id: `${state.sessionId ?? "session"}:user:${nextRevision}`,
            role: "user",
            text: action.text,
            streaming: false,
            attachments: action.attachments,
          },
        ],
      };
    case "turn.event":
      return reduceTurnEvent(state, action.event, nextRevision);
    case "turn.result":
      return {
        ...state,
        revision: nextRevision,
        phase: phaseForResult(action.result),
        pendingInteraction:
          action.result.status === "suspended"
            ? action.result.interaction
            : undefined,
        lastResult: action.result,
        error:
          action.result.status === "failed"
            ? action.result.error.message
            : undefined,
        transcript: state.transcript.map((message) =>
          message.streaming ? { ...message, streaming: false } : message,
        ),
        thinking: state.thinking.map((item) =>
          item.status === "running" ? { ...item, status: "completed" } : item,
        ),
      };
    case "turn.cancelling":
      return { ...state, revision: nextRevision, phase: "cancelling" };
    case "session.cancelled":
      return {
        ...state,
        revision: nextRevision,
        phase: "idle",
        pendingInteraction: undefined,
        transcript: state.transcript.map((message) =>
          message.streaming ? { ...message, streaming: false } : message,
        ),
        thinking: state.thinking.map((item) =>
          item.status === "running" ? { ...item, status: "completed" } : item,
        ),
      };
    case "interaction.restored":
      return {
        ...state,
        revision: nextRevision,
        phase: "awaiting_approval",
        pendingInteraction: action.interaction,
      };
    case "activity.refreshed":
      return {
        ...state,
        revision: nextRevision,
        commands: [...action.commands],
        backgroundAgents: [...action.backgroundAgents],
        backgroundApprovals: [...action.backgroundApprovals],
      };
    case "mcp.refreshed":
      return {
        ...state,
        revision: nextRevision,
        mcpServers: [...action.servers],
      };
    case "session.settings":
      return {
        ...state,
        revision: nextRevision,
        model: action.model,
        reasoningEffort: action.reasoningEffort,
      };
    case "todos.refreshed":
      return { ...state, revision: nextRevision, todos: [...action.todos] };
    case "controller.failed":
      return {
        ...state,
        revision: nextRevision,
        phase: "failed",
        error: action.error,
      };
    case "controller.closed":
      return { ...state, revision: nextRevision, phase: "closed" };
  }
}

function reduceTurnEvent(
  state: StandaloneSessionProjection,
  event: AgentTurnEvent,
  revision: number,
): StandaloneSessionProjection {
  switch (event.type) {
    case "turn.started":
      return {
        ...state,
        revision,
        phase: "running",
        transcript: associateLatestUserWithTurn(state.transcript, event.turnId),
      };
    case "model.resolved":
      return {
        ...state,
        revision,
        model: event.provenance.resolvedModel.model,
      };
    case "thinking.started":
      return {
        ...state,
        revision,
        thinking: upsertThinking(state.thinking, {
          thinkingId: event.thinkingId,
          turnId: event.turnId,
          sequence: event.sequence,
          text: "",
          status: "running",
        }),
      };
    case "thinking.delta": {
      const existing = state.thinking.find(
        (item) => item.thinkingId === event.thinkingId,
      );
      return {
        ...state,
        revision,
        thinking: upsertThinking(state.thinking, {
          thinkingId: event.thinkingId,
          turnId: event.turnId,
          sequence: existing?.sequence ?? event.sequence,
          text: `${existing?.text ?? ""}${event.text}`,
          status: "running",
        }),
      };
    }
    case "thinking.completed": {
      const existing = state.thinking.find(
        (item) => item.thinkingId === event.thinkingId,
      );
      return {
        ...state,
        revision,
        thinking: upsertThinking(state.thinking, {
          thinkingId: event.thinkingId,
          turnId: event.turnId,
          sequence: existing?.sequence ?? event.sequence,
          text: existing?.text ?? "",
          status: "completed",
        }),
      };
    }
    case "text.delta":
      return {
        ...state,
        revision,
        transcript: appendAssistantDelta(state.transcript, event),
      };
    case "tool.requested":
      return {
        ...state,
        revision,
        tools: upsertTool(state.tools, {
          toolCallId: event.toolCallId,
          turnId: event.turnId,
          sequence: event.sequence,
          toolName: event.toolName,
          effect: event.effect,
          status: "requested",
          displayInput: event.displayInput,
        }),
      };
    case "tool.started": {
      const existing = state.tools.find(
        (tool) => tool.toolCallId === event.toolCallId,
      );
      return {
        ...state,
        revision,
        tools: upsertTool(state.tools, {
          toolCallId: event.toolCallId,
          turnId: event.turnId,
          sequence: existing?.sequence ?? event.sequence,
          toolName: event.toolName,
          effect: event.effect,
          status: "running",
        }),
      };
    }
    case "tool.completed": {
      const existing = state.tools.find(
        (tool) => tool.toolCallId === event.toolCallId,
      );
      return {
        ...state,
        revision,
        tools: upsertTool(state.tools, {
          toolCallId: event.toolCallId,
          turnId: event.turnId,
          sequence: existing?.sequence ?? event.sequence,
          toolName: event.toolName,
          effect: event.effect,
          status: "completed",
          displayContent: event.displayContent,
        }),
      };
    }
    case "tool.failed": {
      const existing = state.tools.find(
        (tool) => tool.toolCallId === event.toolCallId,
      );
      return {
        ...state,
        revision,
        tools: upsertTool(state.tools, {
          toolCallId: event.toolCallId,
          turnId: event.turnId,
          sequence: existing?.sequence ?? event.sequence,
          toolName: event.toolName,
          effect: event.effect,
          status: "failed",
          error: event.error.message,
        }),
      };
    }
    case "interaction.required":
      return {
        ...state,
        revision,
        phase: "awaiting_approval",
        pendingInteraction: event.interaction,
      };
    case "interaction.resumed":
      return {
        ...state,
        revision,
        phase: "running",
        pendingInteraction: undefined,
        transcript: associateLatestUserWithTurn(state.transcript, event.turnId),
      };
    case "usage.updated":
      return { ...state, revision, usage: event.usage };
    case "execution.updated":
      return { ...state, revision, execution: event.event.snapshot };
    case "turn.completed":
    case "turn.cancelled":
    case "turn.failed":
    case "turn.suspended":
      // The controller applies the host's returned terminal result exactly once.
      // Keep the terminal event observable to subscribers without duplicating state.
      return { ...state, revision };
  }
}

function associateLatestUserWithTurn(
  transcript: readonly StandaloneTranscriptMessage[],
  turnId: string,
): readonly StandaloneTranscriptMessage[] {
  let index = -1;
  for (let candidate = transcript.length - 1; candidate >= 0; candidate -= 1) {
    const message = transcript[candidate];
    if (message?.role === "user" && message.turnId === undefined) {
      index = candidate;
      break;
    }
  }
  if (index < 0) return transcript;
  return [
    ...transcript.slice(0, index),
    { ...transcript[index]!, turnId },
    ...transcript.slice(index + 1),
  ];
}

function appendAssistantDelta(
  transcript: readonly StandaloneTranscriptMessage[],
  event: Extract<AgentTurnEvent, { type: "text.delta" }>,
): readonly StandaloneTranscriptMessage[] {
  const index = transcript.findIndex(
    (message) =>
      message.role === "assistant" && message.turnId === event.turnId,
  );
  if (index >= 0) {
    const existing = transcript[index]!;
    return [
      ...transcript.slice(0, index),
      { ...existing, text: `${existing.text}${event.text}`, streaming: true },
      ...transcript.slice(index + 1),
    ];
  }
  return [
    ...transcript,
    {
      id: `${event.sessionId}:assistant:${event.turnId}:${event.sequence}`,
      role: "assistant",
      text: event.text,
      turnId: event.turnId,
      streaming: true,
    },
  ];
}

function upsertThinking(
  thinking: readonly StandaloneThinkingActivity[],
  item: StandaloneThinkingActivity,
): readonly StandaloneThinkingActivity[] {
  const index = thinking.findIndex(
    (candidate) => candidate.thinkingId === item.thinkingId,
  );
  if (index < 0) return [...thinking, item];
  return [...thinking.slice(0, index), item, ...thinking.slice(index + 1)];
}

function upsertTool(
  tools: readonly StandaloneToolActivity[],
  tool: StandaloneToolActivity,
): readonly StandaloneToolActivity[] {
  const index = tools.findIndex(
    (candidate) => candidate.toolCallId === tool.toolCallId,
  );
  if (index < 0) return [...tools, tool];
  const existing = tools[index]!;
  return [
    ...tools.slice(0, index),
    { ...existing, ...tool },
    ...tools.slice(index + 1),
  ];
}

function projectHydratedTranscript(
  sessionId: string,
  messages: readonly CoreModelMessage[],
  activeTurnId?: string,
): readonly StandaloneTranscriptMessage[] {
  const projected: StandaloneTranscriptMessage[] = [];
  for (const [index, message] of messages.entries()) {
    const text =
      typeof message.content === "string"
        ? message.content
        : message.content
            .filter(
              (
                block,
              ): block is Extract<
                (typeof message.content)[number],
                { type: "text" }
              > => block.type === "text",
            )
            .map((block) => block.text)
            .join("\n");
    if (!text) continue;
    projected.push({
      id: `${sessionId}:history:${index}`,
      role: message.role,
      text,
      streaming: false,
    });
  }
  return activeTurnId
    ? associateLatestUserWithTurn(projected, activeTurnId)
    : projected;
}

function phaseForResult(result: AgentTurnResult): StandaloneSessionPhase {
  if (result.status === "suspended") return "awaiting_approval";
  if (result.status === "failed") return "failed";
  return "idle";
}
